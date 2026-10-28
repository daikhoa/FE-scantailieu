import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PdfShareButton } from './PdfShareButton';

afterEach(() => vi.unstubAllGlobals());

describe('sharing a saved PDF', () => {
  it('loads only on request and waits for a fresh gesture before sharing the actual file', async () => {
    const share = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { share, canShare: () => true });
    const load = vi.fn(() => Promise.resolve(new Blob(['%PDF-test'], { type: 'application/pdf' })));
    render(<PdfShareButton loadPdf={load} filename="saved.pdf" title="Saved" />);
    expect(load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Chuẩn bị chia sẻ PDF' }));
    expect(await screen.findByRole('status')).toHaveTextContent('PDF đã sẵn sàng');
    expect(share).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Chia sẻ / Lưu vào Tệp' }));
    expect(share).toHaveBeenCalledWith({ files: [expect.any(File)], title: 'Saved' });
  });

  it('reports a failed PDF fetch with an explicit retry instead of blocking the document', async () => {
    vi.stubGlobal('navigator', { share: vi.fn(), canShare: () => true });
    const load = vi.fn(() => Promise.reject(new Error('Không tải được PDF để chia sẻ.')));
    render(<PdfShareButton loadPdf={load} filename="saved.pdf" title="Saved" />);
    fireEvent.click(screen.getByRole('button', { name: 'Chuẩn bị chia sẻ PDF' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Không tải được PDF');
    expect(screen.getByRole('button', { name: 'Chuẩn bị chia sẻ PDF' })).toBeEnabled();
  });
});
