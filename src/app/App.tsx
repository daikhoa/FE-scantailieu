import { HomeScreen, type LibraryState } from './HomeScreen';
import { renderAnalyzedPage } from '../imaging/restoration/analyzed-page-renderer';
import { useEffect, useReducer, useRef, useState } from 'react';

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
import { createScanicEngine } from '../imaging/engines/scanic-classical-engine';
import { canReuseRestorationAnalysis } from '../imaging/restoration/local-page-restoration';
import {
  createLocalRestorationClient,
  type LocalRestorationClient,
} from '../imaging/restoration/local-restoration-client';

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
}

type AppView = 'library' | 'camera' | 'batch-review';
type CameraReturnView = Extract<AppView, 'library' | 'batch-review'>;
type HomeImportState =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'error';
      readonly code: 'too-many-images' | 'selection-too-large';
    };

const EMPTY_LIBRARY: LibraryState = { kind: 'empty' };
const MAX_IMPORT_IMAGES = 20;
const MAX_IMPORT_SELECTION_BYTES = 256 * 1024 * 1024;
const HOME_IMPORT_ERROR_GUIDANCE: Readonly<
  Record<Extract<HomeImportState, { kind: 'error' }>['code'], string>
> = {
  'too-many-images': `Tối đa ${String(MAX_IMPORT_IMAGES)} ảnh mỗi lần. Hãy chọn ít ảnh hơn.`,
  'selection-too-large': `Tổng dung lượng ảnh vượt quá ${String(MAX_IMPORT_SELECTION_BYTES / (1024 * 1024))} MiB. Hãy chọn ít ảnh hơn.`,
};

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
  const [replacementPageId, setReplacementPageId] = useState<string | null>(null);
  const [batch, dispatchBatch] = useReducer(scanBatchReducer, { pages: [] });
  const [processorGeneration, setProcessorGeneration] = useState(0);
  const [resolvedCameraService] = useState(() => cameraService ?? createCameraService());
  const restorationClientRef = useRef<LocalRestorationClient | null>(null);
  const viewHeadingRef = useRef<HTMLHeadingElement>(null);
  const shouldMoveFocus = useRef(false);
  const pageProcessor = useRef<BackgroundPageProcessor | null>(null);
  const pageOperations = useRef(new Map<string, AbortController>());
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
      void processor.dispose().catch(() => undefined);
    };
  }, [
    editorEngineFactory,
    editorFrameSource,
    imageImporter,
    pageProcessorFactory,
    processorGeneration,
    restorationClient,
  ]);

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
    if (view === 'camera') {
      restorationClientRef.current?.warmup?.();
      void pageProcessor.current?.warmup?.().catch(() => undefined);
    }
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
        {
          analysisKey: id,
          onOriginal: (original) => {
            if (pageOperations.current.get(id) === controller)
              dispatchBatch({ type: 'source-saved', id, source: original.blob });
          },
        },
      )
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
    const id = `page-${String(++pageSequence.current)}`;
    dispatchBatch({ type: 'captured', id, source });
    processPage(id, source, liveDetection);
  };

  const resetBatch = () => {
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
      const localEngine = await readyEditorEngine();
      const client = restorationClientRef.current;
      const output = await renderAnalyzedPage(
        localEngine,
        selected.page.original,
        recipe,
        controller.signal,
        {
          ...(client === null ? {} : { analyzer: client }),
          ...(canReuseRestorationAnalysis(selected.page.recipe, recipe) &&
          selected.page.analysis !== undefined
            ? { analysis: selected.page.analysis }
            : {}),
          analysisKey: id,
        },
      );
      if (controller.signal.aborted || pageOperations.current.get(id) !== controller) {
        const error = new Error('Page edit cancelled.');
        error.name = 'AbortError';
        throw error;
      }
      dispatchBatch({
        type: 'updated',
        id,
        page: {
          original: selected.page.original,
          ...(selected.page.originalPreview === undefined
            ? {}
            : { originalPreview: selected.page.originalPreview }),
          crop: recipe.crop,
          recipe,
          ...output,
        },
      });
    } finally {
      if (pageOperations.current.get(id) === controller) pageOperations.current.delete(id);
    }
  };

  const startNewCameraBatch = () => {
    setHomeImportState({ kind: 'idle' });
    resetBatch();
    setCameraReturnView('library');
    navigateTo('camera');
  };

  const openHomeImages = (sources: readonly File[]) => {
    if (sources.length === 0) return;
    const selectionFailure =
      sources.length > MAX_IMPORT_IMAGES
        ? 'too-many-images'
        : sources.reduce((total, source) => total + source.size, 0) > MAX_IMPORT_SELECTION_BYTES
          ? 'selection-too-large'
          : null;
    if (selectionFailure !== null) {
      setHomeImportState({ kind: 'error', code: selectionFailure });
      return;
    }
    setHomeImportState({ kind: 'idle' });
    resetBatch();
    for (const source of sources) appendPage(source);
    navigateTo('batch-review');
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
        />
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
            if (replacementPageId === null) {
              appendPage(source, liveDetection);
              return;
            }
            const nextId = `page-${String(++pageSequence.current)}`;

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
      ) : (
        <ScanBatchReview
          pages={batch.pages}
          headingRef={viewHeadingRef}
          onBack={() => {
            resetBatch();
            setProcessorGeneration((generation) => generation + 1);
            navigateTo('library');
          }}
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
      )}

      {isLibrary ? null : (
        <footer className="app-footer">
          <span>Không tài khoản</span>
          <span aria-hidden="true">·</span>
          <span>Không cloud</span>
          <span aria-hidden="true">·</span>
          <span>PDF giữ đúng tỷ lệ</span>
        </footer>
      )}
    </div>
  );
}
