import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScanicMainThreadBackend } from './scanic-main-thread-backend';

vi.mock('./scanic-frame.ts?worker&url', () => ({ default: '/assets/scanic-frame.js' }));
class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  postMessage = vi.fn();
  start = vi.fn();
  close = vi.fn();
}
class FakeChannel {
  static latest: FakeChannel;
  port1 = new FakePort();
  port2 = new FakePort();
  constructor() {
    FakeChannel.latest = this;
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('owned DOM detector realm', () => {
  it('loads an external module through DOM APIs and connects only after it loads', async () => {
    vi.stubGlobal('MessageChannel', FakeChannel);
    const backend = createScanicMainThreadBackend();
    try {
      const frame = document.querySelector('iframe');
      if (frame === null) throw new Error('Missing processing frame.');
      const frameWindow = frame.contentWindow;
      if (frameWindow === null) throw new Error('Missing processing window.');
      const post = vi.spyOn(frameWindow, 'postMessage');
      frame.dispatchEvent(new Event('load'));
      const script = frame.contentDocument?.querySelector('script');
      expect(script).toHaveAttribute('type', 'module');
      expect(script).toHaveAttribute('src', `${window.location.origin}/assets/scanic-frame.js`);
      expect(post).not.toHaveBeenCalled();
      script?.dispatchEvent(new Event('load'));
      expect(post).toHaveBeenCalledWith('scanic-connect', window.location.origin, [
        FakeChannel.latest.port2,
      ]);
      const pending = backend.initialize();
      FakeChannel.latest.port1.onmessage?.({ data: { kind: 'connected' } });
      await vi.waitFor(() => {
        expect(FakeChannel.latest.port1.postMessage).toHaveBeenCalledWith(
          { id: 1, operation: 'initialize' },
          [],
        );
      });
      FakeChannel.latest.port1.onmessage?.({ data: { id: 1, kind: 'success', output: null } });
      await pending;
    } finally {
      await backend.dispose();
    }
    expect(document.querySelector('iframe')).toBeNull();
    expect(FakeChannel.latest.port1.close).toHaveBeenCalledOnce();
  });
  it('reports module loading failure without waiting for the startup timeout', async () => {
    vi.stubGlobal('MessageChannel', FakeChannel);
    const backend = createScanicMainThreadBackend();
    try {
      const pending = backend.initialize();
      const rejected = expect(pending).rejects.toMatchObject({ code: 'unavailable' });
      const frame = document.querySelector('iframe');
      frame?.dispatchEvent(new Event('load'));
      frame?.contentDocument?.querySelector('script')?.dispatchEvent(new Event('error'));
      await rejected;
    } finally {
      await backend.dispose();
    }
  });
});
