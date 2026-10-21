import { useEffect, useReducer, useRef, useState } from 'react';

import type { EditRecipe } from '../domain/document';
import { CameraScreen } from '../features/camera/CameraScreen';
import type { CameraCapture } from '../features/camera/camera-capture';
import { createCameraService, type CameraService } from '../features/camera/camera-service';
import {
  ImageImportError,
  importImage,
  type ImageImporter,
  type ImageImportFailureCode,
  type ImportedImage,
} from '../features/camera/image-import';
import { DocumentEditor } from '../features/editor/DocumentEditor';
import {
  createBackgroundPageProcessor,
  type BackgroundPageProcessor,
  type ProcessedScanPage,
  type ScanPageSource,
} from '../features/scanner/background-page-processor';
import type { LiveDetectionResult } from '../features/scanner/detection-scheduler';
import type { ImageAssetFrameSource } from '../features/scanner/image-asset-frame-source';
import { ScanBatchReview } from '../features/scanner/ScanBatchReview';
import { scanBatchReducer, scanBatchStatus } from '../features/scanner/scan-batch';
import type { VideoFrameSource } from '../features/scanner/video-frame-source';
import type { ScannerEngine } from '../imaging/contracts/scanner-engine';
import { createScanicEngine } from '../imaging/engines/scanic-classical-engine';
import { restoreProcessedPage } from '../imaging/restoration/local-page-restoration';
import {
  createLocalRestorationClient,
  type LocalRestorationClient,
} from '../imaging/restoration/local-restoration-client';

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
  readonly restorationClient?: LocalRestorationClient | null;
}

type AppView = 'library' | 'camera' | 'batch-review' | 'editor';
type CameraReturnView = Extract<AppView, 'library' | 'batch-review'>;
type HomeImportState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'importing' }
  | { readonly kind: 'error'; readonly code: ImageImportFailureCode };

const EMPTY_LIBRARY: LibraryState = { kind: 'empty' };
const HOME_IMPORT_ERROR_GUIDANCE: Readonly<Record<ImageImportFailureCode, string>> = {
  'unsupported-type': 'Chỉ hỗ trợ ảnh JPEG, PNG hoặc WebP.',
  'too-large': 'Tệp ảnh vượt quá giới hạn 64 MiB.',
  'invalid-file': 'Tệp không phải là ảnh JPEG, PNG hoặc WebP hợp lệ.',
  'image-too-large': 'Ảnh có kích thước quá lớn để xử lý an toàn trên thiết bị này.',
  'decode-failed': 'Trình duyệt không thể đọc ảnh này. Hãy chọn ảnh khác.',
  unavailable: 'Trình duyệt này chưa hỗ trợ đọc ảnh từ thư viện.',
};

function PrivacyNotice() {
  return (
    <aside className="privacy-notice" aria-label="Quyền riêng tư">
      <span className="privacy-notice__icon" aria-hidden="true">
        ✓
      </span>
      <div>
        <strong>Xử lý ngay trên thiết bị</strong>
        <span>
          Ảnh không được tải lên máy chủ. Classifier và model phục hồi chạy trong trình duyệt.
        </span>
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
  restorationClient,
}: AppProps) {
  const [view, setView] = useState<AppView>('library');
  const [cameraReturnView, setCameraReturnView] = useState<CameraReturnView>('library');
  const [homeImportState, setHomeImportState] = useState<HomeImportState>({ kind: 'idle' });
  const [editorImage, setEditorImage] = useState<ImportedImage | null>(null);
  const [replacementPageId, setReplacementPageId] = useState<string | null>(null);
  const [batch, dispatchBatch] = useReducer(scanBatchReducer, { pages: [] });
  const [resolvedCameraService] = useState(() => cameraService ?? createCameraService());
  const restorationClientRef = useRef<LocalRestorationClient | null>(null);
  const viewHeadingRef = useRef<HTMLHeadingElement>(null);
  const shouldMoveFocus = useRef(false);
  const pageProcessor = useRef<BackgroundPageProcessor | null>(null);
  const pageOperations = useRef(new Map<string, AbortController>());
  const homeImportRequest = useRef<AbortController | null>(null);
  const pageSequence = useRef(0);
  const editorEngine = useRef<ScannerEngine | null>(null);
  const editorEngineInitialization = useRef<Promise<ScannerEngine> | null>(null);
  const editorEngineLifetime = useRef<AbortController | null>(null);

  useEffect(() => {
    if (restorationClient !== undefined) {
      restorationClientRef.current = restorationClient;
      return () => {
        restorationClientRef.current = null;
      };
    }
    if (typeof Worker !== 'function') return;
    const client = createLocalRestorationClient();
    restorationClientRef.current = client;
    return () => {
      if (restorationClientRef.current === client) restorationClientRef.current = null;
      client.dispose?.();
    };
  }, [restorationClient]);

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
      homeImportRequest.current?.abort();
      homeImportRequest.current = null;
      void processor.dispose().catch(() => undefined);
    };
  }, [editorEngineFactory, imageImporter, pageProcessorFactory]);

  useEffect(
    () => () => {
      editorEngineLifetime.current?.abort();
      editorEngineLifetime.current = null;
      editorEngineInitialization.current = null;
      const current = editorEngine.current;
      editorEngine.current = null;
      void current?.dispose().catch(() => undefined);
    },
    [editorEngineFactory],
  );

  useEffect(() => {
    if (view === 'camera') restorationClientRef.current?.warmup?.();
  }, [view]);

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

  const readyEditorEngine = (): Promise<ScannerEngine> => {
    const pending = editorEngineInitialization.current;
    if (pending !== null) return pending;

    const engine = (editorEngineFactory ?? createScanicEngine)();
    const lifetime = new AbortController();
    editorEngine.current = engine;
    editorEngineLifetime.current = lifetime;
    const initialization = engine.initialize(lifetime.signal).then(
      () => engine,
      async (error: unknown) => {
        if (editorEngine.current === engine) {
          editorEngine.current = null;
          editorEngineInitialization.current = null;
          editorEngineLifetime.current = null;
        }
        await engine.dispose().catch(() => undefined);
        throw error;
      },
    );
    editorEngineInitialization.current = initialization;
    return initialization;
  };

  const processPage = (
    id: string,
    source: ScanPageSource,
    liveDetection: LiveDetectionResult | null = null,
  ) => {
    const processor = pageProcessor.current;
    if (processor === null) {
      dispatchBatch({ type: 'failed', id });
      return;
    }
    const controller = new AbortController();
    pageOperations.current.get(id)?.abort();
    pageOperations.current.set(id, controller);
    void processor
      .enqueue(
        source,
        controller.signal,
        () => {
          dispatchBatch({ type: 'started', id });
        },
        liveDetection,
      )
      .then(async (page) => {
        const resolvedRestorationClient = restorationClientRef.current;
        const shouldRestore = resolvedRestorationClient !== null;
        const readyPage: ProcessedScanPage = shouldRestore
          ? { ...page, restoration: { kind: 'processing' } }
          : page;
        dispatchBatch({ type: 'ready', id, page: readyPage });
        if (!shouldRestore || pageOperations.current.get(id) !== controller) return;
        try {
          const restored = await restoreProcessedPage(
            readyPage,
            resolvedRestorationClient,
            controller.signal,
          );
          if (pageOperations.current.get(id) === controller) {
            dispatchBatch({ type: 'updated', id, page: restored });
          }
        } catch (error) {
          if (
            pageOperations.current.get(id) !== controller ||
            (error instanceof Error && error.name === 'AbortError')
          ) {
            return;
          }
          const reason =
            error instanceof Error && error.message.includes('unavailable')
              ? 'unavailable'
              : 'failed';
          dispatchBatch({
            type: 'updated',
            id,
            page: { ...readyPage, restoration: { kind: 'fallback', reason } },
          });
        }
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

  const resetBatch = () => {
    for (const operation of pageOperations.current.values()) operation.abort();
    pageOperations.current.clear();
    dispatchBatch({ type: 'reset' });
    setReplacementPageId(null);
    setEditorImage(null);
  };

  const applyBatchRecipe = async (id: string, recipe: EditRecipe): Promise<void> => {
    const selected = batch.pages.find((page) => page.id === id);
    if (selected?.kind !== 'ready') throw new Error('Page is not ready for editing.');

    const controller = new AbortController();
    pageOperations.current.get(id)?.abort();
    pageOperations.current.set(id, controller);
    let restorationContinues = false;
    try {
      const localEngine = await readyEditorEngine();
      const variant = await localEngine.render(
        { original: selected.page.original, orientation: 0, recipe },
        controller.signal,
      );
      if (controller.signal.aborted || pageOperations.current.get(id) !== controller) {
        const error = new Error('Page edit cancelled.');
        error.name = 'AbortError';
        throw error;
      }

      const resolvedRestorationClient = restorationClientRef.current;
      const editedPage: ProcessedScanPage = {
        original: selected.page.original,
        crop: recipe.crop,
        recipe,
        variant,
        ...(resolvedRestorationClient === null
          ? {}
          : { restoration: { kind: 'processing' as const } }),
      };
      dispatchBatch({ type: 'updated', id, page: editedPage });

      if (resolvedRestorationClient !== null) {
        restorationContinues = true;
        void restoreProcessedPage(editedPage, resolvedRestorationClient, controller.signal)
          .then((restored) => {
            if (pageOperations.current.get(id) === controller) {
              dispatchBatch({ type: 'updated', id, page: restored });
            }
          })
          .catch((error: unknown) => {
            if (
              pageOperations.current.get(id) !== controller ||
              (error instanceof Error && error.name === 'AbortError')
            ) {
              return;
            }
            const reason =
              error instanceof Error && error.message.includes('unavailable')
                ? 'unavailable'
                : 'failed';
            dispatchBatch({
              type: 'updated',
              id,
              page: { ...editedPage, restoration: { kind: 'fallback', reason } },
            });
          })
          .finally(() => {
            if (pageOperations.current.get(id) === controller) pageOperations.current.delete(id);
          });
      }
    } finally {
      if (!restorationContinues && pageOperations.current.get(id) === controller) {
        pageOperations.current.delete(id);
      }
    }
  };

  const startNewCameraBatch = () => {
    homeImportRequest.current?.abort();
    homeImportRequest.current = null;
    setHomeImportState({ kind: 'idle' });
    resetBatch();
    setCameraReturnView('library');
    navigateTo('camera');
  };

  const openHomeImage = async (source: Blob) => {
    homeImportRequest.current?.abort();
    const controller = new AbortController();
    homeImportRequest.current = controller;
    setHomeImportState({ kind: 'importing' });
    try {
      const image = await (imageImporter ?? importImage)(source, controller.signal);
      if (homeImportRequest.current !== controller) return;
      resetBatch();
      setEditorImage(image);
      setHomeImportState({ kind: 'idle' });
      navigateTo('editor');
    } catch (error) {
      if (homeImportRequest.current !== controller) return;
      if (error instanceof Error && error.name === 'AbortError') {
        setHomeImportState({ kind: 'idle' });
      } else {
        setHomeImportState({
          kind: 'error',
          code: error instanceof ImageImportError ? error.code : 'decode-failed',
        });
      }
    } finally {
      if (homeImportRequest.current === controller) homeImportRequest.current = null;
    }
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
          AI cục bộ
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
            <div className="home-scan-actions" role="group" aria-label="Chọn cách quét tài liệu">
              <button
                className="primary-action"
                type="button"
                onClick={startNewCameraBatch}
                aria-label="Quét bằng camera"
              >
                <span className="primary-action__icon" aria-hidden="true">
                  <i />
                </span>
                <span>
                  <strong>Quét bằng camera</strong>
                  <small>Chụp liên tục nhiều trang</small>
                </span>
                <span className="primary-action__arrow" aria-hidden="true">
                  →
                </span>
              </button>
              <label
                className={`home-import-action${homeImportState.kind === 'importing' ? ' home-import-action--disabled' : ''}`}
                aria-busy={homeImportState.kind === 'importing'}
              >
                <span className="home-import-action__icon" aria-hidden="true">
                  ▧
                </span>
                <span>
                  <strong>
                    {homeImportState.kind === 'importing'
                      ? 'Đang kiểm tra ảnh…'
                      : 'Dùng ảnh có sẵn'}
                  </strong>
                  <small>Chọn JPEG, PNG hoặc WebP trên thiết bị</small>
                </span>
                <span className="primary-action__arrow" aria-hidden="true">
                  →
                </span>
                <input
                  className="visually-hidden"
                  aria-label="Dùng ảnh có sẵn"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={homeImportState.kind === 'importing'}
                  onChange={(event) => {
                    const source = event.currentTarget.files?.[0];
                    event.currentTarget.value = '';
                    if (source !== undefined) void openHomeImage(source);
                  }}
                />
              </label>
            </div>
            {homeImportState.kind === 'error' ? (
              <p className="home-import-error" role="alert">
                {HOME_IMPORT_ERROR_GUIDANCE[homeImportState.code]}
              </p>
            ) : null}
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
      ) : view === 'camera' ? (
        <CameraScreen
          service={resolvedCameraService}
          headingRef={viewHeadingRef}
          {...(cameraCapture === undefined ? {} : { cameraCapture })}
          {...(cameraEngineFactory === undefined ? {} : { engineFactory: cameraEngineFactory })}
          {...(cameraFrameSourceFactory === undefined
            ? {}
            : { frameSourceFactory: cameraFrameSourceFactory })}
          batchStatus={scanBatchStatus(batch)}
          title={
            replacementPageId === null
              ? 'Quét tài liệu'
              : `Chụp lại trang ${String(
                  batch.pages.findIndex((page) => page.id === replacementPageId) + 1,
                )}`
          }
          onPhotoCaptured={(source, liveDetection) => {
            const nextId = `page-${String(++pageSequence.current)}`;
            if (replacementPageId === null) {
              dispatchBatch({ type: 'captured', id: nextId, source });
              processPage(nextId, source, liveDetection);
              return;
            }

            pageOperations.current.get(replacementPageId)?.abort();
            pageOperations.current.delete(replacementPageId);
            dispatchBatch({
              type: 'replaced',
              id: replacementPageId,
              replacementId: nextId,
              source,
            });
            setReplacementPageId(null);
            processPage(nextId, source, liveDetection);
            navigateTo('batch-review');
          }}
          {...(replacementPageId === null
            ? {
                onFinishCapture: () => {
                  navigateTo('batch-review');
                },
              }
            : {})}
          onBack={() => {
            setReplacementPageId(null);
            navigateTo(cameraReturnView);
          }}
        />
      ) : view === 'batch-review' ? (
        <ScanBatchReview
          pages={batch.pages}
          headingRef={viewHeadingRef}
          onCaptureMore={() => {
            setCameraReturnView('batch-review');
            navigateTo('camera');
          }}
          onApplyRecipe={applyBatchRecipe}
          onRetakePage={(id) => {
            const selected = batch.pages.find((page) => page.id === id);
            if (
              selected === undefined ||
              selected.kind === 'queued' ||
              selected.kind === 'processing'
            ) {
              return;
            }
            setReplacementPageId(id);
            setCameraReturnView('batch-review');
            navigateTo('camera');
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
            navigateTo('library');
          }}
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
