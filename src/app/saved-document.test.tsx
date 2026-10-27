import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultPageRecipe } from '../features/scanner/background-page-processor';
import type { ScanBatchPage } from '../features/scanner/scan-batch';
import { createImagePdf } from '../features/export/image-pdf';
import { App } from './App';
import type { ComponentProps } from 'react';

vi.mock('../features/export/image-pdf', () => ({ createImagePdf: vi.fn() }));

function page(id: string): ScanBatchPage {
  const original = {
    blob: new Blob(['image'], { type: 'image/jpeg' }),
    dimensions: { width: 12, height: 16 },
  };
  const crop = { kind: 'full-frame' as const };
  return {
    id,
    source: original.blob,
    kind: 'ready',
    page: {
      original,
      crop,
      recipe: createDefaultPageRecipe(crop),
      variant: {
        image: original,
        recipeKey: id,
        engineVersion: 'test',
        dewarp: { kind: 'not-requested' },
      },
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:preview'),
    revokeObjectURL: vi.fn(),
  });
  vi.mocked(createImagePdf).mockResolvedValue(new Blob(['pdf'], { type: 'application/pdf' }));
});
afterEach(() => vi.unstubAllGlobals());

describe('editing saved documents', () => {
  it('adds gallery images after saved pages without replacing the document', async () => {
    const document = {
      id: 'saved-id',
      name: 'Bài học',
      revision: 1,
      pageCount: 1,
      createdAt: '',
      updatedAt: '',
    };
    const processed = page('imported');
    if (processed.kind !== 'ready') throw new Error('Fixture must be ready');
    render(
      <App
        initialDocument={{ document, pages: [page('page-1')] }}
        pageProcessorFactory={() => ({
          enqueue: () => Promise.resolve(processed.page),
          dispose: () => Promise.resolve(),
        })}
      />,
    );
    fireEvent.change(screen.getByLabelText('Thêm ảnh vào tài liệu'), {
      target: { files: [new File(['source'], 'extra.jpg', { type: 'image/jpeg' })] },
    });
    expect(await screen.findByRole('heading', { name: 'Kiểm tra 2 trang' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Xem PDF 2 trang' })).toBeEnabled();
    });
    expect(screen.getByRole('button', { name: 'Chọn trang 1' })).toBeInTheDocument();
  });
  it('restores pages, deletes a page and saves the same document with its new revision', async () => {
    const document = {
      id: 'saved-id',
      name: 'Bài học',
      revision: 1,
      pageCount: 2,
      createdAt: '',
      updatedAt: '',
    };
    const save = vi
      .fn<NonNullable<ComponentProps<typeof App>['onSaveDocument']>>()
      .mockResolvedValue({ ...document, revision: 2, pageCount: 1 });
    render(
      <App
        initialDocument={{ document, pages: [page('page-1'), page('page-2')] }}
        onSaveDocument={save}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Kiểm tra 2 trang' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Xóa trang 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Xem PDF 1 trang' }));
    await screen.findByRole('heading', { name: 'Xem trước PDF' });
    expect(screen.getByLabelText('Tên tài liệu')).toHaveValue('Bài học');
    fireEvent.click(screen.getByRole('button', { name: 'Lưu vào tài khoản' }));
    await waitFor(() => {
      expect(save).toHaveBeenCalledOnce();
    });
    expect(save.mock.calls[0]?.[0].map((item: ScanBatchPage) => item.id)).toEqual(['page-2']);
    expect(save.mock.calls[0]?.[3]).toEqual(document);
    expect(await screen.findByRole('button', { name: 'Đã lưu' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '← Quay lại chỉnh sửa' }));
    fireEvent.click(screen.getByRole('button', { name: 'Xem PDF 1 trang' }));
    await screen.findByRole('heading', { name: 'Xem trước PDF' });
    fireEvent.change(screen.getByLabelText('Tên tài liệu'), { target: { value: 'Bài học sửa' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu vào tài khoản' }));
    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(2);
    });
    expect(save.mock.calls[1]?.[3]).toMatchObject({ revision: 2 });
  });

  it('keeps unsaved pages when the user cancels leaving the editor', () => {
    render(
      <App
        initialDocument={{
          document: {
            id: 'doc',
            name: 'Doc',
            revision: 1,
            pageCount: 2,
            createdAt: '',
            updatedAt: '',
          },
          pages: [page('page-1'), page('page-2')],
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Xóa trang 1' }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Trang chủ' }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(screen.getByRole('heading', { name: 'Kiểm tra 1 trang' })).toBeInTheDocument();
  });
});
