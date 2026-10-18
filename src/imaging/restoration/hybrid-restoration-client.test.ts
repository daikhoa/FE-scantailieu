import { describe, expect, it, vi } from 'vitest';

import type { ImageImporter } from '../../features/camera/image-import';
import { HybridRestorationError, createHybridRestorationClient } from './hybrid-restoration-client';

function importer(): ImageImporter {
  return vi.fn((blob: Blob) =>
    Promise.resolve({
      original: { blob, dimensions: { width: 100, height: 140 } },
    }),
  );
}

function responseHeaders(overrides: Record<string, string> = {}): Headers {
  return new Headers({
    'Content-Type': 'image/png',
    'X-Restoration-Route': 'local',
    'X-Restoration-Stages': '',
    'X-Classifier-Model': 'document-defects@test-1',
    ...overrides,
  });
}

describe('hybrid restoration client', () => {
  it('uploads one bounded image and accepts an auditable local decision', async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(new Uint8Array([137, 80, 78, 71]), { headers: responseHeaders() }),
      ),
    );
    const client = createHybridRestorationClient({
      endpoint: 'https://scanner.example/v1/restorations',
      fetcher,
      importer: importer(),
    });

    const result = await client.restore(
      new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      new AbortController().signal,
    );

    expect(result.route).toBe('local');
    expect(result.stages).toEqual([]);
    expect(result.classifierModel).toBe('document-defects@test-1');
    expect(fetcher).toHaveBeenCalledOnce();
    const request = vi.mocked(fetcher).mock.calls[0]?.[1];
    expect(request?.method).toBe('POST');
    expect(request?.body).toBeInstanceOf(FormData);
    expect(request?.credentials).toBe('omit');
  });

  it('requires provider identity for a GPU result', async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: responseHeaders({
            'X-Restoration-Route': 'gpu',
            'X-Restoration-Stages': 'dewarp,deshadow',
          }),
        }),
      ),
    );
    const client = createHybridRestorationClient({
      endpoint: 'https://scanner.example/v1/restorations',
      fetcher,
      importer: importer(),
    });

    await expect(
      client.restore(
        new Blob([new Uint8Array([1])], { type: 'image/png' }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('maps an unavailable model to a recoverable failure', async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response('{"detail":{"code":"model_unavailable"}}', {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const client = createHybridRestorationClient({
      endpoint: 'https://scanner.example/v1/restorations',
      fetcher,
      importer: importer(),
    });

    await expect(
      client.restore(
        new Blob([new Uint8Array([1])], { type: 'image/png' }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('rejects an oversized response before allocating its body', async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(new Uint8Array([1]), {
          headers: responseHeaders({ 'Content-Length': '999' }),
        }),
      ),
    );
    const client = createHybridRestorationClient({
      endpoint: 'https://scanner.example/v1/restorations',
      fetcher,
      importer: importer(),
      maxResponseBytes: 16,
    });

    await expect(
      client.restore(
        new Blob([new Uint8Array([1])], { type: 'image/png' }),
        new AbortController().signal,
      ),
    ).rejects.toEqual(new HybridRestorationError('invalid-response'));
  });

  it('rejects insecure remote endpoints', () => {
    expect(() =>
      createHybridRestorationClient({
        endpoint: 'http://scanner.example/v1/restorations',
        importer: importer(),
      }),
    ).toThrow(HybridRestorationError);
  });
});
