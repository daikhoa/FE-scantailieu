import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

describe('library images share the camera batch flow', () => {
  it.each([false, true])(
    'waits for retirement before the next selection, including a cancelled waiting batch (%s)',
    async (cancelWaitingBatch) => {
      let finishRetirement!: () => void;
      const retirement = new Promise<void>((resolve) => {
        finishRetirement = resolve;
      });
      const first = new File(['first'], 'first.png');
      const second = new File(['second'], 'second.png');
      const third = new File(['third'], 'third.png');
      const importer = vi.fn((source: Blob) =>
        Promise.resolve({ original: processed(source).original }),
      );
      const engines: ScannerEngine[] = [];
      const view = render(
        <App
          restorationClient={null}
          imageImporter={importer}
          editorFrameSource={{
            create: () =>
              Promise.resolve({ dimensions: { width: 900, height: 1200 }, close: () => undefined }),
          }}
          editorEngineFactory={() => {
            const current: ScannerEngine = {
              lifecycle: { kind: 'ready' },
              initialize: () => Promise.resolve(),
              detect: (frame) =>
                Promise.resolve({
                  kind: 'full-frame',
                  dimensions: frame.dimensions,
                  reason: 'no-document',
                }),
              render: (request) => Promise.resolve(processed(request.original.blob).variant),
              dispose: vi.fn(() =>
                engines.indexOf(current) === 0 ? retirement : Promise.resolve(),
              ),
            };
            engines.push(current);
            return current;
          }}
        />,
      );
      try {
        select([first]);
        await waitFor(() =>
          expect(screen.getByRole('button', { name: 'Tải PDF 1 trang' })).toBeEnabled(),
        );
        fireEvent.click(screen.getByRole('button', { name: 'Trang chủ' }));
        select([second]);
        await act(async () => {
          await Promise.resolve();
        });
        expect(importer).toHaveBeenCalledTimes(1);
        expect(engines).toHaveLength(1);
        if (cancelWaitingBatch) {
          fireEvent.click(screen.getByRole('button', { name: 'Trang chủ' }));
          select([third]);
        }
        finishRetirement();
        await waitFor(() =>
          expect(screen.getByRole('button', { name: 'Tải PDF 1 trang' })).toBeEnabled(),
        );
        expect(importer).toHaveBeenCalledTimes(2);
        expect(importer).toHaveBeenLastCalledWith(
          cancelWaitingBatch ? third : second,
          expect.any(AbortSignal),
        );
        expect(engines).toHaveLength(2);
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      } finally {
        finishRetirement();
        view.unmount();
      }
    },
  );
  it.each([1, 2])(
    'processes %i selected images through the shared queue and review screen',
    async (count) => {
      const files = Array.from(
        { length: count },
        (_, index) => new File(['image'], `page-${String(index)}.png`, { type: 'image/png' }),
      );
      const enqueue = vi.fn<BackgroundPageProcessor['enqueue']>((source) =>
        Promise.resolve(processed(source as Blob)),
      );
      setup(enqueue);

      select(files);

      expect(
        await screen.findByRole('heading', { name: `Kiểm tra ${String(count)} trang` }),
      ).toBeInTheDocument();
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: `Tải PDF ${String(count)} trang` }),
        ).toBeEnabled();
      });
      expect(enqueue.mock.calls.map((call) => call[0])).toEqual(files);
      expect(screen.getByRole('button', { name: 'Tăng cường' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(
        screen.queryByRole('heading', { name: 'Chỉnh chất lượng trang' }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Chụp thêm trang' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: 'Cắt trang 1' }));
      expect(screen.getByRole('heading', { name: 'Điều chỉnh 4 góc' })).toBeInTheDocument();
    },
  );

  it('can retry a failed single imported image in the shared batch', async () => {
    const file = new File(['image'], 'page.png', { type: 'image/png' });
    const enqueue = vi
      .fn<BackgroundPageProcessor['enqueue']>()
      .mockRejectedValueOnce(new Error('Decode failed'))
      .mockResolvedValueOnce(processed(file));
    setup(enqueue);
    select([file]);
    expect(await screen.findByText('Cần xử lý lại')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tải PDF 1 trang' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Xử lý lại trang 1' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Tải PDF 1 trang' })).toBeEnabled();
    });
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls.map((call) => call[0])).toEqual([file, file]);
  });

  it('keeps an imported page and a new camera capture in the same batch', async () => {
    const file = new File(['imported'], 'page.png', { type: 'image/png' });
    const captured = new Blob(['captured'], { type: 'image/jpeg' });
    const enqueue = vi.fn<BackgroundPageProcessor['enqueue']>((source) =>
      Promise.resolve(processed(source as Blob)),
    );
    const cameraEngine: ScannerEngine = {
      lifecycle: { kind: 'ready' },
      initialize: () => Promise.resolve(),
      detect: (frame) =>
        Promise.resolve({
          kind: 'full-frame',
          dimensions: frame.dimensions,
          reason: 'no-document',
        }),
      render: () => Promise.reject(new Error('Live camera does not render pages')),
      dispose: () => Promise.resolve(),
    };
    const stream = {
      getTracks: () => [],
      getVideoTracks: () => [{} as MediaStreamTrack],
    } as unknown as MediaStream;
    render(
      <App
        restorationClient={null}
        pageProcessorFactory={() => ({ enqueue, dispose: () => Promise.resolve() })}
        cameraCapture={{ capture: () => Promise.resolve(captured) }}
        cameraService={{
          lifecycle: { kind: 'idle' },
          start: () => Promise.resolve({ stream, stop: () => undefined }),
          stop: () => undefined,
        }}
        cameraEngineFactory={() => cameraEngine}
        cameraFrameSourceFactory={() => ({
          capture: () => ({ dimensions: { width: 100, height: 100 }, close: () => undefined }),
          dispose: () => undefined,
        })}
      />,
    );
    select([file]);
    await screen.findByRole('heading', { name: 'Kiểm tra 1 trang' });
    fireEvent.click(screen.getByRole('button', { name: 'Chụp thêm trang' }));
    await screen.findByRole('heading', { name: 'Camera đã sẵn sàng' });
    fireEvent.click(screen.getByRole('button', { name: 'Chụp tài liệu' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Hoàn tất chụp 2 trang' }));
    expect(await screen.findByRole('heading', { name: 'Kiểm tra 2 trang' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Tải PDF 2 trang' })).toBeEnabled(),
    );
    expect(enqueue.mock.calls.map((call) => call[0])).toEqual([file, captured]);
  });

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

  it.each([1, 2])('aborts %i imported page jobs on unmount', (count) => {
    const enqueue = vi.fn<BackgroundPageProcessor['enqueue']>(() => new Promise(() => undefined));
    const view = setup(enqueue);
    select(
      Array.from({ length: count }, (_, index) => new File(['image'], `page-${String(index)}.png`)),
    );
    const signals = enqueue.mock.calls.map((call) => call[1]);
    view.unmount();
    expect(signals).toHaveLength(count);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('cancels pending imported pages when returning home and accepts the same files again', async () => {
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
    await waitFor(() => {
      expect(enqueue).toHaveBeenCalledTimes(4);
    });
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
