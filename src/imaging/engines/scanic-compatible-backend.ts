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
  let initializing = false;
  let disposed = false;
  let usingWorker = true;
  const cleanup = new WeakMap<ClassicalBackend, Promise<void>>();
  const isDisposed = () => disposed;
  const release = (backend: ClassicalBackend): Promise<void> => {
    if (active === backend) active = null;
    let task = cleanup.get(backend);
    if (task === undefined) {
      task = Promise.resolve().then(() => backend.dispose());
      cleanup.set(backend, task);
    }
    return task;
  };
  const activate = async (candidate: ClassicalBackend): Promise<void> => {
    if (isDisposed()) {
      await release(candidate);
      throw new ScannerEngineError('unavailable');
    }
    active = candidate;
    try {
      await candidate.initialize();
      if (isDisposed()) throw new ScannerEngineError('unavailable');
      initialized = true;
    } catch (error) {
      await release(candidate);
      throw error;
    }
  };
  const requireActive = (): ClassicalBackend => {
    if (disposed || !initialized || active === null) throw new ScannerEngineError('unavailable');
    return active;
  };
  return {
    async initialize() {
      if (disposed || initialized || initializing) throw new ScannerEngineError('unavailable');
      initializing = true;
      try {
        try {
          await activate(createWorker());
        } catch (error) {
          if (isDisposed() || failureCode(error) !== 'unavailable') throw error;
          usingWorker = false;
          await activate(await createFallback());
        }
      } finally {
        initializing = false;
      }
    },
    async detect(input) {
      const current = requireActive();
      // Retain only the reduced detection frame for one retry; warp never makes this copy.
      const retryInput = { dimensions: input.dimensions, pixels: input.pixels.slice() };
      try {
        return await current.detect(input);
      } catch (error) {
        if (isDisposed()) throw error;
        initialized = false;
        await release(current);
        if (isDisposed()) throw new ScannerEngineError('unavailable');
        const recovered = usingWorker ? createWorker() : await createFallback();
        try {
          await activate(recovered);
          return await recovered.detect(retryInput);
        } catch (retryError) {
          initialized = false;
          await release(recovered);
          throw retryError;
        }
      }
    },
    warp(input, corners, rotation, filter, maximumOutputLongSide, analysis) {
      return requireActive().warp(
        input,
        corners,
        rotation,
        filter,
        maximumOutputLongSide,
        analysis,
      );
    },
    async dispose() {
      disposed = true;
      initialized = false;
      const current = active;
      if (current !== null) await release(current);
    },
  };
}
