export type CameraFailureCode =
  'unavailable' | 'permission-denied' | 'not-found' | 'busy' | 'failed';

export type CameraLifecycle =
  | { readonly kind: 'idle' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'active' }
  | { readonly kind: 'failed'; readonly error: { readonly code: CameraFailureCode } };

const SAFE_MESSAGES: Readonly<Record<CameraFailureCode, string>> = {
  unavailable: 'Camera is unavailable in this browser.',
  'permission-denied': 'Camera permission was denied.',
  'not-found': 'No suitable camera was found.',
  busy: 'The camera is busy or could not be started.',
  failed: 'The camera could not be started.',
};

export class CameraServiceError extends Error {
  override readonly name = 'CameraServiceError';

  constructor(readonly code: CameraFailureCode) {
    super(SAFE_MESSAGES[code]);
  }
}

interface MediaDevicesPort {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

interface VisibilityPort {
  readonly hidden: boolean;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

interface PageLifecyclePort {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export interface CameraServiceOptions {
  readonly mediaDevices: MediaDevicesPort | null;
  readonly visibility: VisibilityPort | null;
  readonly page: PageLifecyclePort | null;
}

export interface CameraSession {
  readonly stream: MediaStream;
  stop(): void;
}

export interface CameraService {
  readonly lifecycle: CameraLifecycle;
  start(signal: AbortSignal): Promise<CameraSession>;
  stop(): void;
}

const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
};

function abortError(): Error {
  const error = new Error('Camera operation cancelled.');
  error.name = 'AbortError';
  return error;
}

function browserFailure(error: unknown): CameraServiceError {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new CameraServiceError('permission-denied');
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new CameraServiceError('not-found');
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return new CameraServiceError('busy');
  }
  return new CameraServiceError('failed');
}

function stopStream(stream: MediaStream | null): void {
  if (stream === null) return;
  let tracks: readonly MediaStreamTrack[];
  try {
    tracks = stream.getTracks();
  } catch {
    return;
  }
  for (const track of tracks) {
    try {
      track.stop();
    } catch {
      // Continue releasing the remaining tracks even if a browser track is already broken.
    }
  }
}

function availableMediaDevices(): MediaDevicesPort | null {
  if (typeof navigator === 'undefined') return null;
  const candidate: unknown = navigator.mediaDevices;
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    !('getUserMedia' in candidate) ||
    typeof candidate.getUserMedia !== 'function'
  ) {
    return null;
  }
  const mediaDevices = candidate as MediaDevicesPort;
  return {
    getUserMedia: (constraints) => mediaDevices.getUserMedia(constraints),
  };
}

function browserOptions(): CameraServiceOptions {
  const mediaDevices = availableMediaDevices();
  const visibility =
    typeof document === 'undefined'
      ? null
      : {
          get hidden() {
            return document.hidden;
          },
          addEventListener: (type: string, listener: EventListener) => {
            document.addEventListener(type, listener);
          },
          removeEventListener: (type: string, listener: EventListener) => {
            document.removeEventListener(type, listener);
          },
        };
  const page =
    typeof window === 'undefined'
      ? null
      : {
          addEventListener: (type: string, listener: EventListener) => {
            window.addEventListener(type, listener);
          },
          removeEventListener: (type: string, listener: EventListener) => {
            window.removeEventListener(type, listener);
          },
        };
  return { mediaDevices, visibility, page };
}

class BrowserCameraService implements CameraService {
  private state: CameraLifecycle = { kind: 'idle' };
  private stream: MediaStream | null = null;
  private generation = 0;
  private pendingCancellation: {
    readonly operation: number;
    readonly cancel: () => void;
  } | null = null;
  private listening = false;

  private readonly onVisibilityChange = () => {
    if (this.options.visibility?.hidden === true) this.stop();
  };

  private readonly onPageHide = () => {
    this.stop();
  };

  constructor(private readonly options: CameraServiceOptions) {}

  get lifecycle(): CameraLifecycle {
    return this.state;
  }

  private operationCancelled(operation: number, signal: AbortSignal): boolean {
    return signal.aborted || operation !== this.generation;
  }

  private attachLifecycle(): void {
    if (this.listening) return;
    this.options.visibility?.addEventListener('visibilitychange', this.onVisibilityChange);
    this.options.page?.addEventListener('pagehide', this.onPageHide);
    this.listening = true;
  }

  private detachLifecycle(): void {
    if (!this.listening) return;
    this.options.visibility?.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.options.page?.removeEventListener('pagehide', this.onPageHide);
    this.listening = false;
  }

  async start(signal: AbortSignal): Promise<CameraSession> {
    if (signal.aborted) throw abortError();
    if (this.state.kind === 'starting' || this.state.kind === 'active') {
      throw new CameraServiceError('unavailable');
    }
    if (this.options.mediaDevices === null) {
      const failure = new CameraServiceError('unavailable');
      this.state = { kind: 'failed', error: { code: failure.code } };
      throw failure;
    }

    const operation = ++this.generation;
    this.state = { kind: 'starting' };
    this.attachLifecycle();
    const onAbort = () => {
      if (operation === this.generation) this.stop();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      const requested = this.options.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
      const acquired = await new Promise<MediaStream>((resolve, reject) => {
        this.pendingCancellation = {
          operation,
          cancel: () => {
            reject(abortError());
          },
        };
        requested.then(
          (stream) => {
            if (this.operationCancelled(operation, signal)) {
              stopStream(stream);
              reject(abortError());
              return;
            }
            resolve(stream);
          },
          (error: unknown) => {
            reject(error instanceof Error ? error : new CameraServiceError('failed'));
          },
        );
      });
      if (this.pendingCancellation?.operation === operation) this.pendingCancellation = null;
      if (this.operationCancelled(operation, signal)) {
        stopStream(acquired);
        throw abortError();
      }
      this.stream = acquired;
      this.state = { kind: 'active' };
      let stopped = false;
      return {
        stream: acquired,
        stop: () => {
          if (stopped) return;
          stopped = true;
          if (operation === this.generation) this.stop();
        },
      };
    } catch (error) {
      if (this.pendingCancellation?.operation === operation) this.pendingCancellation = null;
      if (this.operationCancelled(operation, signal)) {
        if (operation === this.generation) this.stop();
        throw abortError();
      }
      const failure = browserFailure(error);
      this.state = { kind: 'failed', error: { code: failure.code } };
      this.detachLifecycle();
      throw failure;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  stop(): void {
    this.generation++;
    const cancelPending = this.pendingCancellation;
    this.pendingCancellation = null;
    const active = this.stream;
    this.stream = null;
    this.state = { kind: 'idle' };
    this.detachLifecycle();
    stopStream(active);
    cancelPending?.cancel();
  }
}

export function createCameraService(
  options: CameraServiceOptions = browserOptions(),
): CameraService {
  return new BrowserCameraService(options);
}
