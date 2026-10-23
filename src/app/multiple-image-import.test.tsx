import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BackgroundPageProcessor,
  ProcessedScanPage,
} from '../features/scanner/background-page-processor';
import {
  createBackgroundPageProcessor,
  createDefaultPageRecipe,
} from '../features/scanner/background-page-processor';
import type { ScannerEngine } from '../imaging/contracts/scanner-engine';
import { App } from './App';

function processed(source: Blob): ProcessedScanPage {
  const original = { blob: source, dimensions: { width: 900, height: 1200 } };
  const crop = { kind: 'full-frame' as const };
  return {
    original,
    crop,
    recipe: createDefaultPageRecipe(crop),
    variant: {
      recipeKey: 'test',
      engineVersion: 'test',
      image: original,
      dewarp: { kind: 'not-requested' },
    },
  };
}

function setup(enqueue: BackgroundPageProcessor['enqueue']) {
  const processor: BackgroundPageProcessor = { enqueue, dispose: () => Promise.resolve() };
  return render(<App pageProcessorFactory={() => processor} restorationClient={null} />);
}

function select(files: File[]) {
  fireEvent.change(screen.getByLabelText('Dùng ảnh có sẵn'), { target: { files } });
}

const createObjectUrl = vi.fn<(blob: Blob) => string>();
beforeEach(() => {
  createObjectUrl
    .mockReset()
    .mockImplementation((blob) => (blob instanceof File ? `blob:${blob.name}` : 'blob:multi-test'));
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: createObjectUrl,
    revokeObjectURL: vi.fn(),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('multiple library images', () => {
  it('allows multiple files and retains their order even if results complete out of order', async () => {
    const files = ['third.png', 'first.png', 'second.png'].map(
      (name) => new File(['image'], name, { type: 'image/png' }),
    );
    const complete: ((page: ProcessedScanPage) => void)[] = [];
    const enqueue = vi.fn<BackgroundPageProcessor['enqueue']>(
      () => new Promise((resolve) => complete.push(resolve)),
    );
    setup(enqueue);
    const input = screen.getByLabelText('Dùng ảnh có sẵn');
    expect(input).toHaveAttribute('multiple');
    select(files);
    expect(await screen.findByRole('heading', { name: 'Kiểm tra 3 trang' })).toBeInTheDocument();
    expect(enqueue.mock.calls.map((call) => call[0])).toEqual(files);
    expect(screen.getByRole('button', { name: 'Tải PDF 3 trang' })).toBeDisabled();
    for (const index of [2, 0, 1]) {
      const file = files[index];
      const done = complete[index];
      if (file === undefined || done === undefined) throw new Error('Missing pending image.');
      done(processed(file));
    }
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Tải PDF 3 trang' })).toBeEnabled();
    });
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      expect.stringContaining('Trang 1'),
      expect.stringContaining('Trang 2'),
      expect.stringContaining('Trang 3'),
    ]);
    expect(screen.getByAltText('Bản xem trước trang 1')).toHaveAttribute('src', 'blob:third.png');
    fireEvent.click(screen.getByRole('button', { name: 'Trang kế tiếp' }));
    expect(screen.getByAltText('Bản xem trước trang 2')).toHaveAttribute('src', 'blob:first.png');
  });

  it('keeps successful pages when one image fails and permits removing the failed page', async () => {
    const files = [new File(['good'], 'good.png'), new File(['bad'], 'bad.png')];
    const enqueue = vi.fn<BackgroundPageProcessor['enqueue']>((source) =>
      source === files[1]
        ? Promise.reject(new Error('invalid image'))
        : Promise.resolve(processed(source as Blob)),
    );
    setup(enqueue);
    select(files);
    expect(await screen.findByText('Cần xử lý lại')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tải PDF 2 trang' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Chọn trang 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Xóa trang 2' }));
    expect(screen.getByRole('button', { name: 'Tải PDF 1 trang' })).toBeEnabled();
  });

  it('ignores a cancelled selection and refuses oversized selections before enqueueing', () => {
    const enqueue = vi.fn<BackgroundPageProcessor['enqueue']>();
    setup(enqueue);
    select([]);
    expect(screen.getByRole('heading', { name: 'Tài liệu của tôi' })).toBeInTheDocument();
    select(Array.from({ length: 21 }, () => new File(['image'], 'page.png')));
    expect(screen.getByRole('alert')).toHaveTextContent('Tối đa 20 ảnh mỗi lần');
    expect(enqueue).not.toHaveBeenCalled();
    const large = new File(['image'], 'large.png');
    Object.defineProperty(large, 'size', { value: 140 * 1024 * 1024 });
    select([large, large]);
    expect(screen.getByRole('alert')).toHaveTextContent('256 MiB');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('aborts all imported page jobs on unmount', () => {
    const enqueue = vi.fn<BackgroundPageProcessor['enqueue']>(() => new Promise(() => undefined));
    const view = setup(enqueue);
    select([new File(['1'], 'one.png'), new File(['2'], 'two.png')]);
    const signals = enqueue.mock.calls.map((call) => call[1]);
    view.unmount();
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('cancels pending imported pages when returning home and accepts the same files again', () => {
    const enqueue = vi.fn<BackgroundPageProcessor['enqueue']>(() => new Promise(() => undefined));
    setup(enqueue);
    const files = [new File(['1'], 'one.png'), new File(['2'], 'two.png')];
    select(files);
    const signals = enqueue.mock.calls.map((call) => call[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Trang chủ' }));
    expect(screen.getByRole('heading', { name: 'Tài liệu của tôi' })).toBeInTheDocument();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    select(files);
    expect(screen.getByRole('heading', { name: 'Kiểm tra 2 trang' })).toBeInTheDocument();
    expect(enqueue).toHaveBeenCalledTimes(4);
  });

  it('retires a stalled detector when leaving so a new import can finish immediately', async () => {
    const engines: ScannerEngine[] = [];
    let rejectDetection: ((error: Error) => void) | undefined;
    const engineFactory = (): ScannerEngine => {
      const stalled = engines.length === 0;
      const engine: ScannerEngine = {
        lifecycle: { kind: 'ready' },
        initialize: () => Promise.resolve(),
        detect: vi.fn<ScannerEngine['detect']>((frame) =>
          stalled
            ? new Promise((_resolve, reject) => {
                rejectDetection = reject;
              })
            : Promise.resolve({
                kind: 'full-frame',
                dimensions: frame.dimensions,
                reason: 'no-document',
              }),
        ),
        render: (request) => Promise.resolve(processed(request.original.blob).variant),
        dispose: vi.fn(() => {
          rejectDetection?.(new Error('Retired'));
          return Promise.resolve();
        }),
      };
      engines.push(engine);
      return engine;
    };
    const factory = () =>
      createBackgroundPageProcessor({
        importer: (source) => Promise.resolve({ original: processed(source).original }),
        engineFactory,
        frameSource: {
          create: () =>
            Promise.resolve({ dimensions: { width: 900, height: 1200 }, close: () => undefined }),
        },
      });
    render(<App pageProcessorFactory={factory} restorationClient={null} />);
    const files = [new File(['1'], 'one.png'), new File(['2'], 'two.png')];
    select(files);
    await waitFor(() => {
      expect(rejectDetection).toBeDefined();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Trang chủ' }));
    select(files);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Tải PDF 2 trang' })).toBeEnabled();
    });
    expect(engines).toHaveLength(2);
  });
});
