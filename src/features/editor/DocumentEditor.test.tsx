import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScannerEngine } from '../../imaging/contracts/scanner-engine';
import type { ImageAssetFrameSource } from '../scanner/image-asset-frame-source';
import { DocumentEditor } from './DocumentEditor';

function fakeEngine() {
  const initialize = vi.fn<ScannerEngine['initialize']>(() => Promise.resolve());
  const detect = vi.fn<ScannerEngine['detect']>(() =>
    Promise.resolve({
      kind: 'document',
      dimensions: { width: 600, height: 800 },
      confidence: 0.9,
      corners: [
        { x: 30, y: 40 },
        { x: 570, y: 40 },
        { x: 570, y: 760 },
        { x: 30, y: 760 },
      ],
    }),
  );
  const renderPage = vi.fn<ScannerEngine['render']>((request) =>
    Promise.resolve({
      recipeKey: `key-${request.recipe.filter.mode}`,
      engineVersion: 'test-engine',
      image: {
        blob: new Blob([request.recipe.filter.mode], { type: 'image/png' }),
        dimensions: request.original.dimensions,
      },
      dewarp: { kind: 'not-requested' },
    }),
  );
  const dispose = vi.fn<ScannerEngine['dispose']>(() => Promise.resolve());
  const engine: ScannerEngine = {
    lifecycle: { kind: 'uninitialized' },
    initialize,
    detect,
    render: renderPage,
    dispose,
  };
  return { engine, initialize, detect, renderPage, dispose };
}

const image = {
  original: {
    blob: new Blob(['original'], { type: 'image/png' }),
    dimensions: { width: 1200, height: 1600 },
  },
};

function fakeFrameSource(): ImageAssetFrameSource {
  return {
    create: vi.fn(() =>
      Promise.resolve({ dimensions: { width: 600, height: 800 }, close: vi.fn() }),
    ),
  };
}

let revokeObjectUrl = vi.fn();
let createObjectUrl = vi.fn<(blob: Blob) => string>();

beforeEach(() => {
  let nextUrl = 0;
  revokeObjectUrl = vi.fn();
  createObjectUrl = vi.fn(() => `blob:preview-${String(++nextUrl)}`);
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: createObjectUrl,
    revokeObjectURL: revokeObjectUrl,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DocumentEditor', () => {
  it('shows an already processed batch page immediately without rendering it again', async () => {
    const fixture = fakeEngine();
    const initialRecipe = {
      version: 1,
      crop: { kind: 'full-frame' as const },
      rotation: 0 as const,
      dewarp: { mode: 'perspective-only' as const },
      filter: {
        mode: 'grayscale' as const,
        presetVersion: 'grayscale-v7',
        parameters: {},
      },
    };
    const initialVariant = {
      recipeKey: 'already-processed',
      engineVersion: 'test-engine',
      image: {
        blob: new Blob(['processed'], { type: 'image/png' }),
        dimensions: image.original.dimensions,
      },
      dewarp: { kind: 'not-requested' as const },
    };

    render(
      <DocumentEditor
        image={image}
        initialPage={{ recipe: initialRecipe, variant: initialVariant }}
        engineFactory={() => fixture.engine}
        frameSource={fakeFrameSource()}
        onBack={vi.fn()}
        headingRef={null}
      />,
    );

    expect(screen.getByRole('img', { name: 'Bản xem trước tài liệu' })).toHaveAttribute(
      'src',
      'blob:preview-1',
    );
    expect(screen.getByRole('button', { name: 'Xám' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Đã áp dụng Xám');
    const initialize = fixture.initialize;
    await waitFor(() => {
      expect(initialize.mock.calls).toHaveLength(1);
    });
    expect(fixture.detect).not.toHaveBeenCalled();
    expect(fixture.renderPage).not.toHaveBeenCalled();
    expect(createObjectUrl).toHaveBeenCalledOnce();
  });

  it('keeps the crop frozen from the live guide at the moment of capture', async () => {
    const fixture = fakeEngine();
    const captureCrop = {
      kind: 'document' as const,
      corners: [
        { x: 120, y: 160 },
        { x: 1080, y: 160 },
        { x: 1080, y: 1440 },
        { x: 120, y: 1440 },
      ] as const,
    };
    render(
      <DocumentEditor
        image={{ ...image, captureCrop }}
        engineFactory={() => fixture.engine}
        frameSource={fakeFrameSource()}
        onBack={vi.fn()}
        headingRef={null}
      />,
    );

    await waitFor(() => {
      expect(fixture.renderPage).toHaveBeenCalledOnce();
    });
    expect(fixture.detect).not.toHaveBeenCalled();
    expect(fixture.renderPage.mock.calls[0]?.[0].recipe.crop).toEqual(captureCrop);
  });

  it('detects a library image and renders enhanced color by default and lets the user switch filters', async () => {
    const fixture = fakeEngine();
    const frameSource = fakeFrameSource();
    render(
      <DocumentEditor
        image={image}
        engineFactory={() => fixture.engine}
        frameSource={frameSource}
        onBack={vi.fn()}
        headingRef={null}
      />,
    );

    expect(screen.getByRole('img', { name: 'Bản xem trước tài liệu' })).toHaveAttribute(
      'src',
      'blob:preview-1',
    );
    await waitFor(() => {
      expect(fixture.renderPage).toHaveBeenCalledOnce();
    });
    const request = fixture.renderPage.mock.calls[0]?.[0];
    expect(request?.original).toBe(image.original);
    expect(request?.recipe).toEqual({
      version: 1,
      crop: {
        kind: 'document',
        corners: [
          { x: 60, y: 80 },
          { x: 1140, y: 80 },
          { x: 1140, y: 1520 },
          { x: 60, y: 1520 },
        ],
      },
      rotation: 0,
      dewarp: { mode: 'perspective-only' },
      filter: { mode: 'enhanced-color', presetVersion: 'enhanced-color-v1', parameters: {} },
    });
    expect(screen.getByRole('button', { name: 'Tăng cường' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText('Màu đậm, tương phản rõ hơn')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Bản xem trước tài liệu' })).toHaveAttribute(
      'src',
      'blob:preview-2',
    );
    expect(screen.getByRole('status')).toHaveTextContent('Đã áp dụng Tăng cường');

    fireEvent.click(screen.getByRole('button', { name: 'Tự động' }));
    await waitFor(() => {
      expect(fixture.renderPage).toHaveBeenCalledTimes(2);
    });
    expect(fixture.renderPage.mock.calls[1]?.[0].recipe.filter.mode).toBe('ocr-color');
    expect(screen.getByRole('button', { name: 'Tự động' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('uses the shadow-normalized preset version for black-and-white rendering', async () => {
    const fixture = fakeEngine();
    render(
      <DocumentEditor
        image={image}
        engineFactory={() => fixture.engine}
        frameSource={fakeFrameSource()}
        onBack={vi.fn()}
        headingRef={null}
      />,
    );
    await waitFor(() => {
      expect(fixture.renderPage).toHaveBeenCalledOnce();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Đen trắng' }));

    await waitFor(() => {
      expect(fixture.renderPage).toHaveBeenCalledTimes(2);
    });
    expect(fixture.renderPage.mock.calls[1]?.[0].recipe.filter).toEqual({
      mode: 'black-and-white',
      presetVersion: 'black-and-white-v5',
      parameters: {},
    });
  });

  it('reports processing failure safely and releases the engine and object URLs', async () => {
    const fixture = fakeEngine();
    fixture.renderPage.mockRejectedValueOnce(new Error('private pixel data'));
    const { unmount } = render(
      <DocumentEditor
        image={image}
        engineFactory={() => fixture.engine}
        frameSource={fakeFrameSource()}
        onBack={vi.fn()}
        headingRef={null}
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Không thể xử lý ảnh');
    expect(screen.queryByText('private pixel data')).not.toBeInTheDocument();
    unmount();
    expect(fixture.dispose).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:preview-1');
  });

  it('exports the currently processed page as a naturally sized PDF', async () => {
    const fixture = fakeEngine();
    const pdf = new Blob(['pdf'], { type: 'application/pdf' });
    const pdfExporter = vi.fn<
      (pages: readonly (typeof image.original)[], signal: AbortSignal) => Promise<Blob>
    >(() => Promise.resolve(pdf));
    const download = vi.fn<(blob: Blob, filename: string) => void>();
    render(
      <DocumentEditor
        image={image}
        engineFactory={() => fixture.engine}
        frameSource={fakeFrameSource()}
        pdfExporter={pdfExporter}
        download={download}
        onBack={vi.fn()}
        headingRef={null}
      />,
    );
    await screen.findByText('Đã nhận diện, cắt và làm thẳng tài liệu.');

    fireEvent.click(screen.getByRole('button', { name: 'Tải PDF' }));

    await waitFor(() => {
      expect(pdfExporter).toHaveBeenCalledOnce();
    });
    expect(pdfExporter.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ dimensions: image.original.dimensions }),
    ]);
    expect(download).toHaveBeenCalledWith(pdf, 'clonecamscanner.pdf');
  });
});
