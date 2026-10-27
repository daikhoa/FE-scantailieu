import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineLifecycle, ScannerEngine } from '../imaging/contracts/scanner-engine';
import {
  createDefaultPageRecipe,
  type ProcessedScanPage,
} from '../features/scanner/background-page-processor';
import { App } from './App';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function engine() {
  let lifecycle: EngineLifecycle = { kind: 'uninitialized' };
  return {
    get lifecycle() {
      return lifecycle;
    },
    initialize: vi.fn<ScannerEngine['initialize']>(() => {
      lifecycle = { kind: 'ready' };
      return Promise.resolve();
    }),
    detect: vi.fn<ScannerEngine['detect']>((frame) =>
      Promise.resolve({
        kind: 'full-frame',
        dimensions: frame.dimensions,
        reason: 'no-document',
      }),
    ),
    render: vi.fn<ScannerEngine['render']>((request) =>
      Promise.resolve({
        recipeKey: request.recipe.filter.mode,
        engineVersion: 'test',
        image: request.original,
        dewarp: { kind: 'not-requested' },
      }),
    ),
    dispose: vi.fn<ScannerEngine['dispose']>(() => {
      lifecycle = { kind: 'disposed' };
      return Promise.resolve();
    }),
  };
}
const frameSource = () => ({
  capture: () => ({ dimensions: { width: 100, height: 100 }, close: vi.fn() }),
  dispose: vi.fn(),
});
function cameraService() {
  const stream = { getTracks: () => [] } as unknown as MediaStream;
  return {
    lifecycle: { kind: 'idle' as const },
    start: vi.fn(() => Promise.resolve({ stream, stop: vi.fn() })),
    stop: vi.fn(),
  };
}
beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:reentry');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});
afterEach(() => vi.useRealTimers());

describe('review to camera resource handoff', () => {
  it('releases the shared import/edit engine before opening camera without dropping the page', async () => {
    const source = new File(['source'], 'page.png', { type: 'image/png' });
    const original = { blob: source, dimensions: { width: 100, height: 100 } };
    const engines: ReturnType<typeof engine>[] = [];
    const retirement = deferred();
    const service = cameraService();
    const camera = engine();
    const cameraInitialize = vi.mocked(camera.initialize);
    cameraInitialize.mockImplementation(() => {
      if (engines.some((current) => current.lifecycle.kind !== 'disposed'))
        return Promise.reject(
          new Error('Retained processing runtimes exceed the camera startup budget.'),
        );
      return Promise.resolve();
    });
    render(
      <App
        restorationClient={null}
        imageImporter={() => Promise.resolve({ original })}
        editorFrameSource={{
          create: () => Promise.resolve({ dimensions: original.dimensions, close: vi.fn() }),
        }}
        editorEngineFactory={() => {
          const current = engine();
          const dispose = current.dispose;
          current.dispose = vi.fn(async () => {
            await retirement.promise;
            await dispose();
          });
          engines.push(current);
          return current;
        }}
        cameraEngineFactory={() => camera}
        cameraFrameSourceFactory={frameSource}
        cameraService={service}
      />,
    );
    try {
      fireEvent.change(screen.getByLabelText('Dùng ảnh có sẵn'), { target: { files: [source] } });
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Tải PDF 1 trang' })).toBeEnabled();
      });
      fireEvent.click(screen.getByRole('button', { name: 'Xám' }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Xám' })).toHaveAttribute('aria-pressed', 'true');
      });
      expect(engines).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: 'Chụp thêm trang' }));
      await waitFor(() => {
        expect(engines.every((current) => vi.mocked(current.dispose).mock.calls.length === 1)).toBe(
          true,
        );
      });
      expect(service.start).not.toHaveBeenCalled();
      retirement.resolve();
      await screen.findByText('Chưa thấy tài liệu — ảnh sẽ giữ toàn bộ khung.');
      expect(cameraInitialize).toHaveBeenCalledOnce();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Thoát camera' }));
      await screen.findByRole('heading', { name: 'Kiểm tra 1 trang' });
      expect(screen.getByRole('button', { name: 'Tải PDF 1 trang' })).toBeEnabled();
    } finally {
      retirement.resolve();
    }
  });

  it('waits for the previous camera teardown across review, Add and a new CameraScreen mount', async () => {
    const source = new Blob(['photo'], { type: 'image/jpeg' });
    const original = { blob: source, dimensions: { width: 100, height: 100 } };
    const page: ProcessedScanPage = {
      original,
      crop: { kind: 'full-frame' },
      recipe: createDefaultPageRecipe({ kind: 'full-frame' }),
      variant: {
        recipeKey: 'test',
        engineVersion: 'test',
        image: original,
        dewarp: { kind: 'not-requested' },
      },
    };
    const first = engine(),
      second = engine();
    const retirement = deferred();
    first.dispose = vi.fn(() => retirement.promise);
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValue(second);
    const service = cameraService();
    render(
      <App
        restorationClient={null}
        cameraService={service}
        cameraCapture={{ capture: () => Promise.resolve(source) }}
        cameraEngineFactory={factory}
        cameraFrameSourceFactory={frameSource}
        pageProcessorFactory={() => ({
          enqueue: () => Promise.resolve(page),
          dispose: () => Promise.resolve(),
        })}
      />,
    );
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Chụp tài liệu' }));
      await screen.findByText('Chưa thấy tài liệu — ảnh sẽ giữ toàn bộ khung.');
      fireEvent.click(screen.getByRole('button', { name: 'Chụp tài liệu' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Hoàn tất chụp 1 trang' }));
      await screen.findByRole('heading', { name: 'Kiểm tra 1 trang' });
      await waitFor(() => {
        expect(first.dispose).toHaveBeenCalledOnce();
      });
      vi.useFakeTimers();
      fireEvent.click(screen.getByRole('button', { name: 'Chụp thêm trang' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(service.start).toHaveBeenCalledTimes(1);
      expect(factory).toHaveBeenCalledOnce();
      retirement.resolve();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(service.start).toHaveBeenCalledTimes(2);
      expect(second.initialize).toHaveBeenCalledOnce();
    } finally {
      retirement.resolve();
      vi.useRealTimers();
    }
  });
});
