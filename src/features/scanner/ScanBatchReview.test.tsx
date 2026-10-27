import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EditRecipe } from '../../domain/document';
import { createImagePdf } from '../export/image-pdf';
import type { ScanBatchPage } from './scan-batch';
import { ScanBatchReview } from './ScanBatchReview';

type ReadyScanBatchPage = Extract<ScanBatchPage, { readonly kind: 'ready' }>;

let createObjectUrl = vi.fn<(blob: Blob) => string>();

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
  createObjectUrl = vi.fn(() => `blob:batch-${String(++nextUrl)}`);
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: createObjectUrl,
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ScanBatchReview', () => {
  it('shows one selected page at a time and moves through the document in capture order', () => {
    const pages = [readyPage('page-1', 'first'), readyPage('page-2', 'second')] as const;
    render(
      <ScanBatchReview
        pages={pages}
        headingRef={null}
        onCaptureMore={vi.fn()}
        onApplyRecipe={vi.fn(() => Promise.resolve())}
        onRetakePage={vi.fn()}
        onRetryPage={vi.fn()}
        onRemovePage={vi.fn()}
      />,
    );

    expect(screen.getByText('1 / 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Trang kế tiếp' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Trang kế tiếp' }));
    expect(screen.getByText('2 / 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Trang trước' })).toBeEnabled();
  });

  it('applies a filter and opens four-corner crop for the selected page', async () => {
    const page = readyPage('page-1', 'first');
    const onApplyRecipe = vi.fn<(id: string, recipe: EditRecipe) => Promise<void>>(() =>
      Promise.resolve(),
    );
    render(
      <ScanBatchReview
        pages={[page]}
        headingRef={null}
        onCaptureMore={vi.fn()}
        onApplyRecipe={onApplyRecipe}
        onRetakePage={vi.fn()}
        onRetryPage={vi.fn()}
        onRemovePage={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Xám' }));
    await waitFor(() => {
      expect(onApplyRecipe).toHaveBeenCalledOnce();
    });
    expect(onApplyRecipe.mock.calls[0]?.[0]).toBe('page-1');
    expect(onApplyRecipe.mock.calls[0]?.[1].filter).toEqual({
      mode: 'grayscale',
      presetVersion: 'grayscale-v7',
      parameters: {},
    });

    fireEvent.click(screen.getByRole('button', { name: 'Tăng cường' }));
    await waitFor(() => {
      expect(onApplyRecipe).toHaveBeenCalledTimes(2);
    });
    expect(onApplyRecipe.mock.calls[1]?.[1]).toEqual({
      ...page.page.recipe,
      filter: {
        mode: 'enhanced-color',
        presetVersion: 'enhanced-color-v6-adaptive',
        parameters: {},
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Cắt trang 1' }));
    expect(screen.getByRole('heading', { name: 'Điều chỉnh 4 góc' })).toBeInTheDocument();
    expect(screen.getAllByRole('slider')).toHaveLength(4);
  });

  it('shows pages in capture order with honest processing and failure actions', () => {
    const onRetryPage = vi.fn();
    const onRemovePage = vi.fn();
    const pages: readonly ScanBatchPage[] = [
      readyPage('page-1', 'first'),
      {
        id: 'page-2',
        source: new Blob(['two'], { type: 'image/jpeg' }),
        kind: 'processing',
      },
      {
        id: 'page-3',
        source: new Blob(['three'], { type: 'image/jpeg' }),
        kind: 'failed',
      },
    ];

    render(
      <ScanBatchReview
        pages={pages}
        headingRef={null}
        onCaptureMore={vi.fn()}
        onApplyRecipe={vi.fn(() => Promise.resolve())}
        onRetakePage={vi.fn()}
        onRetryPage={onRetryPage}
        onRemovePage={onRemovePage}
      />,
    );

    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      expect.stringContaining('Trang 1'),
      expect.stringContaining('Trang 2Đang hoàn thiện'),
      expect.stringContaining('Trang 3Cần xử lý lại'),
    ]);
    expect(screen.getByRole('button', { name: 'Xem PDF 3 trang' })).toBeDisabled();
    expect(screen.getAllByAltText(/Bản xem trước trang/u)).toHaveLength(1);
    expect(createObjectUrl).toHaveBeenCalledOnce();

    const preview = screen.getByAltText('Bản xem trước trang 1');
    expect(preview).toHaveAttribute('width', '1200');
    expect(preview).toHaveAttribute('height', '1600');

    fireEvent.click(screen.getByRole('button', { name: 'Chọn trang 3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Xử lý lại trang 3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Xóa trang 3' }));
    expect(onRetryPage).toHaveBeenCalledWith('page-3');
    expect(onRemovePage).toHaveBeenCalledWith('page-3');
  });

  it('prepares every ready page in capture order, then waits for a separate download gesture', async () => {
    const pages = [readyPage('page-1', 'first'), readyPage('page-2', 'second')] as const;
    const pdf = new Blob(['pdf'], { type: 'application/pdf' });
    const pdfExporter = vi.fn<typeof createImagePdf>(() => Promise.resolve(pdf));
    const download = vi.fn();
    render(
      <ScanBatchReview
        pages={pages}
        headingRef={null}
        onCaptureMore={vi.fn()}
        onApplyRecipe={vi.fn(() => Promise.resolve())}
        onRetakePage={vi.fn()}
        onRetryPage={vi.fn()}
        onRemovePage={vi.fn()}
        pdfExporter={pdfExporter}
        download={download}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Xem PDF 2 trang' }));

    await waitFor(() => {
      expect(pdfExporter).toHaveBeenCalledOnce();
    });
    expect(pdfExporter.mock.calls[0]?.[0]).toEqual([
      pages[0].page.variant.image,
      pages[1].page.variant.image,
    ]);
    expect(download).not.toHaveBeenCalled();
    expect(await screen.findByRole('heading', { name: 'Xem trước PDF' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('link', { name: 'Tải PDF' }));
    expect(download).toHaveBeenCalledWith(pdf, 'clonecamscanner.pdf');
  });

  it('waits for local AI restoration before exporting the PDF', () => {
    const page = readyPage('page-1', 'first');
    const processingPage: ReadyScanBatchPage = {
      ...page,
      page: { ...page.page, restoration: { kind: 'processing' } },
    };

    render(
      <ScanBatchReview
        pages={[processingPage]}
        headingRef={null}
        onCaptureMore={vi.fn()}
        onApplyRecipe={vi.fn(() => Promise.resolve())}
        onRetakePage={vi.fn()}
        onRetryPage={vi.fn()}
        onRemovePage={vi.fn()}
      />,
    );

    expect(screen.getByText('Đang hoàn thiện trên thiết bị')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Xem PDF 1 trang' })).toBeDisabled();
  });

  it('shows actionable quality warnings returned by the classifier', () => {
    const page = readyPage('page-1', 'first');
    const warnedPage: ReadyScanBatchPage = {
      ...page,
      page: {
        ...page.page,
        restoration: {
          kind: 'classified-local',
          classifierModel: 'defects@1',
          warnings: ['retake-finger', 'unsupported-moire'],
        },
      },
    };

    render(
      <ScanBatchReview
        pages={[warnedPage]}
        headingRef={null}
        onCaptureMore={vi.fn()}
        onApplyRecipe={vi.fn(() => Promise.resolve())}
        onRetakePage={vi.fn()}
        onRetryPage={vi.fn()}
        onRemovePage={vi.fn()}
      />,
    );

    expect(screen.getByText('Tay đang che tài liệu — nên chụp lại trang này.')).toBeInTheDocument();
    expect(
      screen.getByText('Có vân moiré — bộ xử lý hiện tại chưa khử hoàn toàn.'),
    ).toBeInTheDocument();
  });

  it('lets the user return to the camera, retake or remove the selected page', () => {
    const onCaptureMore = vi.fn();
    const onRetakePage = vi.fn();
    const onRemovePage = vi.fn();
    render(
      <ScanBatchReview
        pages={[readyPage('page-1', 'first')]}
        headingRef={null}
        onCaptureMore={onCaptureMore}
        onApplyRecipe={vi.fn(() => Promise.resolve())}
        onRetakePage={onRetakePage}
        onRetryPage={vi.fn()}
        onRemovePage={onRemovePage}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Chụp thêm trang' }));
    fireEvent.click(screen.getByRole('button', { name: 'Chụp lại trang 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Xóa trang 1' }));
    expect(onCaptureMore).toHaveBeenCalledOnce();
    expect(onRetakePage).toHaveBeenCalledWith('page-1');
    expect(onRemovePage).toHaveBeenCalledWith('page-1');
  });

  it('shows an actionable empty state after every page is removed', () => {
    const onCaptureMore = vi.fn();
    render(
      <ScanBatchReview
        pages={[]}
        headingRef={null}
        onCaptureMore={onCaptureMore}
        onApplyRecipe={vi.fn(() => Promise.resolve())}
        onRetakePage={vi.fn()}
        onRetryPage={vi.fn()}
        onRemovePage={vi.fn()}
      />,
    );

    expect(screen.getByText('Chưa còn trang nào')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Chụp trang mới' }));
    expect(onCaptureMore).toHaveBeenCalledOnce();
  });
});
