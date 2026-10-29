import { HomeScreen, type LibraryState } from './HomeScreen';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import type { EditRecipe } from '../domain/document';
import { CameraScreen } from '../features/camera/CameraScreen';
import type { CameraCapture } from '../features/camera/camera-capture';
import { createCameraService, type CameraService } from '../features/camera/camera-service';
import type { ImageImporter } from '../features/camera/image-import';
import {
  createBackgroundPageProcessor,
  type BackgroundPageProcessor,
  type ScanPageSource,
} from '../features/scanner/background-page-processor';
import type { LiveDetectionResult } from '../features/scanner/detection-scheduler';
import type { ImageAssetFrameSource } from '../features/scanner/image-asset-frame-source';
import { ScanBatchReview } from '../features/scanner/ScanBatchReview';
import { scanBatchReducer, scanBatchStatus } from '../features/scanner/scan-batch';
import type { VideoFrameSource } from '../features/scanner/video-frame-source';
import type { ScannerEngine } from '../imaging/contracts/scanner-engine';
import type { LocalRestorationClient } from '../imaging/restoration/local-restoration-client';
import type { DocumentSummary, EditableDocument } from '../features/library/document-api';
import type { ScanBatchPage } from '../features/scanner/scan-batch';
import { MAX_DOCUMENT_PAGES } from '../domain/document-limits';
import { useStoredPages } from '../features/library/useStoredPages';

export type { LibraryState } from './HomeScreen';

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
  readonly initialDocument?: EditableDocument;
  readonly onOpenDocument?: (id: string) => void;
  readonly onRenameDocument?: (
    document: DocumentSummary,
    name: string,
    signal: AbortSignal,
  ) => Promise<DocumentSummary>;
  readonly onLoadMoreLibrary?: () => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
  readonly onSaveDocument?: (
    pages: readonly ScanBatchPage[],
    pdf: Blob,
    name: string,
    existing: DocumentSummary | null,
    signal: AbortSignal,
  ) => Promise<DocumentSummary>;
}

type AppView = 'library' | 'camera' | 'batch-review';
type CameraReturnView = Extract<AppView, 'library' | 'batch-review'>;
type HomeImportState =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'error';
      readonly code: 'too-many-images' | 'selection-too-large' | 'too-many-pages';
    };

const EMPTY_LIBRARY: LibraryState = { kind: 'empty' };
const MAX_IMPORT_IMAGES = 20;
const MAX_IMPORT_SELECTION_BYTES = 256 * 1024 * 1024;
const HOME_IMPORT_ERROR_GUIDANCE: Readonly<
  Record<Extract<HomeImportState, { kind: 'error' }>['code'], string>
> = {
  'too-many-images': `Tối đa ${String(MAX_IMPORT_IMAGES)} ảnh mỗi lần. Hãy chọn ít ảnh hơn.`,
  'too-many-pages': `Mỗi tài liệu tối đa ${String(MAX_DOCUMENT_PAGES)} trang. Hãy xoá bớt trang hoặc tạo tài liệu khác.`,
  'selection-too-large': `Tổng dung lượng ảnh vượt quá ${String(MAX_IMPORT_SELECTION_BYTES / (1024 * 1024))} MiB. Hãy chọn ít ảnh hơn.`,
};

function importSelectionFailure(
  sources: readonly File[],
  currentPages = 0,
): Extract<HomeImportState, { kind: 'error' }>['code'] | null {
  if (currentPages + sources.length > MAX_DOCUMENT_PAGES) return 'too-many-pages';
  if (sources.length > MAX_IMPORT_IMAGES) return 'too-many-images';
  if (sources.reduce((total, source) => total + source.size, 0) > MAX_IMPORT_SELECTION_BYTES)
    return 'selection-too-large';
  return null;
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
  initialDocument,
  onOpenDocument,
  onRenameDocument,
  onLoadMoreLibrary,
  onDirtyChange,
  onSaveDocument,
}: AppProps) {
  const [view, setView] = useState<AppView>(initialDocument ? 'batch-review' : 'library');
  const [cameraReturnView, setCameraReturnView] = useState<CameraReturnView>('library');
  const [homeImportState, setHomeImportState] = useState<HomeImportState>({ kind: 'idle' });
  const [replacementPageId, setReplacementPageId] = useState<string | null>(null);
  const [batch, dispatchBatch] = useReducer(scanBatchReducer, {
    pages: initialDocument?.pages ?? [],
  });
  const [savedDocument, setSavedDocument] = useState<DocumentSummary | null>(
    initialDocument?.document ?? null,
  );
  const storedPages = useStoredPages(initialDocument?.storedDocument, dispatchBatch);
  const [draftName, setDraftName] = useState(initialDocument?.document.name ?? 'clonecamscanner');
  const [dirty, setDirty] = useState(false);
  const [processorGeneration, setProcessorGeneration] = useState(0);
  const [resolvedCameraService] = useState(() => cameraService ?? createCameraService());
  const restorationClientRef = useRef<LocalRestorationClient | null>(null);
  const viewHeadingRef = useRef<HTMLHeadingElement>(null);
  const shouldMoveFocus = useRef(false);
  const pageProcessor = useRef<BackgroundPageProcessor | null>(null);
  const processorRetirement = useRef<Promise<void> | null>(null);
  const pageOperations = useRef(new Map<string, AbortController>());
  const pageSequence = useRef(
    Math.max(
      0,
      ...(initialDocument?.pages ?? []).map((page) =>
        Number(/^page-(\d+)$/u.exec(page.id)?.[1] ?? 0),
      ),
    ),
  );
  const [cameraPreparation, setCameraPreparation] = useState(() => Promise.resolve());
  const cameraRetirement = useRef<Promise<void>>(Promise.resolve());
  const recordCameraRetirement = useCallback((completion: Promise<void>) => {
    cameraRetirement.current = completion;
    void completion.catch(() => undefined);
  }, []);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [dirty]);

  useEffect(() => {
    if (restorationClient !== undefined) {
      restorationClientRef.current = restorationClient;
      return () => {
        restorationClientRef.current = null;
      };
    }
    // Normal processing/model ownership belongs to the SDK; retain only an injected test adapter.
    restorationClientRef.current = null;
  }, [restorationClient]);

  useEffect(() => {
    const processor =
      pageProcessorFactory?.() ??
      createBackgroundPageProcessor({
        ...(imageImporter === undefined ? {} : { importer: imageImporter }),
        ...(editorEngineFactory === undefined ? {} : { engineFactory: editorEngineFactory }),
        ...(editorFrameSource === undefined ? {} : { frameSource: editorFrameSource }),
        ...(restorationClientRef.current === null
          ? {}
          : { restorationAnalyzer: restorationClientRef.current }),
      });
    const operations = pageOperations.current;
    pageProcessor.current = processor;
    return () => {
      if (pageProcessor.current === processor) pageProcessor.current = null;
      for (const operation of operations.values()) operation.abort();
      operations.clear();
      // A new batch must not decode images or allocate models until the old queue has retired.
      const retirement = Promise.all([processorRetirement.current, processor.dispose()])
        .then(() => undefined)
        .catch(() => undefined);
      processorRetirement.current = retirement;
      void retirement.then(() => {
        if (processorRetirement.current === retirement) processorRetirement.current = null;
      });
    };
  }, [
    editorEngineFactory,
    editorFrameSource,
    imageImporter,
    pageProcessorFactory,
    processorGeneration,
    restorationClient,
  ]);

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

  const openCamera = () => {
    // The SDK queue owns both import and editing; retire it before opening live detection.
    const preparation = Promise.all([
      pageProcessor.current?.releaseWhenIdle?.(),
      processorRetirement.current,
      cameraRetirement.current,
    ]).then(() => undefined);
    void preparation.catch(() => undefined);
    setCameraPreparation(preparation);
    navigateTo('camera');
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
    const enqueue = () => {
      if (controller.signal.aborted || pageProcessor.current !== processor)
        return Promise.reject(new DOMException('Page processing cancelled.', 'AbortError'));
      return processor.enqueue(
        source,
        controller.signal,
        () => {
          dispatchBatch({ type: 'started', id });
        },
        liveDetection,
        {
          analysisKey: id,
          onOriginal: (original) => {
            if (pageOperations.current.get(id) === controller)
              dispatchBatch({ type: 'source-saved', id, source: original.blob });
          },
        },
      );
    };
    const retirement = processorRetirement.current;
    void (retirement === null ? enqueue() : retirement.then(enqueue))
      .then((page) => {
        if (pageOperations.current.get(id) === controller)
          dispatchBatch({ type: 'ready', id, page });
      })
      .catch((error: unknown) => {
        if (
          pageOperations.current.get(id) !== controller ||
          (error instanceof Error && error.name === 'AbortError')
        )
          return;
        dispatchBatch({ type: 'failed', id });
      })
      .finally(() => {
        if (pageOperations.current.get(id) === controller) pageOperations.current.delete(id);
      });
  };

  const appendPage = (source: ScanPageSource, liveDetection: LiveDetectionResult | null = null) => {
    setDirty(true);
    const id = `page-${String(++pageSequence.current)}`;
    dispatchBatch({ type: 'captured', id, source });
    processPage(id, source, liveDetection);
  };

  const resetBatch = () => {
    storedPages.cancelAll();
    setDirty(false);
    setSavedDocument(null);
    setDraftName('clonecamscanner');
    for (const operation of pageOperations.current.values()) operation.abort();
    pageOperations.current.clear();
    dispatchBatch({ type: 'reset' });
    setReplacementPageId(null);
  };

  const applyBatchRecipe = async (id: string, recipe: EditRecipe): Promise<void> => {
    const selected = batch.pages.find((page) => page.id === id);
    if (selected?.kind !== 'ready') throw new Error('Page is not ready for editing.');

    const controller = new AbortController();
    pageOperations.current.get(id)?.abort();
    pageOperations.current.set(id, controller);
    try {
      await processorRetirement.current;
      if (pageOperations.current.get(id) !== controller)
        throw new DOMException('Page edit cancelled.', 'AbortError');
      const processor = pageProcessor.current;
      if (!processor?.render) throw new Error('Document processor unavailable.');
      const output = await processor.render(selected.page.original, recipe, controller.signal);
      if (controller.signal.aborted || pageOperations.current.get(id) !== controller) {
        const error = new Error('Page edit cancelled.');
        error.name = 'AbortError';
        throw error;
      }
      dispatchBatch({
        type: 'updated',
        id,
        page: {
          ...output,
          ...(selected.page.originalPreview === undefined
            ? {}
            : { originalPreview: selected.page.originalPreview }),
        },
      });
      setDirty(true);
    } finally {
      if (pageOperations.current.get(id) === controller) pageOperations.current.delete(id);
    }
  };

  const startNewCameraBatch = () => {
    setHomeImportState({ kind: 'idle' });
    resetBatch();
    setCameraReturnView('library');
    openCamera();
  };

  const openHomeImages = (sources: readonly File[]) => {
    if (sources.length === 0) return;
    const selectionFailure = importSelectionFailure(sources);
    if (selectionFailure !== null) {
      setHomeImportState({ kind: 'error', code: selectionFailure });
      return;
    }
    setHomeImportState({ kind: 'idle' });
    resetBatch();
    for (const source of sources) appendPage(source);
    navigateTo('batch-review');
  };

  const appendImages = (sources: readonly File[]) => {
    if (sources.length === 0) return;
    const failure = importSelectionFailure(sources, batch.pages.length);
    if (failure) {
      setHomeImportState({ kind: 'error', code: failure });
      return;
    }
    setHomeImportState({ kind: 'idle' });
    for (const source of sources) appendPage(source);
  };

  const isLibrary = view === 'library';

  return (
    <div className={`app-shell${isLibrary ? ' app-shell--home' : ''}`}>
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
        <HomeScreen
          headingRef={viewHeadingRef}
          libraryState={libraryState}
          onRetryLibrary={onRetryLibrary}
          onCamera={startNewCameraBatch}
          importError={
            homeImportState.kind === 'error'
              ? HOME_IMPORT_ERROR_GUIDANCE[homeImportState.code]
              : undefined
          }
          onImport={openHomeImages}
          {...(onOpenDocument ? { onOpenDocument } : {})}
          {...(onLoadMoreLibrary ? { onLoadMoreLibrary } : {})}
        />
      ) : view === 'camera' ? (
        <CameraScreen
          service={resolvedCameraService}
          headingRef={viewHeadingRef}
          activationReady={cameraPreparation}
          onDetectionStopped={recordCameraRetirement}
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
            if (replacementPageId === null) {
              appendPage(source, liveDetection);
              return;
            }
            const nextId = `page-${String(++pageSequence.current)}`;
            setDirty(true);

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
            if (cameraReturnView === 'library' && dirty) {
              if (!window.confirm('Tài liệu có thay đổi chưa lưu. Bạn vẫn muốn về trang chủ?'))
                return;
              resetBatch();
            }
            setReplacementPageId(null);
            navigateTo(cameraReturnView);
          }}
        />
      ) : (
        <ScanBatchReview
          pages={batch.pages}
          onImportMore={appendImages}
          {...(homeImportState.kind === 'error'
            ? { importError: HOME_IMPORT_ERROR_GUIDANCE[homeImportState.code] }
            : {})}
          headingRef={viewHeadingRef}
          documentName={draftName}
          {...(savedDocument && onRenameDocument
            ? {
                onRenameDocument: async (name: string, signal: AbortSignal) => {
                  const renamed = await onRenameDocument(savedDocument, name, signal);
                  if (!signal.aborted) {
                    setSavedDocument(renamed);
                    setDraftName(renamed.name);
                    setDirty(false);
                  }
                },
              }
            : {})}
          {...(savedDocument && !dirty
            ? {
                savedPdfUrl: `/api/v1/documents/${savedDocument.id}/pdf?revision=${String(savedDocument.revision)}`,
              }
            : {})}
          onDocumentNameChange={(name) => {
            setDraftName(name);
            setDirty(true);
          }}
          {...(onSaveDocument
            ? {
                onSaveDocument: async (pdf: Blob, name: string, signal: AbortSignal) => {
                  const document = await onSaveDocument(
                    batch.pages,
                    pdf,
                    name,
                    savedDocument,
                    signal,
                  );
                  if (!signal.aborted) {
                    setSavedDocument(document);
                    setDraftName(document.name);
                    setDirty(false);
                  }
                },
              }
            : {})}
          onBack={() => {
            if (
              dirty &&
              !window.confirm('Tài liệu có thay đổi chưa lưu. Bạn vẫn muốn về trang chủ?')
            )
              return;
            resetBatch();
            setProcessorGeneration((generation) => generation + 1);
            navigateTo('library');
          }}
          onCaptureMore={() => {
            setCameraReturnView('batch-review');
            openCamera();
          }}
          onApplyRecipe={applyBatchRecipe}
          onRetakePage={(id) => {
            const selected = batch.pages.find((page) => page.id === id);
            if (
              selected === undefined ||
              selected.kind === 'loading-saved' ||
              selected.kind === 'failed-saved' ||
              selected.kind === 'queued' ||
              selected.kind === 'processing'
            ) {
              return;
            }
            setReplacementPageId(id);
            setCameraReturnView('batch-review');
            openCamera();
          }}
          onRetryPage={(id) => {
            const selected = batch.pages.find((page) => page.id === id);
            if (selected?.kind === 'failed-saved') {
              storedPages.retry(id);
              return;
            }
            if (selected?.kind !== 'failed') return;
            dispatchBatch({ type: 'retry', id });
            processPage(id, selected.source);
          }}
          onRemovePage={(id) => {
            storedPages.cancelPage(id);
            setDirty(true);
            pageOperations.current.get(id)?.abort();
            pageOperations.current.delete(id);
            dispatchBatch({ type: 'removed', id });
          }}
        />
      )}

      {isLibrary ? null : (
        <footer className="app-footer">
          <span>Xử lý trên thiết bị</span>
          <span aria-hidden="true">·</span>
          <span>Lưu vào tài khoản khi hoàn tất</span>
          <span aria-hidden="true">·</span>
          <span>PDF giữ đúng tỷ lệ</span>
        </footer>
      )}
    </div>
  );
}
