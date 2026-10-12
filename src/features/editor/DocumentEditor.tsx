import { useEffect, useRef, useState, type RefObject } from 'react';

import type { CropRegion, EditRecipe, FilterMode, RenderedVariant } from '../../domain/document';
import type { ScannerEngine } from '../../imaging/contracts/scanner-engine';
import { createScanicClassicalEngine } from '../../imaging/engines/scanic-classical-engine';
import type { ImportedImage } from '../camera/image-import';
import { createImagePdf } from '../export/image-pdf';
import {
  createImageAssetFrameSource,
  type ImageAssetFrameSource,
} from '../scanner/image-asset-frame-source';
import { detectDocumentCrop } from './detect-document-crop';

interface FilterOption {
  readonly mode: FilterMode;
  readonly label: string;
  readonly description: string;
}

const FILTERS: readonly FilterOption[] = [
  { mode: 'original', label: 'Gốc', description: 'Chỉ cắt và làm thẳng' },
  { mode: 'ocr-color', label: 'Tự động', description: 'Làm đều nền, giữ màu' },
  { mode: 'grayscale', label: 'Xám', description: 'Nền trung tính, chữ rõ' },
  { mode: 'black-and-white', label: 'Đen trắng', description: 'Tách chữ khỏi nền' },
];

type EditorStatus =
  | { readonly kind: 'preparing' }
  | { readonly kind: 'ready'; readonly label: string }
  | { readonly kind: 'processing'; readonly label: string }
  | { readonly kind: 'error' };

interface DocumentEditorProps {
  readonly image: ImportedImage;
  readonly onBack: () => void;
  readonly headingRef: RefObject<HTMLHeadingElement | null> | null;
  readonly engineFactory?: () => ScannerEngine;
  readonly frameSource?: ImageAssetFrameSource;
  readonly onVariantReady?: (variant: RenderedVariant) => void;
  readonly pdfExporter?: typeof createImagePdf;
  readonly download?: (blob: Blob, filename: string) => void;
}

function recipe(crop: CropRegion, mode: FilterMode): EditRecipe {
  return {
    version: 1,
    crop,
    rotation: 0,
    dewarp: { mode: 'perspective-only' },
    filter: { mode, presetVersion: `${mode}-v1`, parameters: {} },
  };
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

export function DocumentEditor({
  image,
  onBack,
  headingRef,
  engineFactory = createScanicClassicalEngine,
  frameSource,
  onVariantReady,
  pdfExporter = createImagePdf,
  download = downloadBlob,
}: DocumentEditorProps) {
  const [mode, setMode] = useState<FilterMode>('ocr-color');
  const [status, setStatus] = useState<EditorStatus>({ kind: 'preparing' });
  const [cropKind, setCropKind] = useState<CropRegion['kind'] | null>(null);
  const [processedUrl, setProcessedUrl] = useState<string | null>(null);
  const [latestVariant, setLatestVariant] = useState<RenderedVariant | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);
  const [originalUrl] = useState(() => URL.createObjectURL(image.original.blob));
  const [detectionSource] = useState(() => frameSource ?? createImageAssetFrameSource());
  const engine = useRef<ScannerEngine | null>(null);
  const activeOperation = useRef<AbortController | null>(null);
  const exportOperation = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const ready = useRef(false);
  const crop = useRef<CropRegion>({ kind: 'full-frame' });
  const processedUrlRef = useRef<string | null>(null);
  const onVariantReadyRef = useRef(onVariantReady);

  useEffect(() => {
    onVariantReadyRef.current = onVariantReady;
  }, [onVariantReady]);

  const showVariant = (variant: RenderedVariant) => {
    if (processedUrlRef.current !== null) URL.revokeObjectURL(processedUrlRef.current);
    const next = URL.createObjectURL(variant.image.blob);
    processedUrlRef.current = next;
    setProcessedUrl(next);
    setLatestVariant(variant);
    onVariantReadyRef.current?.(variant);
  };

  useEffect(() => {
    mounted.current = true;
    const localEngine = engineFactory();
    const controller = new AbortController();
    engine.current = localEngine;
    activeOperation.current = controller;
    void (async () => {
      try {
        await localEngine.initialize(controller.signal);
        const detectedCrop =
          image.captureCrop ??
          (await detectDocumentCrop(
            localEngine,
            detectionSource,
            image.original,
            controller.signal,
          ));
        crop.current = detectedCrop;
        const variant = await localEngine.render(
          {
            original: image.original,
            orientation: 0,
            recipe: recipe(detectedCrop, 'ocr-color'),
          },
          controller.signal,
        );
        if (!mounted.current || activeOperation.current !== controller) return;
        ready.current = true;
        setCropKind(detectedCrop.kind);
        setMode('ocr-color');
        showVariant(variant);
        setStatus({ kind: 'ready', label: 'Tự động' });
      } catch (error) {
        if (mounted.current && activeOperation.current === controller && !isAbort(error)) {
          setStatus({ kind: 'error' });
        }
      } finally {
        if (activeOperation.current === controller) activeOperation.current = null;
      }
    })();
    return () => {
      mounted.current = false;
      activeOperation.current?.abort();
      exportOperation.current?.abort();
      activeOperation.current = null;
      exportOperation.current = null;
      ready.current = false;
      URL.revokeObjectURL(originalUrl);
      if (processedUrlRef.current !== null) URL.revokeObjectURL(processedUrlRef.current);
      processedUrlRef.current = null;
      void localEngine.dispose().catch(() => undefined);
      engine.current = null;
    };
  }, [detectionSource, engineFactory, image.captureCrop, image.original, originalUrl]);

  const chooseFilter = async (option: FilterOption) => {
    const localEngine = engine.current;
    if (!ready.current || localEngine === null || status.kind === 'processing') return;
    const controller = new AbortController();
    activeOperation.current?.abort();
    activeOperation.current = controller;
    setStatus({ kind: 'processing', label: option.label });
    try {
      const variant = await localEngine.render(
        { original: image.original, orientation: 0, recipe: recipe(crop.current, option.mode) },
        controller.signal,
      );
      if (!mounted.current || activeOperation.current !== controller) return;
      showVariant(variant);
      setMode(option.mode);
      setStatus({ kind: 'ready', label: option.label });
    } catch (error) {
      if (mounted.current && activeOperation.current === controller && !isAbort(error)) {
        setStatus({ kind: 'error' });
      }
    } finally {
      if (activeOperation.current === controller) activeOperation.current = null;
    }
  };

  const exportPdf = async () => {
    if (latestVariant === null || exporting) return;
    const controller = new AbortController();
    exportOperation.current?.abort();
    exportOperation.current = controller;
    setExportFailed(false);
    setExporting(true);
    try {
      const pdf = await pdfExporter([latestVariant.image], controller.signal);
      if (!mounted.current || exportOperation.current !== controller) return;
      download(pdf, 'clonecamscanner.pdf');
    } catch (error) {
      if (mounted.current && exportOperation.current === controller && !isAbort(error)) {
        setExportFailed(true);
      }
    } finally {
      if (mounted.current) setExporting(false);
      if (exportOperation.current === controller) exportOperation.current = null;
    }
  };

  const busy = status.kind === 'preparing' || status.kind === 'processing' || exporting;

  return (
    <main id="main-content" className="app-main editor" aria-label="Chỉnh chất lượng tài liệu">
      <button className="back-button" type="button" onClick={onBack} aria-label="Quay lại chọn ảnh">
        <span aria-hidden="true">←</span>
        Chụp lại
      </button>

      <section className="editor__content" aria-labelledby="editor-title">
        <header className="editor__heading">
          <p className="eyebrow">Scanic · xử lý trên thiết bị</p>
          <h1 id="editor-title" ref={headingRef} tabIndex={-1}>
            Chỉnh chất lượng trang
          </h1>
          <p>Ảnh gốc luôn được giữ nguyên; bạn có thể đổi bộ lọc bất cứ lúc nào.</p>
        </header>

        <figure className="editor__preview" aria-busy={busy}>
          <img src={processedUrl ?? originalUrl} alt="Bản xem trước tài liệu" />
          {busy ? <span className="editor__busy">Đang xử lý…</span> : null}
        </figure>

        {cropKind === null ? null : (
          <p className="editor__crop-status">
            {cropKind === 'document'
              ? 'Đã nhận diện, cắt và làm thẳng tài liệu.'
              : 'Scanic chưa đủ chắc chắn nên giữ toàn bộ ảnh.'}
          </p>
        )}

        <div className="editor__filters" role="group" aria-label="Bộ lọc tài liệu">
          {FILTERS.map((option) => (
            <button
              key={option.mode}
              type="button"
              aria-label={option.label}
              aria-pressed={mode === option.mode}
              disabled={busy}
              onClick={() => void chooseFilter(option)}
            >
              <strong>{option.label}</strong>
              <span>{option.description}</span>
            </button>
          ))}
        </div>

        {status.kind === 'error' ? (
          <p className="editor__error" role="alert">
            Không thể xử lý ảnh. Ảnh gốc vẫn an toàn; hãy chụp lại hoặc chọn ảnh khác.
          </p>
        ) : (
          <p className="editor__status" role="status" aria-live="polite">
            {status.kind === 'preparing'
              ? 'Đang nhận diện và làm thẳng tài liệu…'
              : status.kind === 'processing'
                ? `Đang áp dụng ${status.label}…`
                : `Đã áp dụng ${status.label}`}
          </p>
        )}

        {exportFailed ? (
          <p className="editor__error" role="alert">
            Không thể tạo PDF. Trang đã xử lý vẫn còn và bạn có thể thử lại.
          </p>
        ) : null}
        <button
          className="primary-button editor__export"
          type="button"
          aria-label="Tải PDF"
          aria-busy={exporting}
          disabled={busy || latestVariant === null}
          onClick={() => void exportPdf()}
        >
          {exporting ? 'Đang tạo PDF…' : 'Tải PDF'}
        </button>
      </section>
    </main>
  );
}
