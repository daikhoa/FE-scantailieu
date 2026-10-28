import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultPageRecipe } from '../scanner/background-page-processor';
import { documentApi, type StoredDocument, type EditableDocument } from './document-api';
import { SavedDocumentScreen } from './SavedDocumentScreen';

const image = { width: 12, height: 16, mime: 'image/jpeg' };
const recipe = createDefaultPageRecipe({ kind: 'full-frame' });
const document: StoredDocument = {
  id: 'saved',
  name: 'Tài liệu để tải sau',
  revision: 2,
  pageCount: 1,
  createdAt: '',
  updatedAt: '',
  schemaVersion: 1,
  pdfUrl: '/api/v1/documents/saved/pdf',
  pages: [
    {
      id: 'page-1',
      original: image,
      rendered: image,
      recipe,
      engineVersion: 'test',
      recipeKey: 'test',
      outcome: { kind: 'not-requested' },
      originalUrl: '/api/v1/documents/saved/original',
      renderedUrl: '/api/v1/documents/saved/rendered',
      thumbnailUrl: '/api/v1/documents/saved/thumbnail',
    },
  ],
};

describe('saved document screen', () => {
  it('renames a saved document without loading editable images or uploading a PDF', async () => {
    vi.spyOn(documentApi, 'get').mockResolvedValue(document);
    const rename = vi
      .spyOn(documentApi, 'rename')
      .mockResolvedValue({ ...document, name: 'Bài học mới', revision: 3 });
    const changed = vi.fn();
    render(
      <SavedDocumentScreen id="saved" onBack={vi.fn()} onEdit={vi.fn()} onRenamed={changed} />,
    );
    await screen.findByRole('heading', { name: 'Tài liệu PDF' });
    fireEvent.click(screen.getByText('Đổi tên tài liệu'));
    fireEvent.change(screen.getByLabelText('Tên tài liệu'), { target: { value: 'Bài học mới' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
    await waitFor(() => {
      expect(changed).toHaveBeenCalledOnce();
    });
    expect(rename).toHaveBeenCalledWith(document, 'Bài học mới', expect.any(AbortSignal));
    expect(screen.getByText('Bài học mới')).toBeVisible();
  });
  it('shows a focused loading screen and cancels pending work when returning to the library', () => {
    const get = vi.spyOn(documentApi, 'get').mockImplementation(() => new Promise(() => undefined));
    const back = vi.fn();
    const view = render(<SavedDocumentScreen id="saved" onBack={back} onEdit={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Đang mở tài liệu' })).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('Đang lấy các trang');
    fireEvent.click(screen.getByRole('button', { name: '← Kho tài liệu' }));
    expect(back).toHaveBeenCalledOnce();
    const signal = get.mock.calls[0]?.[1];
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('reports metadata errors on the document screen and can retry successfully', async () => {
    vi.spyOn(documentApi, 'get')
      .mockRejectedValueOnce(new Error('Mất kết nối.'))
      .mockResolvedValue(document);
    render(<SavedDocumentScreen id="saved" onBack={vi.fn()} onEdit={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Mất kết nối.');
    fireEvent.click(screen.getByRole('button', { name: 'Thử mở lại tài liệu' }));
    expect(await screen.findByRole('heading', { name: 'Tài liệu PDF' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Tải PDF' })).toHaveAttribute(
      'href',
      '/api/v1/documents/saved/pdf?download=true',
    );
  });

  it('restores the saved document editor through its original pages and recipe', async () => {
    vi.spyOn(documentApi, 'get').mockResolvedValue(document);
    const blob = new Blob(['image'], { type: 'image/jpeg' });
    const asset = { blob, dimensions: { width: 12, height: 16 } };
    const draft: EditableDocument = {
      document,
      pages: [
        {
          id: 'page-1',
          kind: 'ready',
          source: blob,
          page: {
            original: asset,
            crop: recipe.crop,
            recipe,
            variant: {
              image: asset,
              recipeKey: 'test',
              engineVersion: 'test',
              dewarp: { kind: 'not-requested' },
            },
          },
        },
      ],
    };
    const edit = vi.spyOn(documentApi, 'edit').mockResolvedValue(draft);
    const opened = vi.fn();
    render(<SavedDocumentScreen id="saved" onBack={vi.fn()} onEdit={opened} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Chỉnh sửa tài liệu' }));
    await waitFor(() => {
      expect(opened).toHaveBeenCalledWith(draft);
    });
    expect(edit).toHaveBeenCalledWith(document, expect.any(AbortSignal));
  });
});
