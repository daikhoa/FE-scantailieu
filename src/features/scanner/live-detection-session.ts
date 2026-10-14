import type { ProcessingFailure } from '../../domain/document';
import type { ScannerEngine } from '../../imaging/contracts/scanner-engine';
import {
  createDetectionScheduler,
  type DetectionSmootherOptions,
  type LiveDetectionResult,
  validateDetectionSchedulerConfiguration,
} from './detection-scheduler';
import { PreviewFrameError, type VideoFrameSource } from './video-frame-source';

const FAILURE_CODES = new Set<ProcessingFailure['code']>([
  'unavailable',
  'timeout',
  'out-of-memory',
  'invalid-input',
  'failed',
]);
const MINIMUM_RETRY_DELAY_MS = 50;

interface LiveDetectionSessionOptions extends DetectionSmootherOptions {
  readonly engineFactory: () => ScannerEngine;
  readonly source: VideoFrameSource;
  readonly video: HTMLVideoElement;
  readonly onResult: (result: LiveDetectionResult) => void;
  readonly onError?: (failure: ProcessingFailure) => void;
  readonly intervalMs?: number;
  readonly retryDelayMs?: number;
}

export interface LiveDetectionSession {
  stop(): Promise<void>;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function safeFailure(error: unknown): ProcessingFailure {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    FAILURE_CODES.has(error.code as ProcessingFailure['code'])
  ) {
    return { code: error.code as ProcessingFailure['code'] };
  }
  return { code: 'failed' };
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || delayMs === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener('abort', finish, { once: true });
  });
}

export function startLiveDetectionSession(
  options: LiveDetectionSessionOptions,
): LiveDetectionSession {
  const intervalMs = options.intervalMs ?? 125;
  const initialRetryDelayMs = options.retryDelayMs ?? 250;
  validateDetectionSchedulerConfiguration(options);
  if (
    !Number.isFinite(initialRetryDelayMs) ||
    initialRetryDelayMs < MINIMUM_RETRY_DELAY_MS ||
    initialRetryDelayMs > 60_000
  ) {
    throw new RangeError('Invalid live detection retry delay.');
  }
  const controller = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let scheduler: ReturnType<typeof createDetectionScheduler> | null = null;
  let activeEngine: ScannerEngine | null = null;
  let activeEngineDisposal: Promise<void> | null = null;
  let endCycle: (() => void) | null = null;
  let stopping: Promise<void> | null = null;
  let cleanupFailure = false;
  const aborted = () => controller.signal.aborted;
  const notifyFailure = (failure: ProcessingFailure) => {
    try {
      options.onError?.(failure);
    } catch {
      // A UI callback must not strand the engine or its worker resources.
    }
  };
  const disposeEngine = (engine: ScannerEngine): Promise<void> => {
    if (activeEngine === engine && activeEngineDisposal !== null) return activeEngineDisposal;
    const disposal = Promise.resolve().then(() => engine.dispose());
    if (activeEngine === engine) activeEngineDisposal = disposal;
    return disposal;
  };

  const sample = () => {
    if (stopped || scheduler === null) return;
    try {
      scheduler.submit(options.source.capture(options.video, controller.signal));
    } catch (error) {
      if (
        !isAbort(error) &&
        !(error instanceof PreviewFrameError && error.code === 'unavailable')
      ) {
        notifyFailure(safeFailure(error));
      }
    }
  };

  const manager = (async () => {
    let retryDelayMs = initialRetryDelayMs;
    while (!aborted()) {
      let cycleEngine: ScannerEngine | null = null;
      let activeScheduler: ReturnType<typeof createDetectionScheduler> | null = null;
      let cycleCleanupFailed = false;
      try {
        cycleEngine = options.engineFactory();
        activeEngine = cycleEngine;
        activeEngineDisposal = null;
        await cycleEngine.initialize(controller.signal);
        if (aborted()) break;
        let resolveCycle: () => void = () => undefined;
        const cycleEnded = new Promise<void>((resolve) => {
          resolveCycle = resolve;
        });
        let ended = false;
        const finishCycle = () => {
          if (ended) return;
          ended = true;
          controller.signal.removeEventListener('abort', finishCycle);
          if (endCycle === finishCycle) endCycle = null;
          resolveCycle();
        };
        const cycleScheduler = createDetectionScheduler({
          engine: cycleEngine,
          onResult: (result) => {
            retryDelayMs = initialRetryDelayMs;
            try {
              options.onResult(result);
            } catch {
              notifyFailure({ code: 'failed' });
              finishCycle();
            }
          },
          onError: (failure) => {
            notifyFailure(failure);
            finishCycle();
          },
          ...(options.stableFrames === undefined ? {} : { stableFrames: options.stableFrames }),
          ...(options.maxCornerDriftRatio === undefined
            ? {}
            : { maxCornerDriftRatio: options.maxCornerDriftRatio }),
          ...(options.smoothingAlpha === undefined
            ? {}
            : { smoothingAlpha: options.smoothingAlpha }),
          intervalMs,
        });
        activeScheduler = cycleScheduler;
        scheduler = cycleScheduler;
        endCycle = finishCycle;
        controller.signal.addEventListener('abort', finishCycle, { once: true });
        sample();
        await cycleEnded;
      } catch (error) {
        if (!aborted() && !isAbort(error)) notifyFailure(safeFailure(error));
      } finally {
        scheduler = null;
        endCycle = null;
        const cleanup = await Promise.allSettled([
          activeScheduler?.dispose() ?? Promise.resolve(),
          cycleEngine === null ? Promise.resolve() : disposeEngine(cycleEngine),
        ]);
        if (activeEngine === cycleEngine) {
          activeEngine = null;
          activeEngineDisposal = null;
        }
        for (const result of cleanup) {
          if (result.status === 'rejected') {
            cycleCleanupFailed = true;
            cleanupFailure = true;
            if (!aborted()) notifyFailure(safeFailure(result.reason));
          }
        }
      }

      if (aborted() || cycleCleanupFailed) break;
      await waitForRetry(retryDelayMs, controller.signal);
      retryDelayMs = Math.min(initialRetryDelayMs * 8, retryDelayMs * 2);
    }
  })();

  timer = setInterval(sample, intervalMs);

  return {
    stop() {
      if (stopping !== null) return stopping;
      stopped = true;
      controller.abort();
      endCycle?.();
      const engineDisposal =
        activeEngine === null ? Promise.resolve() : disposeEngine(activeEngine);
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      stopping = (async () => {
        const completion = await Promise.allSettled([manager, engineDisposal]);
        let failed = cleanupFailure || completion.some((result) => result.status === 'rejected');
        try {
          options.source.dispose();
        } catch {
          failed = true;
        }
        if (failed) throw new Error('Live detection cleanup failed.');
      })();
      return stopping;
    },
  };
}
