import { renderAnalyzedPage } from '../../imaging/restoration/analyzed-page-renderer';
import { shadowFallbackMessage } from './shadow-status';
import type {
  LocalRestorationAnalysis,
  LocalRestorationClient,
} from '../../imaging/restoration/local-restoration-client';
import { useEffect, useRef, useState, type RefObject } from 'react';

import type { CropRegion, EditRecipe, FilterMode, RenderedVariant } from '../../domain/document';
import type { ScannerEngine } from '../../imaging/contracts/scanner-engine';
import { createScanicEngine } from '../../imaging/engines/scanic-classical-engine';
import type { ImportedImage } from '../camera/image-import';
import { downloadBlob } from '../export/download-blob';
import { createImagePdf } from '../export/image-pdf';
import {
  createImageAssetFrameSource,
  type ImageAssetFrameSource,
} from '../scanner/image-asset-frame-source';
import { detectDocumentCrop } from './detect-document-crop';
import {
  createDocumentRecipe,
  DEFAULT_DOCUMENT_FILTER,
  DOCUMENT_FILTERS,
  documentFilterLabel,
  type DocumentFilterOption,
} from './document-filters';

type EditorStatus =
  | { readonly kind: 'preparing' }
  | { readonly kind: 'ready'; readonly label: string }
  | { readonly kind: 'processing'; readonly label: string }
  | { readonly kind: 'error' };

interface DocumentEditorProps {
  readonly analyzer?: LocalRestorationClient;
  readonly analyzerFactory?: () => LocalRestorationClient | null;
  readonly image: ImportedImage;
  readonly initialPage?: {
    readonly variant: RenderedVariant;
    readonly recipe: EditRecipe;
  };
  readonly onBack: () => void;
  readonly headingRef: RefObject<HTMLHeadingElement | null> | null;
  readonly engineFactory?: () => ScannerEngine;
  readonly frameSource?: ImageAssetFrameSource;
  readonly onVariantReady?: (variant: RenderedVariant, recipe: EditRecipe) => void;
  readonly pdfExporter?: typeof createImagePdf;
  readonly download?: (blob: Blob, filename: string) => void;
  readonly backLabel?: string;
  readonly showExport?: boolean;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function DocumentEditor({
  analyzer,
  analyzerFactory,
  image,
  initialPage,
  onBack,
  headingRef,
  engineFactory = createScanicEngine,
  frameSource,
  onVariantReady,
  pdfExporter = createImagePdf,
  download = downloadBlob,
  backLabel = 'Chụp lại',
  showExport = true,
}: DocumentEditorProps) {
  const [initialProcessedUrl] = useState(() =>
    initialPage === undefined ? null : URL.createObjectURL(initialPage.variant.image.blob),
  );
  const [mode, setMode] = useState<FilterMode>(
    initialPage?.recipe.filter.mode ?? DEFAULT_DOCUMENT_FILTER,
  );
  const [status, setStatus] = useState<EditorStatus>(() =>
    initialPage === undefined
      ? { kind: 'preparing' }
      : { kind: 'ready', label: documentFilterLabel(initialPage.recipe.filter.mode) },
  );
  const [cropKind, setCropKind] = useState<CropRegion['kind'] | null>(
    initialPage?.recipe.crop.kind ?? null,
  );
  const [processedUrl, setProcessedUrl] = useState<string | null>(initialProcessedUrl);
  const [latestVariant, setLatestVariant] = useState<RenderedVariant | null>(
    initialPage?.variant ?? null,
  );
  const [exporting, setExporting] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);
  const [originalUrl] = useState(() =>
    initialPage === undefined
      ? URL.createObjectURL(image.preview?.blob ?? image.original.blob)
      : null,
  );
  const [detectionSource] = useState(() => frameSource ?? createImageAssetFrameSource());
  const engine = useRef<ScannerEngine | null>(null);
  const analysis = useRef<LocalRestorationAnalysis | undefined>(undefined);
  const activeOperation = useRef<AbortController | null>(null);
  const exportOperation = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const ready = useRef(false);
  const crop = useRef<CropRegion>(initialPage?.recipe.crop ?? { kind: 'full-frame' });
  const processedUrlRef = useRef<string | null>(initialProcessedUrl);
  const onVariantReadyRef = useRef(onVariantReady);

  useEffect(() => {
    onVariantReadyRef.current = onVariantReady;
  }, [onVariantReady]);

  const showVariant = (variant: RenderedVariant, appliedRecipe: EditRecipe) => {
    if (processedUrlRef.current !== null) URL.revokeObjectURL(processedUrlRef.current);
    const next = URL.createObjectURL(variant.image.blob);
    processedUrlRef.current = next;
    setProcessedUrl(next);
    setLatestVariant(variant);
    onVariantReadyRef.current?.(variant, appliedRecipe);
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
        if (initialPage !== undefined) {
          if (!mounted.current || activeOperation.current !== controller) return;
          ready.current = true;
          return;
        }
        const detectedCrop =
          image.captureCrop ??
          (await detectDocumentCrop(
            localEngine,
            detectionSource,
            image.original,
            controller.signal,
            { kind: 'full-frame' },
            undefined,
            image.preview,
          ));
        crop.current = detectedCrop;
        const initialRecipe = createDocumentRecipe(detectedCrop);
        const activeAnalyzer = analyzer ?? analyzerFactory?.() ?? undefined;
        const result = await renderAnalyzedPage(
          localEngine,
          image.original,
          initialRecipe,
          controller.signal,
          activeAnalyzer === undefined ? {} : { analyzer: activeAnalyzer },
        );
        const { variant } = result;
        analysis.current = result.analysis;
        if (!mounted.current || activeOperation.current !== controller) return;
        ready.current = true;
        setCropKind(detectedCrop.kind);
        setMode(initialRecipe.filter.mode);
        showVariant(variant, initialRecipe);
        setStatus({ kind: 'ready', label: documentFilterLabel(initialRecipe.filter.mode) });
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
      if (originalUrl !== null) URL.revokeObjectURL(originalUrl);
      if (processedUrlRef.current !== null) URL.revokeObjectURL(processedUrlRef.current);
      processedUrlRef.current = null;
      void localEngine.dispose().catch(() => undefined);
      engine.current = null;
    };
  }, [
    analyzer,
    analyzerFactory,
    detectionSource,
    engineFactory,
    image.captureCrop,
    image.original,
    image.preview,
    initialPage,
    originalUrl,
  ]);

  const chooseFilter = async (option: DocumentFilterOption) => {
    const localEngine = engine.current;
    if (!ready.current || localEngine === null || status.kind === 'processing') return;
    const controller = new AbortController();
    activeOperation.current?.abort();
    activeOperation.current = controller;
    setStatus({ kind: 'processing', label: option.label });
    try {
      const nextRecipe = createDocumentRecipe(crop.current, option.mode);
      const activeAnalyzer = analyzer ?? analyzerFactory?.() ?? undefined;
      const { variant } = await renderAnalyzedPage(
        localEngine,
        image.original,
        nextRecipe,
        controller.signal,
        {
          ...(activeAnalyzer === undefined ? {} : { analyzer: activeAnalyzer }),
          ...(analysis.current === undefined ? {} : { analysis: analysis.current }),
        },
      );
      if (!mounted.current || activeOperation.current !== controller) return;
      showVariant(variant, nextRecipe);
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
        {backLabel}
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
          <img src={processedUrl ?? originalUrl ?? ''} alt="Bản xem trước tài liệu" />
          {busy ? <span className="editor__busy">Đang xử lý…</span> : null}
        </figure>

        {cropKind === null ? null : (
          <p className="editor__crop-status">
            {cropKind === 'document'
              ? 'Đã nhận diện, cắt và làm thẳng tài liệu.'
              : 'Scanic chưa đủ chắc chắn nên giữ toàn bộ ảnh.'}
          </p>
        )}

        {latestVariant?.enhancement === 'model-unavailable' && (
          <p className="editor__status" role="status">
            {shadowFallbackMessage(latestVariant.enhancementFailure)}
          </p>
        )}
        <div className="editor__filters" role="group" aria-label="Bộ lọc tài liệu">
          {DOCUMENT_FILTERS.map((option) => (
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

        {showExport && exportFailed ? (
          <p className="editor__error" role="alert">
            Không thể tạo PDF. Trang đã xử lý vẫn còn và bạn có thể thử lại.
          </p>
        ) : null}
        {showExport ? (
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
        ) : null}
      </section>
    </main>
  );
}
