import { afterEach, describe, expect, it, vi } from 'vitest';

const cleanup = vi.hoisted(() => vi.fn());
vi.mock('@docscan/browser/internal/imaging/restoration/gcnet-runtime', () => ({
  disposeShadowRuntime: cleanup,
}));
vi.mock('@docscan/browser/internal/imaging/engines/scanic-detector-runtime', () => ({
  ScanicDetectorRuntime: class {},
}));
vi.mock('@docscan/browser/internal/imaging/engines/docscan-asset', () => ({
  renderDocscanAsset: vi.fn(),
}));
vi.mock('@docscan/browser/internal/imaging/engines/docscan-raster', () => ({
  renderDocscanRgba: vi.fn(),
}));

afterEach(() => vi.unstubAllGlobals());

describe('processing realm model ownership', () => {
  it('stops the shadow worker before acknowledging parent worker shutdown', async () => {
    const posted = vi.fn();
    vi.stubGlobal('postMessage', posted);
    const listeners = vi.spyOn(globalThis, 'addEventListener');
    await import('@docscan/browser/internal/imaging/engines/scanic-classical.worker');
    const listener = listeners.mock.calls.find(([event]) => event === 'message')?.[1];
    try {
      globalThis.dispatchEvent(
        new MessageEvent('message', { data: { operation: 'dispose', id: 7 } }),
      );
      await vi.waitFor(() =>
        expect(posted).toHaveBeenCalledWith({ id: 7, kind: 'success', output: null }),
      );
      expect(cleanup).toHaveBeenCalledOnce();
      expect(cleanup.mock.invocationCallOrder[0]).toBeLessThan(posted.mock.invocationCallOrder[0]!);
    } finally {
      if (listener) globalThis.removeEventListener('message', listener);
    }
  });

  it('stops the shadow worker before acknowledging fallback frame shutdown', async () => {
    await import('@docscan/browser/internal/imaging/engines/scanic-frame');
    const port = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      start: vi.fn(),
      postMessage: vi.fn(),
    };
    window.dispatchEvent(
      new MessageEvent('message', {
        data: 'scanic-connect',
        source: window.parent,
        origin: window.location.origin,
        ports: [port as unknown as MessagePort],
      }),
    );
    port.postMessage.mockClear();
    cleanup.mockClear();
    port.onmessage?.(new MessageEvent('message', { data: { operation: 'dispose', id: 8 } }));
    await vi.waitFor(() =>
      expect(port.postMessage).toHaveBeenCalledWith({ id: 8, kind: 'success', output: null }, []),
    );
    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanup.mock.invocationCallOrder[0]).toBeLessThan(
      port.postMessage.mock.invocationCallOrder[0]!,
    );
  });
});
