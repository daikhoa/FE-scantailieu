import { describe, expect, it, vi } from 'vitest';

import { CameraServiceError, createCameraService } from './camera-service';

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve(value: T) {
      if (resolve === undefined) throw new Error('Deferred was not initialized.');
      resolve(value);
    },
  };
}

function fakeStream(trackCount = 2) {
  const tracks = Array.from({ length: trackCount }, () => ({ stop: vi.fn() }));
  return {
    stream: { getTracks: () => tracks },
    tracks,
  };
}

function environment(getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>) {
  const listeners = new Map<string, EventListener>();
  const visibility = {
    hidden: false,
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      listeners.set(type, listener);
    }),
    removeEventListener: vi.fn((type: string) => {
      listeners.delete(type);
    }),
  };
  const page = {
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      listeners.set(type, listener);
    }),
    removeEventListener: vi.fn((type: string) => {
      listeners.delete(type);
    }),
  };
  return {
    options: { mediaDevices: { getUserMedia }, visibility, page },
    hide() {
      visibility.hidden = true;
      listeners.get('visibilitychange')?.(new Event('visibilitychange'));
    },
    pageHide() {
      listeners.get('pagehide')?.(new Event('pagehide'));
    },
    visibility,
    page,
  };
}

describe('camera service', () => {
  it('requests the rear camera only when start is called and releases every track', async () => {
    const captured = fakeStream();
    const getUserMedia = vi.fn(() => Promise.resolve(captured.stream as unknown as MediaStream));
    const fixture = environment(getUserMedia);
    const camera = createCameraService(fixture.options);

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(camera.lifecycle).toEqual({ kind: 'idle' });

    const session = await camera.start(new AbortController().signal);

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
    expect(session.stream).toBe(captured.stream);
    expect(camera.lifecycle).toEqual({ kind: 'active' });

    session.stop();
    session.stop();
    camera.stop();

    for (const track of captured.tracks) expect(track.stop).toHaveBeenCalledOnce();
    expect(camera.lifecycle).toEqual({ kind: 'idle' });
    expect(fixture.visibility.removeEventListener).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function),
    );
    expect(fixture.page.removeEventListener).toHaveBeenCalledWith('pagehide', expect.any(Function));
  });

  it('does not request permission for a pre-cancelled operation', async () => {
    const getUserMedia = vi.fn(() => Promise.reject(new Error('must not run')));
    const camera = createCameraService(environment(getUserMedia).options);
    const controller = new AbortController();
    controller.abort('private reason');

    await expect(camera.start(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Camera operation cancelled.',
    });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(camera.lifecycle).toEqual({ kind: 'idle' });
  });

  it('stops a stream that arrives after cancellation', async () => {
    const pending = deferred<MediaStream>();
    const captured = fakeStream(1);
    const fixture = environment(() => pending.promise);
    const camera = createCameraService(fixture.options);
    const controller = new AbortController();
    const start = camera.start(controller.signal);
    const rejected = expect(start).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Camera operation cancelled.',
    });

    controller.abort('document content');
    pending.resolve(captured.stream as unknown as MediaStream);
    await rejected;

    expect(captured.tracks[0]?.stop).toHaveBeenCalledOnce();
    expect(camera.lifecycle).toEqual({ kind: 'idle' });
  });

  it('stops active camera when the page becomes hidden or leaves the page', async () => {
    for (const event of ['hidden', 'pagehide'] as const) {
      const captured = fakeStream(1);
      const fixture = environment(() => Promise.resolve(captured.stream as unknown as MediaStream));
      const camera = createCameraService(fixture.options);
      await camera.start(new AbortController().signal);

      if (event === 'hidden') fixture.hide();
      else fixture.pageHide();

      expect(captured.tracks[0]?.stop).toHaveBeenCalledOnce();
      expect(camera.lifecycle).toEqual({ kind: 'idle' });
    }
  });

  it.each([
    ['NotAllowedError', 'permission-denied'],
    ['SecurityError', 'permission-denied'],
    ['NotFoundError', 'not-found'],
    ['OverconstrainedError', 'not-found'],
    ['NotReadableError', 'busy'],
    ['AbortError', 'busy'],
    ['UnknownError', 'failed'],
  ] as const)('maps %s without exposing browser diagnostics', async (name, code) => {
    const browserError = new Error('private device name and diagnostics');
    browserError.name = name;
    const camera = createCameraService(environment(() => Promise.reject(browserError)).options);

    await expect(camera.start(new AbortController().signal)).rejects.toMatchObject({
      name: 'CameraServiceError',
      code,
    });
    await expect(camera.start(new AbortController().signal)).rejects.not.toThrow(
      'private device name and diagnostics',
    );
    expect(camera.lifecycle).toEqual({ kind: 'failed', error: { code } });
  });

  it('reports an unavailable API and rejects overlapping permission requests', async () => {
    const missing = createCameraService({ mediaDevices: null, visibility: null, page: null });
    await expect(missing.start(new AbortController().signal)).rejects.toBeInstanceOf(
      CameraServiceError,
    );
    await expect(missing.start(new AbortController().signal)).rejects.toMatchObject({
      code: 'unavailable',
    });

    const pending = deferred<MediaStream>();
    const camera = createCameraService(environment(() => pending.promise).options);
    const first = camera.start(new AbortController().signal);
    await expect(camera.start(new AbortController().signal)).rejects.toMatchObject({
      code: 'unavailable',
    });
    camera.stop();
    pending.resolve(fakeStream(1).stream as unknown as MediaStream);
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps a replacement start cancellable while the previous browser request settles', async () => {
    const firstRequest = deferred<MediaStream>();
    const secondRequest = deferred<MediaStream>();
    const getUserMedia = vi
      .fn<(_: MediaStreamConstraints) => Promise<MediaStream>>()
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise);
    const camera = createCameraService(environment(getUserMedia).options);
    const first = camera.start(new AbortController().signal);
    camera.stop();
    const second = camera.start(new AbortController().signal);

    camera.stop();
    const staleStream = fakeStream(1);
    const replacementStream = fakeStream(1);
    firstRequest.resolve(staleStream.stream as unknown as MediaStream);
    secondRequest.resolve(replacementStream.stream as unknown as MediaStream);

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(staleStream.tracks[0]?.stop).toHaveBeenCalledOnce();
    expect(replacementStream.tracks[0]?.stop).toHaveBeenCalledOnce();
  });
});
