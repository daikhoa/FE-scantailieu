import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { createDefaultPageRecipe } from '../scanner/background-page-processor';
import type { ScanBatchPage } from '../scanner/scan-batch';
import { documentApi, type StoredDocument } from './document-api';
vi.mock('../export/image-pdf', () => ({
  createImagePdf: vi.fn(() => Promise.resolve(new Blob(['pdf'], { type: 'application/pdf' }))),
}));

afterEach(() => vi.unstubAllGlobals());

describe('editable document API contract', () => {
  it('uploads only changed pages and references unloaded pages without fetching their assets', async () => {
    const recipe = createDefaultPageRecipe({ kind: 'full-frame' });
    const info = { width: 12, height: 16, mime: 'image/jpeg' };
    const base: StoredDocument = {
      id: 'saved',
      name: 'Doc',
      revision: 1,
      pageCount: 2,
      createdAt: '',
      updatedAt: '',
      schemaVersion: 1,
      pdfUrl: '/api/v1/documents/saved/pdf',
      pages: ['one', 'two'].map((id) => ({
        id,
        original: info,
        rendered: info,
        recipe,
        engineVersion: 'test',
        recipeKey: id,
        outcome: { kind: 'not-requested' },
        originalUrl: '/original',
        renderedUrl: '/rendered',
        thumbnailUrl: '/thumb',
      })),
    };
    const image = {
      blob: new Blob(['image'], { type: 'image/jpeg' }),
      dimensions: { width: 12, height: 16 },
    };
    const pages: readonly ScanBatchPage[] = [
      {
        id: 'one',
        kind: 'ready',
        modified: true,
        source: image.blob,
        page: {
          original: image,
          crop: recipe.crop,
          recipe,
          variant: {
            image,
            recipeKey: 'one',
            engineVersion: 'test',
            dewarp: { kind: 'not-requested' },
          },
        },
      },
      { id: 'two', kind: 'loading-saved', previewUrl: '/thumb' },
    ];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...base, revision: 2 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...base, revision: 2 })));
    vi.stubGlobal('fetch', fetcher);
    await documentApi.saveChanges(pages, 'Doc', base, new AbortController().signal);
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      '/api/v1/documents/saved/pages',
      '/api/v1/documents/saved',
    ]);
    const form = fetcher.mock.calls[0]?.[1]?.body as FormData;
    expect([...form.keys()].sort()).toEqual(['manifest', 'original_0', 'pdf', 'rendered_0']);
    const raw = form.get('manifest');
    if (typeof raw !== 'string') throw new Error('Missing manifest');
    const parsed = JSON.parse(raw) as { pages: readonly { id: string; reuse?: boolean }[] };
    expect(parsed.pages[1]).toEqual({ id: 'two', reuse: true });
  });
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
