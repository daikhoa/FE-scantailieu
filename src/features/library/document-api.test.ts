import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultPageRecipe } from '../scanner/background-page-processor';
import type { ScanBatchPage } from '../scanner/scan-batch';
import { documentApi } from './document-api';

afterEach(() => vi.unstubAllGlobals());

describe('editable document API contract', () => {
  it('uploads original images, rendered pages, recipes and the PDF with the existing revision', async () => {
    const original = {
      blob: new Blob(['original'], { type: 'image/jpeg' }),
      dimensions: { width: 12, height: 16 },
    };
    const image = { ...original, blob: new Blob(['rendered'], { type: 'image/jpeg' }) };
    const crop = { kind: 'full-frame' as const };
    const recipe = createDefaultPageRecipe(crop);
    const pages: readonly ScanBatchPage[] = [
      {
        id: 'page-1',
        source: original.blob,
        kind: 'ready',
        page: {
          original,
          crop,
          recipe,
          variant: {
            image,
            recipeKey: 'key',
            engineVersion: 'test',
            dewarp: { kind: 'not-requested' },
          },
        },
      },
    ];
    const existing = {
      id: 'document-id',
      name: 'Bài học',
      revision: 3,
      pageCount: 1,
      createdAt: '',
      updatedAt: '',
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ ...existing, revision: 4 })));
    vi.stubGlobal('fetch', fetcher);
    await documentApi.save(
      pages,
      new Blob(['pdf'], { type: 'application/pdf' }),
      'Bài học',
      existing,
      new AbortController().signal,
    );
    const [path, request] = fetcher.mock.calls[0] ?? [];
    expect(path).toBe('/api/v1/documents/document-id');
    expect(request?.method).toBe('PUT');
    const body = request?.body;
    expect(body).toBeInstanceOf(FormData);
    if (!(body instanceof FormData)) throw new Error('Expected multipart body');
    expect(body.get('original_0')).toBeInstanceOf(Blob);
    expect(body.get('rendered_0')).toBeInstanceOf(Blob);
    expect(body.get('pdf')).toBeInstanceOf(Blob);
    const raw = body.get('manifest');
    expect(typeof raw).toBe('string');
    if (typeof raw !== 'string') throw new Error('Missing manifest');
    expect(JSON.parse(raw)).toMatchObject({
      schemaVersion: 1,
      name: 'Bài học',
      revision: 3,
      pages: [{ id: 'page-1', recipe, original: { width: 12, height: 16, mime: 'image/jpeg' } }],
    });
  });
});
