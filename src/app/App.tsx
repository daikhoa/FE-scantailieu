import { useEffect, useReducer, useRef, useState } from 'react';

import { CameraScreen } from '../features/camera/CameraScreen';
import type { CameraCapture } from '../features/camera/camera-capture';
import { createCameraService, type CameraService } from '../features/camera/camera-service';
import type { ImageImporter, ImportedImage } from '../features/camera/image-import';
import { DocumentEditor } from '../features/editor/DocumentEditor';
import {
  createBackgroundPageProcessor,
  type BackgroundPageProcessor,
} from '../features/scanner/background-page-processor';
import type { ImageAssetFrameSource } from '../features/scanner/image-asset-frame-source';
import { ScanBatchReview } from '../features/scanner/ScanBatchReview';
import { scanBatchReducer, scanBatchStatus } from '../features/scanner/scan-batch';
import type { VideoFrameSource } from '../features/scanner/video-frame-source';
import type { ScannerEngine } from '../imaging/contracts/scanner-engine';

export type LibraryState =
  | { readonly kind: 'empty' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string };

interface AppProps {
  readonly libraryState?: LibraryState;
  readonly onRetryLibrary?: () => void;
  readonly cameraService?: CameraService;
  readonly imageImporter?: ImageImporter;
  readonly editorEngineFactory?: () => ScannerEngine;
  readonly editorFrameSource?: ImageAssetFrameSource;
  readonly cameraCapture?: CameraCapture;
  readonly cameraEngineFactory?: () => ScannerEngine;
  readonly cameraFrameSourceFactory?: () => VideoFrameSource;
  readonly pageProcessorFactory?: () => BackgroundPageProcessor;
}

type AppView = 'library' | 'scan-intro' | 'batch-review' | 'editor';

const EMPTY_LIBRARY: LibraryState = { kind: 'empty' };

function PrivacyNotice() {
  return (
    <aside className="privacy-notice" aria-label="Quyền riêng tư">
      <span className="privacy-notice__icon" aria-hidden="true">
        ✓
      </span>
      <div>
        <strong>Xử lý ngay trên thiết bị</strong>
        <span>Ảnh không được tải lên máy chủ.</span>
      </div>
    </aside>
  );
}

function LibraryContent({
  state,
  onRetry,
}: {
  readonly state: LibraryState;
  readonly onRetry: (() => void) | undefined;
}) {
  if (state.kind === 'loading') {
    return (
      <div className="library-state library-state--loading" role="status" aria-live="polite">
        <div className="document-placeholder" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <p>Đang mở thư viện tài liệu…</p>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="library-state library-state--error" role="alert">
        <span className="library-state__symbol" aria-hidden="true">
          !
        </span>
        <div>
          <h3>Không thể mở thư viện</h3>
          <p>{state.message}</p>
          {onRetry === undefined ? null : (
            <button className="text-button" type="button" onClick={onRetry}>
              Thử mở lại thư viện
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="library-state library-state--empty">
      <div className="empty-document" aria-hidden="true">
        <span className="empty-document__corner empty-document__corner--top" />
        <span className="empty-document__line" />
        <span className="empty-document__line empty-document__line--short" />
        <span className="empty-document__corner empty-document__corner--bottom" />
      </div>
      <div>
        <h3>Chưa có tài liệu nào</h3>
        <p>Bản scan và ảnh gốc sẽ xuất hiện tại đây để bạn có thể tiếp tục chỉnh sửa.</p>
      </div>
    </div>
  );
}

export function App({
  libraryState = EMPTY_LIBRARY,
  onRetryLibrary,
  cameraService,
  imageImporter,
  editorEngineFactory,
  editorFrameSource,
  cameraCapture,
  cameraEngineFactory,
  cameraFrameSourceFactory,
  pageProcessorFactory,
}: AppProps) {
  const [view, setView] = useState<AppView>('library');
  const [editorImage, setEditorImage] = useState<ImportedImage | null>(null);
  const [selectedBatchPageId, setSelectedBatchPageId] = useState<string | null>(null);
  const [batch, dispatchBatch] = useReducer(scanBatchReducer, { pages: [] });
  const [resolvedCameraService] = useState(() => cameraService ?? createCameraService());
  const viewHeadingRef = useRef<HTMLHeadingElement>(null);
  const shouldMoveFocus = useRef(false);
  const pageProcessor = useRef<BackgroundPageProcessor | null>(null);
  const pageOperations = useRef(new Map<string, AbortController>());
  const pageSequence = useRef(0);

  useEffect(() => {
    const processor =
      pageProcessorFactory?.() ??
      createBackgroundPageProcessor({
        ...(imageImporter === undefined ? {} : { importer: imageImporter }),
        ...(editorEngineFactory === undefined ? {} : { engineFactory: editorEngineFactory }),
      });
    const operations = pageOperations.current;
    pageProcessor.current = processor;
    return () => {
      if (pageProcessor.current === processor) pageProcessor.current = null;
      for (const operation of operations.values()) operation.abort();
      operations.clear();
      void processor.dispose().catch(() => undefined);
    };
  }, [editorEngineFactory, imageImporter, pageProcessorFactory]);

  useEffect(() => {
    if (shouldMoveFocus.current) {
      shouldMoveFocus.current = false;
      viewHeadingRef.current?.focus();
    }
  }, [view]);

  const navigateTo = (nextView: AppView) => {
    shouldMoveFocus.current = true;
    setView(nextView);
  };

  const processPage = (id: string, source: Blob) => {
    const processor = pageProcessor.current;
    if (processor === null) {
      dispatchBatch({ type: 'failed', id });
      return;
    }
    const controller = new AbortController();
    pageOperations.current.get(id)?.abort();
    pageOperations.current.set(id, controller);
    void processor
      .enqueue(source, controller.signal, () => {
        dispatchBatch({ type: 'started', id });
      })
      .then((page) => {
        dispatchBatch({ type: 'ready', id, page });
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error && error.name === 'AbortError')) {
          dispatchBatch({ type: 'failed', id });
        }
      })
      .finally(() => {
        if (pageOperations.current.get(id) === controller) pageOperations.current.delete(id);
      });
  };

  const startNewBatch = () => {
    for (const operation of pageOperations.current.values()) operation.abort();
    pageOperations.current.clear();
    dispatchBatch({ type: 'reset' });
    setSelectedBatchPageId(null);
    setEditorImage(null);
    navigateTo('scan-intro');
  };

  const isLibrary = view === 'library';

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Chuyển đến nội dung chính
      </a>

      <header className="top-bar">
        <div className="brand" aria-label="clonecamscanner, bản dùng nội bộ">
          <span className="brand__mark" aria-hidden="true">
            <i />
          </span>
          <span className="brand__name">clonecamscanner</span>
          <span className="brand__badge">Nội bộ</span>
        </div>
        <span className="local-status">
          <span aria-hidden="true" />
          Cục bộ
        </span>
      </header>

      {isLibrary ? (
        <main id="main-content" className="app-main" aria-label="clonecamscanner">
          <section className="hero" aria-labelledby="library-page-title">
            <p className="eyebrow">Tài liệu rõ hơn · OCR chính xác hơn</p>
            <h1 id="library-page-title" ref={viewHeadingRef} tabIndex={-1}>
              Scan rõ từng nét. <span>PDF sẵn sàng cho OCR.</span>
            </h1>
            <p className="hero__description">
              Căn thẳng tài liệu, giữ nguyên tỷ lệ và tăng độ rõ mà không làm thay đổi nội dung gốc.
            </p>
            <button
              className="primary-action"
              type="button"
              onClick={startNewBatch}
              aria-label="Bắt đầu quét"
            >
              <span className="primary-action__icon" aria-hidden="true">
                <i />
              </span>
              <span>
                <strong>Bắt đầu quét</strong>
                <small>Bạn tự bấm chụp từng trang</small>
              </span>
              <span className="primary-action__arrow" aria-hidden="true">
                →
              </span>
            </button>
          </section>

          <PrivacyNotice />

          <section className="library" aria-labelledby="library-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Thư viện của bạn</p>
                <h2 id="library-title">Tài liệu gần đây</h2>
              </div>
              <span className="document-count" aria-label="Không có tài liệu">
                0 tài liệu
              </span>
            </div>
            <LibraryContent state={libraryState} onRetry={onRetryLibrary} />
          </section>
        </main>
      ) : view === 'scan-intro' ? (
        <CameraScreen
          service={resolvedCameraService}
          headingRef={viewHeadingRef}
          {...(imageImporter === undefined ? {} : { importer: imageImporter })}
          {...(cameraCapture === undefined ? {} : { cameraCapture })}
          {...(cameraEngineFactory === undefined ? {} : { engineFactory: cameraEngineFactory })}
          {...(cameraFrameSourceFactory === undefined
            ? {}
            : { frameSourceFactory: cameraFrameSourceFactory })}
          batchStatus={scanBatchStatus(batch)}
          onPhotoCaptured={(source) => {
            const id = `page-${String(++pageSequence.current)}`;
            dispatchBatch({ type: 'captured', id, source });
            processPage(id, source);
          }}
          onFinishCapture={() => {
            navigateTo('batch-review');
          }}
          onImageImported={(image) => {
            setEditorImage(image);
            setSelectedBatchPageId(null);
            navigateTo('editor');
          }}
          onBack={() => {
            navigateTo('library');
          }}
        />
      ) : view === 'batch-review' ? (
        <ScanBatchReview
          pages={batch.pages}
          headingRef={viewHeadingRef}
          onCaptureMore={() => {
            navigateTo('scan-intro');
          }}
          onEditPage={(id) => {
            const selected = batch.pages.find((page) => page.id === id);
            if (selected?.kind !== 'ready') return;
            setSelectedBatchPageId(id);
            setEditorImage({
              original: selected.page.original,
              captureCrop: selected.page.crop,
            });
            navigateTo('editor');
          }}
          onRetryPage={(id) => {
            const selected = batch.pages.find((page) => page.id === id);
            if (selected?.kind !== 'failed') return;
            dispatchBatch({ type: 'retry', id });
            processPage(id, selected.source);
          }}
          onRemovePage={(id) => {
            pageOperations.current.get(id)?.abort();
            pageOperations.current.delete(id);
            dispatchBatch({ type: 'removed', id });
          }}
        />
      ) : editorImage === null ? null : (
        <DocumentEditor
          image={editorImage}
          headingRef={viewHeadingRef}
          {...(editorEngineFactory === undefined ? {} : { engineFactory: editorEngineFactory })}
          {...(editorFrameSource === undefined ? {} : { frameSource: editorFrameSource })}
          onBack={() => {
            setEditorImage(null);
            if (selectedBatchPageId === null) {
              navigateTo('scan-intro');
            } else {
              setSelectedBatchPageId(null);
              navigateTo('batch-review');
            }
          }}
          {...(selectedBatchPageId === null
            ? {}
            : {
                backLabel: 'Tài liệu',
                showExport: false,
                onVariantReady: (variant, recipe) => {
                  const selected = batch.pages.find((page) => page.id === selectedBatchPageId);
                  if (selected?.kind !== 'ready') return;
                  dispatchBatch({
                    type: 'updated',
                    id: selectedBatchPageId,
                    page: { ...selected.page, crop: recipe.crop, recipe, variant },
                  });
                },
              })}
        />
      )}

      <footer className="app-footer">
        <span>Không tài khoản</span>
        <span aria-hidden="true">·</span>
        <span>Không cloud</span>
        <span aria-hidden="true">·</span>
        <span>PDF giữ đúng tỷ lệ</span>
      </footer>
    </div>
  );
}
