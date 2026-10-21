import { describe, expect, it } from 'vitest';

import { loadMultipartModel } from './multipart-model-loader';

function response(bytes: readonly number[]): Response {
  return new Response(Uint8Array.from(bytes), { status: 200 });
}

describe('loadMultipartModel', () => {
  it('reassembles model parts in declared order', async () => {
    const parts = new Map([
      ['/model.part-0', response([1, 2, 3])],
      ['/model.part-1', response([4, 5])],
    ]);

    const model = await loadMultipartModel(['/model.part-0', '/model.part-1'], {
      fetchPart: (url) => {
        const part = parts.get(url);
        if (part === undefined) return Promise.reject(new Error(`Missing fixture: ${url}`));
        return Promise.resolve(part);
      },
      maximumBytes: 8,
    });

    expect([...model]).toEqual([1, 2, 3, 4, 5]);
  });

  it('rejects a failed part instead of creating a corrupt model', async () => {
    await expect(
      loadMultipartModel(['/missing.part'], {
        fetchPart: () => Promise.resolve(new Response(null, { status: 404 })),
      }),
    ).rejects.toThrow('Model part request failed (404).');
  });

  it('rejects a model larger than the configured memory bound', async () => {
    await expect(
      loadMultipartModel(['/large.part'], {
        fetchPart: () => Promise.resolve(response([1, 2, 3])),
        maximumBytes: 2,
      }),
    ).rejects.toThrow('Model exceeds the 2-byte limit.');
  });
});
