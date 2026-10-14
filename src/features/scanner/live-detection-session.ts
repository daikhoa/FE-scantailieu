import type { ProcessingFailure } from '../../domain/document';
import type { ScannerEngine } from '../../imaging/contracts/scanner-engine';
import {
  createDetectionScheduler,
  type DetectionSmootherOptions,
  type LiveDetectionResult,
} from './detection-scheduler';
import { PreviewFrameError, type VideoFrameSource } from './video-frame-source';

const FAILURE_CODES = new Set<ProcessingFailure['code']>([
  'unavailable',
  'timeout',
  'out-of-memory',
  'invalid-input',
  'failed',
]);

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
  if (
    !Number.isFinite(initialRetryDelayMs) ||
    initialRetryDelayMs < 0 ||
    initialRetryDelayMs > 60_000
  ) {
    throw new RangeError('Invalid live detection retry delay.');
  }
  const controller = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let scheduler: ReturnType<typeof createDetectionScheduler> | null = null;
  let endCycle: (() => void) | null = null;
  let stopping: Promise<void> | null = null;
  const aborted = () => controller.signal.aborted;

  const sample = () => {
    if (stopped || scheduler === null) return;
    try {
      scheduler.submit(options.source.capture(options.video, controller.signal));
    } catch (error) {
      if (
        !isAbort(error) &&
        !(error instanceof PreviewFrameError && error.code === 'unavailable')
      ) {
        options.onError?.(safeFailure(error));
      }
    }
  };

  const manager = (async () => {
    let retryDelayMs = initialRetryDelayMs;
    while (!aborted()) {
      let engine: ScannerEngine | null = null;
      let activeScheduler: ReturnType<typeof createDetectionScheduler> | null = null;
      try {
        const cycleEngine = options.engineFactory();
        engine = cycleEngine;
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
            options.onResult(result);
          },
          onError: (failure) => {
            options.onError?.(failure);
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
        if (!aborted() && !isAbort(error)) options.onError?.(safeFailure(error));
      } finally {
        scheduler = null;
        endCycle = null;
        try {
          await activeScheduler?.dispose();
        } catch (error) {
          if (!aborted()) options.onError?.(safeFailure(error));
        }
        try {
          await engine?.dispose();
        } catch (error) {
          if (!aborted()) options.onError?.(safeFailure(error));
        }
      }

      if (aborted()) break;
      await waitForRetry(retryDelayMs, controller.signal);
      retryDelayMs = Math.min(Math.max(initialRetryDelayMs, 1) * 8, retryDelayMs * 2 || 1);
    }
  })();

  timer = setInterval(sample, intervalMs);

  return {
    stop() {
      if (stopping !== null) return stopping;
      stopped = true;
      controller.abort();
      endCycle?.();
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      stopping = (async () => {
        await manager;
        options.source.dispose();
      })();
      return stopping;
    },
  };
}
