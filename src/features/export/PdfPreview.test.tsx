import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PdfPreview } from './PdfPreview';

const pdf = new Blob(['pdf'], { type: 'application/pdf' });
const pages = [{ id: 'page-1', image: 'preview.jpg' }];

beforeEach(() => {
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:pdf'),
    revokeObjectURL: vi.fn(),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PDF file actions', () => {
  it('prepares a saved file before offering download instead of silently using a local blob', async () => {
    const save = vi.fn(() => Promise.resolve());
    const download = vi.fn();
    const { rerender } = render(
      <PdfPreview pages={pages} pdf={pdf} onBack={vi.fn()} onSave={save} download={download} />,
    );
    fireEvent.click(screen.getByRole('link', { name: 'Tải PDF' }));
    await waitFor(() => {
      expect(save).toHaveBeenCalledOnce();
    });
    expect(download).not.toHaveBeenCalled();
    expect(await screen.findByText('PDF đã sẵn sàng. Bấm Tải PDF để lưu về máy.')).toBeVisible();
    rerender(
      <PdfPreview
        pages={pages}
        pdf={pdf}
        onBack={vi.fn()}
        onSave={save}
        fileUrl="/api/v1/documents/doc/pdf?revision=1"
      />,
    );
    expect(screen.getByRole('link', { name: 'Tải PDF' })).toHaveAttribute(
      'href',
      '/api/v1/documents/doc/pdf?revision=1&download=true',
    );
  });

  it('shows every PDF page immediately with edit and download actions for a saved document', () => {
    const save = vi.fn(() => Promise.resolve());
    const edit = vi.fn();
    render(
      <PdfPreview
        pages={[...pages, { id: 'page-2', image: 'page2.jpg' }]}
        pdf={pdf}
        onBack={vi.fn()}
        onSave={save}
        saved
        onEdit={edit}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Tài liệu PDF' })).toBeVisible();
    expect(screen.getAllByAltText(/Trang \d của PDF/u)).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Mở PDF' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Tải PDF' })).toBeVisible();
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Chỉnh sửa tài liệu' }));
    expect(edit).toHaveBeenCalledOnce();
  });

  it('keeps a failed save actionable without announcing a download', async () => {
    const save = vi.fn(() =>
      Promise.reject(new Error('Ảnh gốc trang 2: không đọc được nội dung ảnh.')),
    );
    render(<PdfPreview pages={pages} pdf={pdf} onBack={vi.fn()} onSave={save} />);
    fireEvent.click(screen.getByRole('link', { name: 'Tải PDF' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Ảnh gốc trang 2');
    expect(screen.queryByText(/PDF đã sẵn sàng/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/Đã yêu cầu trình duyệt/u)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Lưu thay đổi' })).toBeEnabled();
  });
});
