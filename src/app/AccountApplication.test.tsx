import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { accountApi, ApiError } from '../features/account/api-client';
import { documentApi } from '../features/library/document-api';
import { AccountApplication } from './AccountApplication';
import * as apiClient from '../features/account/api-client';
import { createDefaultPageRecipe } from '../features/scanner/background-page-processor';

describe('account boundary', () => {
  it('opens a listed document and restores its saved page editor', async () => {
    vi.spyOn(accountApi, 'me').mockResolvedValue({ id: 'account', email: 'reader@example.com' });
    const document = {
      id: 'abc',
      name: 'Tài liệu đã lưu',
      revision: 1,
      pageCount: 1,
      createdAt: '',
      updatedAt: '',
    };
    vi.spyOn(documentApi, 'list').mockResolvedValue({
      items: [document],
      total: 1,
      limit: 20,
      offset: 0,
    });
    const get = vi.spyOn(documentApi, 'get').mockResolvedValue({
      ...document,
      schemaVersion: 1,
      pdfUrl: '/api/v1/documents/abc/pdf',
      pages: [
        {
          id: 'page-1',
          original: { width: 12, height: 16, mime: 'image/jpeg' },
          rendered: { width: 12, height: 16, mime: 'image/jpeg' },
          recipe: createDefaultPageRecipe({ kind: 'full-frame' }),
          engineVersion: 'test',
          recipeKey: 'test',
          outcome: { kind: 'not-requested' },
          originalUrl: '/api/v1/documents/abc/source',
          renderedUrl: '/api/v1/documents/abc/rendered',
          thumbnailUrl: '/api/v1/documents/abc/thumbnail',
        },
      ],
    });
    vi.spyOn(apiClient, 'apiBlob').mockResolvedValue(
      new Blob(['pdf'], { type: 'application/pdf' }),
    );
    render(<AccountApplication />);
    fireEvent.click(await screen.findByRole('button', { name: /Tài liệu đã lưu/u }));
    expect(get).toHaveBeenCalledOnce();
    expect(await screen.findByRole('heading', { name: 'Xem trước PDF' })).toBeInTheDocument();
  });
  it('requires authentication even for the comparison screen, then opens the personal library', async () => {
    vi.spyOn(accountApi, 'me').mockRejectedValue(new ApiError(401, 'Đăng nhập'));
    const list = vi
      .spyOn(documentApi, 'list')
      .mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 });
    vi.spyOn(accountApi, 'login').mockResolvedValue({ id: 'account', email: 'reader@example.com' });
    const first = render(<AccountApplication comparison={<p>Khu vực so sánh</p>} />);
    expect(await screen.findByRole('form', { name: 'Đăng nhập tài khoản' })).toBeInTheDocument();
    expect(screen.queryByText('Khu vực so sánh')).not.toBeInTheDocument();
    expect(list).not.toHaveBeenCalled();
    first.unmount();
    render(<AccountApplication />);
    await screen.findByRole('form', { name: 'Đăng nhập tài khoản' });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'reader@example.com' } });
    fireEvent.change(screen.getByLabelText('Mật khẩu'), { target: { value: 'correct password' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Đăng nhập tài khoản' }));
    expect(await screen.findByRole('heading', { name: 'Tài liệu của tôi' })).toBeInTheDocument();
    expect(await screen.findByText('Chưa có tài liệu nào')).toBeInTheDocument();
    expect(list).toHaveBeenCalled();
  });

  it('reports a server outage separately from an unauthenticated account', async () => {
    vi.spyOn(accountApi, 'me').mockRejectedValue(new Error('Không kết nối được máy chủ.'));
    render(<AccountApplication />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Không kết nối được máy chủ.');
    expect(screen.queryByLabelText('Mật khẩu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Kết nối lại' })).toBeInTheDocument();
  });
});
