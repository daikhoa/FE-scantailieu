import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createImagePdf } from '../export/image-pdf';
import type { ScanBatchPage } from './scan-batch';
import { ScanBatchReview } from './ScanBatchReview';

type ReadyScanBatchPage = Extract<ScanBatchPage, { readonly kind: 'ready' }>;

function readyPage(id: string, label: string): ReadyScanBatchPage {
  const source = new Blob([`source-${label}`], { type: 'image/jpeg' });
  const original = { blob: source, dimensions: { width: 1200, height: 1600 } };
  const crop = { kind: 'full-frame' as const };
  const recipe = {
    version: 1,
    crop,
    rotation: 0 as const,
    dewarp: { mode: 'perspective-only' as const },
    filter: {
      mode: 'ocr-color' as const,
      presetVersion: 'ocr-color-v3',
      parameters: {},
    },
  };
  return {
    id,
    source,
    captureDetection: null,
    kind: 'ready',
    page: {
      original,
      crop,
      recipe,
      variant: {
        recipeKey: label,
        engineVersion: 'test',
        image: {
          blob: new Blob([`processed-${label}`], { type: 'image/png' }),
          dimensions: original.dimensions,
        },
        dewarp: { kind: 'not-requested' },
      },
    },
  };
}

beforeEach(() => {
  let nextUrl = 0;
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:batch-${String(++nextUrl)}`),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ScanBatchReview', () => {
  it('shows pages in capture order with honest processing and failure actions', () => {
    const onRetryPage = vi.fn();
    const onRemovePage = vi.fn();
    const pages: readonly ScanBatchPage[] = [
      readyPage('page-1', 'first'),
      {
        id: 'page-2',
        source: new Blob(['two'], { type: 'image/jpeg' }),
        captureDetection: null,
        kind: 'processing',
      },
      {
        id: 'page-3',
        source: new Blob(['three'], { type: 'image/jpeg' }),
        captureDetection: null,
        kind: 'failed',
      },
    ];

    render(
      <ScanBatchReview
        pages={pages}
        headingRef={null}
        onCaptureMore={vi.fn()}
        onEditPage={vi.fn()}
        onRetryPage={onRetryPage}
        onRemovePage={onRemovePage}
      />,
    );

    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      expect.stringContaining('Trang 1'),
      expect.stringContaining('Trang 2Đang xử lý'),
      expect.stringContaining('Trang 3Cần xử lý lại'),
    ]);
    expect(screen.getByRole('button', { name: 'Tải PDF 3 trang' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Xử lý lại trang 3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Xóa trang 3' }));
    expect(onRetryPage).toHaveBeenCalledWith('page-3');
    expect(onRemovePage).toHaveBeenCalledWith('page-3');
  });

  it('exports every ready page once in capture order', async () => {
    const pages = [readyPage('page-1', 'first'), readyPage('page-2', 'second')] as const;
    const pdf = new Blob(['pdf'], { type: 'application/pdf' });
    const pdfExporter = vi.fn<typeof createImagePdf>(() => Promise.resolve(pdf));
    const download = vi.fn();
    render(
      <ScanBatchReview
        pages={pages}
        headingRef={null}
        onCaptureMore={vi.fn()}
        onEditPage={vi.fn()}
        onRetryPage={vi.fn()}
        onRemovePage={vi.fn()}
        pdfExporter={pdfExporter}
        download={download}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Tải PDF 2 trang' }));

    await waitFor(() => {
      expect(pdfExporter).toHaveBeenCalledOnce();
    });
    expect(pdfExporter.mock.calls[0]?.[0]).toEqual([
      pages[0].page.variant.image,
      pages[1].page.variant.image,
    ]);
    expect(download).toHaveBeenCalledWith(pdf, 'clonecamscanner.pdf');
  });

  it('lets the user return to the camera or edit a ready page', () => {
    const onCaptureMore = vi.fn();
    const onEditPage = vi.fn();
    const onRemovePage = vi.fn();
    render(
      <ScanBatchReview
        pages={[readyPage('page-1', 'first')]}
        headingRef={null}
        onCaptureMore={onCaptureMore}
        onEditPage={onEditPage}
        onRetryPage={vi.fn()}
        onRemovePage={onRemovePage}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Chụp thêm trang' }));
    fireEvent.click(screen.getByRole('button', { name: 'Chỉnh trang 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Xóa trang 1' }));
    expect(onCaptureMore).toHaveBeenCalledOnce();
    expect(onEditPage).toHaveBeenCalledWith('page-1');
    expect(onRemovePage).toHaveBeenCalledWith('page-1');
  });
});
