import type { ClassicalBackend } from './scanic-backend-contract';
import { ScannerEngineError } from './scanner-engine-error';
import { createScanicWorkerBackend } from './scanic-worker-backend';

interface CompatibleBackendOptions {
  readonly createWorker?: () => ClassicalBackend;
  readonly createFallback?: () => Promise<ClassicalBackend>;
}

async function loadMainThreadFallback(): Promise<ClassicalBackend> {
  const module = await import('./scanic-main-thread-backend');
  return module.createScanicMainThreadBackend();
}

function failureCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : null;
}

/** Prefers the worker and lazy-loads a main-thread fallback only for missing browser capability. */
export function createCompatibleScanicBackend(
  options: CompatibleBackendOptions = {},
): ClassicalBackend {
  const createWorker = options.createWorker ?? createScanicWorkerBackend;
  const createFallback = options.createFallback ?? loadMainThreadFallback;
  let active: ClassicalBackend | null = null;
  let initialized = false;
  let disposed = false;

  const requireActive = (): ClassicalBackend => {
    if (disposed || !initialized || active === null) {
      throw new ScannerEngineError('unavailable');
    }
    return active;
  };

  return {
    async initialize() {
      if (disposed || initialized) throw new ScannerEngineError('unavailable');
      try {
        active = createWorker();
        await active.initialize();
        initialized = true;
        return;
      } catch (error) {
        await active?.dispose().catch(() => undefined);
        active = null;
        if (failureCode(error) !== 'unavailable') throw error;
      }

      try {
        active = await createFallback();
        await active.initialize();
        initialized = true;
      } catch (error) {
        await active?.dispose().catch(() => undefined);
        active = null;
        throw error instanceof ScannerEngineError ? error : new ScannerEngineError('unavailable');
      }
    },
    detect(input) {
      return requireActive().detect(input);
    },
    warp(input, corners, rotation, filter, maximumOutputLongSide) {
      return requireActive().warp(input, corners, rotation, filter, maximumOutputLongSide);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      initialized = false;
      const owned = active;
      active = null;
      await owned?.dispose();
    },
  };
}
