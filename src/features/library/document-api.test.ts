import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { createDefaultPageRecipe } from '../scanner/background-page-processor';
import type { ScanBatchPage } from '../scanner/scan-batch';
import { documentApi, type StoredDocument } from './document-api';

afterEach(() => vi.unstubAllGlobals());

describe('editable document API contract', () => {
  it('renames with metadata only instead of uploading files', async () => {
    const document = {
      id: 'saved',
      name: 'Old',
      revision: 2,
      pageCount: 1,
      createdAt: '',
      updatedAt: '',
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ ...document, name: 'New', revision: 3 })));
    vi.stubGlobal('fetch', fetcher);
    await documentApi.rename(document, ' New ', new AbortController().signal);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify({ name: 'New', revision: 2 }),
    });
  });

  it('loads at most two pages concurrently and preserves page order', async () => {
    const image = { width: 12, height: 16, mime: 'image/jpeg' };
    const document: StoredDocument = {
      id: 'saved',
      name: 'Test',
      revision: 1,
      pageCount: 3,
      createdAt: '',
      updatedAt: '',
      schemaVersion: 1,
      pdfUrl: '/api/v1/documents/saved/pdf',
      pages: Array.from({ length: 3 }, (_, i) => ({
        id: String(i),
        original: image,
        rendered: image,
        recipe: createDefaultPageRecipe({ kind: 'full-frame' }),
        engineVersion: 'test',
        recipeKey: String(i),
        outcome: { kind: 'not-requested' },
        originalUrl: `/api/v1/documents/saved/original_${String(i)}`,
        renderedUrl: `/api/v1/documents/saved/rendered_${String(i)}`,
        thumbnailUrl: '',
      })),
    };
    const pending: (() => void)[] = [];
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) =>
          pending.push(() => {
            resolve(new Response(new Blob(['image'], { type: 'image/jpeg' })));
          }),
        ),
    );
    vi.stubGlobal('fetch', fetcher);
    const editing = documentApi.edit(document, new AbortController().signal);
    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledTimes(4);
    });
    pending[3]?.();
    pending[2]?.();
    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledTimes(6);
    });
    pending[5]?.();
    pending[4]?.();
    pending[1]?.();
    pending[0]?.();
    expect((await editing).pages.map((page) => page.id)).toEqual(['0', '1', '2']);
  });
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
