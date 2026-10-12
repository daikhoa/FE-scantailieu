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
  readonly engine: ScannerEngine;
  readonly source: VideoFrameSource;
  readonly video: HTMLVideoElement;
  readonly onResult: (result: LiveDetectionResult) => void;
  readonly onError?: (failure: ProcessingFailure) => void;
  readonly intervalMs?: number;
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

export function startLiveDetectionSession(
  options: LiveDetectionSessionOptions,
): LiveDetectionSession {
  const intervalMs = options.intervalMs ?? 125;
  const controller = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let scheduler: ReturnType<typeof createDetectionScheduler> | null = null;
  let stopping: Promise<void> | null = null;

  const startup = (async () => {
    try {
      await options.engine.initialize(controller.signal);
      if (controller.signal.aborted) return;
      scheduler = createDetectionScheduler({
        engine: options.engine,
        onResult: options.onResult,
        ...(options.onError === undefined ? {} : { onError: options.onError }),
        ...(options.stableFrames === undefined ? {} : { stableFrames: options.stableFrames }),
        ...(options.maxCornerDriftRatio === undefined
          ? {}
          : { maxCornerDriftRatio: options.maxCornerDriftRatio }),
        ...(options.smoothingAlpha === undefined ? {} : { smoothingAlpha: options.smoothingAlpha }),
        intervalMs,
      });
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
      sample();
      timer = setInterval(sample, intervalMs);
    } catch (error) {
      if (!controller.signal.aborted && !isAbort(error)) options.onError?.(safeFailure(error));
    }
  })();

  return {
    stop() {
      if (stopping !== null) return stopping;
      stopped = true;
      controller.abort();
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      stopping = (async () => {
        await startup;
        await scheduler?.dispose();
        options.source.dispose();
        await options.engine.dispose();
      })();
      return stopping;
    },
  };
}
