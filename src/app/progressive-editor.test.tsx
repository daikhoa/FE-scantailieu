import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { documentApi, type StoredDocument } from '../features/library/document-api';
import { createDefaultPageRecipe } from '../features/scanner/background-page-processor';
import type { EditRecipe, ImageAsset } from '../domain/document';
import { StrictMode } from 'react';

const image = { width: 12, height: 16, mime: 'image/jpeg' };
const recipe = createDefaultPageRecipe({ kind: 'full-frame' });
const stored: StoredDocument = {
  id: 'saved',
  name: 'Bài học',
  revision: 3,
  pageCount: 2,
  createdAt: '',
  updatedAt: '',
  schemaVersion: 1,
  pdfUrl: '/api/v1/documents/saved/pdf',
  pages: ['one', 'two'].map((id) => ({
    id,
    original: image,
    rendered: image,
    recipe,
    engineVersion: 'test',
    recipeKey: id,
    outcome: { kind: 'not-requested' },
    originalUrl: `/api/v1/documents/saved/${id}/original`,
    renderedUrl: `/api/v1/documents/saved/${id}/rendered`,
    thumbnailUrl: `/api/v1/documents/saved/${id}/thumb`,
  })),
};
type Ready = Awaited<ReturnType<typeof documentApi.loadPage>>;
function ready(id: string): Ready {
  const blob = new Blob(['image'], { type: 'image/jpeg' });
  const asset = { blob, dimensions: { width: 12, height: 16 } };
  return {
    id,
    kind: 'ready',
    source: blob,
    page: {
      original: asset,
      crop: recipe.crop,
      recipe,
      variant: {
        image: asset,
        recipeKey: id,
        engineVersion: 'test',
        dewarp: { kind: 'not-requested' },
      },
    },
  };
}
function deferred() {
  let resolve: (value: Ready) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<Ready>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:preview'),
    revokeObjectURL: vi.fn(),
  });
});
afterEach(() => vi.unstubAllGlobals());

it('shows the editor immediately, loads one page at a time and enables ready page tools before the rest', async () => {
  const first = deferred();
  const second = deferred();
  const load = vi
    .spyOn(documentApi, 'loadPage')
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const renderPage = vi.fn((_original: ImageAsset, nextRecipe: EditRecipe) =>
    Promise.resolve({
      ...ready('one').page,
      recipe: nextRecipe,
    }),
  );
  render(
    <App
      initialDocument={documentApi.draft(stored)}
      pageProcessorFactory={() => ({
        enqueue: vi.fn(),
        render: renderPage,
        dispose: () => Promise.resolve(),
      })}
    />,
  );
  expect(screen.getByRole('heading', { name: 'Kiểm tra 2 trang' })).toBeVisible();
  expect(screen.getByAltText('Bản xem nhanh trang 1')).toHaveAttribute(
    'src',
    stored.pages[0]?.thumbnailUrl,
  );
  expect(load).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Xem PDF 2 trang' })).toBeDisabled();
  await act(async () => {
    first.resolve(ready('one'));
    await first.promise;
  });
  await waitFor(() => {
    expect(load).toHaveBeenCalledTimes(2);
  });
  expect(screen.getByRole('button', { name: 'Xoay trái' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Xoay trái' }));
  await waitFor(() => {
    expect(renderPage).toHaveBeenCalledOnce();
  });
  await act(async () => {
    second.resolve(ready('two'));
    await second.promise;
  });
  expect(screen.getByRole('button', { name: 'Xem PDF 2 trang' })).toBeEnabled();
});

it('keeps loaded pages when another fails and retries only the failed page', async () => {
  const retry = deferred();
  const load = vi
    .spyOn(documentApi, 'loadPage')
    .mockResolvedValueOnce(ready('one'))
    .mockRejectedValueOnce(new Error('Network'))
    .mockReturnValueOnce(retry.promise);
  render(<App initialDocument={documentApi.draft(stored)} />);
  await screen.findByText('Tải trang thất bại');
  fireEvent.click(screen.getByRole('button', { name: 'Chọn trang 2' }));
  fireEvent.click(screen.getByRole('button', { name: 'Tải lại trang 2' }));
  expect(load).toHaveBeenCalledTimes(3);
  expect(load.mock.calls[2]?.[0].id).toBe('two');
  await act(async () => {
    retry.resolve(ready('two'));
    await retry.promise;
  });
  expect(screen.getByRole('button', { name: 'Xem PDF 2 trang' })).toBeEnabled();
});

it('cancels pending downloads on unmount and never starts queued pages', () => {
  const load = vi
    .spyOn(documentApi, 'loadPage')
    .mockImplementation(() => new Promise(() => undefined));
  const view = render(<App initialDocument={documentApi.draft(stored)} />);
  const signal = load.mock.calls[0]?.[1];
  view.unmount();
  expect(signal?.aborted).toBe(true);
  expect(load).toHaveBeenCalledTimes(1);
});

it('restarts cleanly after StrictMode cleanup without stale page completions', async () => {
  const current = deferred();
  const load = vi
    .spyOn(documentApi, 'loadPage')
    .mockImplementationOnce(
      (_page, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Cancelled', 'AbortError')),
            { once: true },
          );
        }),
    )
    .mockReturnValue(current.promise);
  render(
    <StrictMode>
      <App initialDocument={documentApi.draft(stored)} />
    </StrictMode>,
  );
  await waitFor(() => {
    expect(load).toHaveBeenCalledTimes(2);
  });
  expect(load.mock.calls[0]?.[1].aborted).toBe(true);
  expect(load.mock.calls[1]?.[0].id).toBe('one');
  await act(async () => {
    current.resolve(ready('one'));
    await current.promise;
  });
  expect(screen.getByRole('button', { name: 'Xoay trái' })).toBeEnabled();
});

it('deleting a queued page prevents its download and does not resurrect it', async () => {
  const first = deferred();
  const load = vi.spyOn(documentApi, 'loadPage').mockReturnValue(first.promise);
  render(<App initialDocument={documentApi.draft(stored)} />);
  fireEvent.click(screen.getByRole('button', { name: 'Chọn trang 2' }));
  fireEvent.click(screen.getByRole('button', { name: 'Xóa trang 2' }));
  await act(async () => {
    first.resolve(ready('one'));
    await first.promise;
  });
  expect(screen.getByRole('heading', { name: 'Kiểm tra 1 trang' })).toBeVisible();
  expect(load).toHaveBeenCalledTimes(1);
});
