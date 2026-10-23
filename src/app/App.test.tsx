import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScannerEngine } from '../imaging/contracts/scanner-engine';
import type { CameraCapture } from '../features/camera/camera-capture';
import type { CameraService } from '../features/camera/camera-service';
import { ImageImportError } from '../features/camera/image-import';
import type {
  BackgroundPageProcessor,
  ProcessedScanPage,
} from '../features/scanner/background-page-processor';
import type { LocalRestorationClient } from '../imaging/restoration/local-restoration-client';
import { App } from './App';

beforeEach(() => {
  let nextUrl = 0;
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:app-${String(++nextUrl)}`),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App shell', () => {
  it('runs restoration locally without a server opt-in toggle', () => {
    const restorationClient: LocalRestorationClient = {
      restore: vi.fn(() => Promise.reject(new Error('not used'))),
    };

    render(<App restorationClient={restorationClient} />);

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByText(/Ảnh không được tải lên máy chủ/)).toBeInTheDocument();
    expect(screen.getByText('AI cục bộ')).toBeInTheDocument();
  });

  it.each(['Chụp tài liệu', 'Chụp tài liệu mới'])(
    'opens the camera directly from %s',
    async (cameraAction) => {
      const stream = { getTracks: () => [] } as unknown as MediaStream;
      const start = vi.fn<CameraService['start']>(() => Promise.resolve({ stream, stop: vi.fn() }));
      render(
        <App
          cameraService={{
            lifecycle: { kind: 'idle' },
            start,
            stop: vi.fn(),
          }}
        />,
      );

      expect(screen.getByRole('button', { name: 'Chụp tài liệu' })).toBeInTheDocument();
      expect(screen.getByLabelText('Dùng ảnh có sẵn')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: cameraAction }));

      expect(
        await screen.findByRole('heading', { name: 'Camera đã sẵn sàng' }),
      ).toBeInTheDocument();
      expect(start).toHaveBeenCalledOnce();
      expect(screen.queryByRole('button', { name: 'Cho phép camera' })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Thoát camera' }));

      expect(screen.getByRole('heading', { name: 'Tài liệu của tôi' })).toBeInTheDocument();
    },
  );

  it('announces the library loading state', () => {
    render(<App libraryState={{ kind: 'loading' }} />);

    expect(screen.getByRole('status')).toHaveTextContent('Đang mở thư viện tài liệu');
  });

  it('offers a retry action when the library cannot be opened', () => {
    const onRetryLibrary = vi.fn();
    render(
      <App
        libraryState={{
          kind: 'error',
          message: 'Trình duyệt chưa cho phép truy cập bộ nhớ cục bộ.',
        }}
        onRetryLibrary={onRetryLibrary}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Trình duyệt chưa cho phép truy cập bộ nhớ cục bộ.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Thử mở lại thư viện' }));

    expect(onRetryLibrary).toHaveBeenCalledOnce();
  });

  it('shows an honest empty state before the first scan', () => {
    render(<App />);

    expect(screen.getByText('Chưa có tài liệu nào')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Gần đây' })).toBeInTheDocument();
    expect(screen.getByText('0 tài liệu')).toBeInTheDocument();
    expect(screen.getByText(/Chức năng lưu tài liệu sẽ được bổ sung sau/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Tài liệu' })).toHaveAttribute(
      'href',
      '#library-title',
    );
    expect(
      screen.queryByRole('button', { name: /Word|PDF|Đăng nhập|Đăng ký/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Ảnh không được tải lên máy chủ/)).toBeInTheDocument();
  });

  it('continues from a validated library image into Scanic post-capture processing', async () => {
    const image = {
      original: {
        blob: new Blob(['source'], { type: 'image/png' }),
        dimensions: { width: 1200, height: 800 },
      },
    };
    const engine: ScannerEngine = {
      lifecycle: { kind: 'uninitialized' },
      initialize: vi.fn(() => Promise.resolve()),
      detect: vi.fn<ScannerEngine['detect']>(() =>
        Promise.resolve({
          kind: 'full-frame',
          dimensions: { width: 600, height: 400 },
          reason: 'low-confidence',
        }),
      ),
      render: vi.fn<ScannerEngine['render']>((request) =>
        Promise.resolve({
          recipeKey: 'app-test',
          engineVersion: 'test',
          image: {
            blob: new Blob(['output'], { type: 'image/png' }),
            dimensions: request.original.dimensions,
          },
          dewarp: { kind: 'not-requested' },
        }),
      ),
      dispose: vi.fn(() => Promise.resolve()),
    };
    render(
      <App
        imageImporter={() => Promise.resolve(image)}
        editorEngineFactory={() => engine}
        editorFrameSource={{
          create: () =>
            Promise.resolve({ dimensions: { width: 600, height: 400 }, close: vi.fn() }),
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText('Dùng ảnh có sẵn'), {
      target: { files: [new File(['image'], 'page.png', { type: 'image/png' })] },
    });

    expect(
      await screen.findByRole('heading', { name: 'Chỉnh chất lượng trang' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText('Scanic chưa đủ chắc chắn nên giữ toàn bộ ảnh.'),
    ).toBeInTheDocument();
  });

  it('keeps image import failures on the library with safe recovery guidance', async () => {
    render(<App imageImporter={() => Promise.reject(new ImageImportError('unsupported-type'))} />);

    fireEvent.change(screen.getByLabelText('Dùng ảnh có sẵn'), {
      target: { files: [new File(['not-an-image'], 'page.txt', { type: 'text/plain' })] },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Hỗ trợ JPEG, PNG, WebP, HEIC/HEIF và AVIF.',
    );
    expect(screen.getByRole('heading', { name: 'Tài liệu của tôi' })).toBeInTheDocument();
  });

  it('captures multiple pages while background processing continues and opens one batch', async () => {
    const stream = {
      getTracks: () => [],
      getVideoTracks: () => [{} as MediaStreamTrack],
    } as unknown as MediaStream;
    const startCamera = vi.fn(() => Promise.resolve({ stream, stop: vi.fn() }));
    const cameraService: CameraService = {
      lifecycle: { kind: 'idle' },
      start: startCamera,
      stop: vi.fn(),
    };
    const first = new Blob(['first'], { type: 'image/jpeg' });
    const second = new Blob(['second'], { type: 'image/jpeg' });
    const replacement = new Blob(['replacement'], { type: 'image/jpeg' });
    const capture = vi
      .fn<CameraCapture['capture']>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(replacement);
    let nextPage = 0;
    const enqueue = vi.fn<BackgroundPageProcessor['enqueue']>((source, _signal, onStart) => {
      onStart?.();
      nextPage++;
      const original = {
        blob: source instanceof Blob ? source : new Blob([source.pixels], { type: 'image/jpeg' }),
        dimensions: { width: 1200, height: 1600 },
      };
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
      const page: ProcessedScanPage = {
        original,
        crop,
        recipe,
        variant: {
          recipeKey: `page-${String(nextPage)}`,
          engineVersion: 'test',
          image: {
            blob: new Blob([`processed-${String(nextPage)}`], { type: 'image/png' }),
            dimensions: original.dimensions,
          },
          dewarp: { kind: 'not-requested' },
        },
      };
      return Promise.resolve(page);
    });
    const pageProcessor: BackgroundPageProcessor = {
      enqueue,
      dispose: vi.fn(() => Promise.resolve()),
    };
    const cameraEngine: ScannerEngine = {
      lifecycle: { kind: 'uninitialized' },
      initialize: vi.fn(() => Promise.resolve()),
      detect: vi.fn<ScannerEngine['detect']>((frame) =>
        Promise.resolve({
          kind: 'full-frame' as const,
          dimensions: frame.dimensions,
          reason: 'no-document' as const,
        }),
      ),
      render: vi.fn(() => Promise.reject(new Error('not used'))),
      dispose: vi.fn(() => Promise.resolve()),
    };
    const editorRender = vi.fn<ScannerEngine['render']>((request) =>
      Promise.resolve({
        recipeKey: `edited-${request.recipe.filter.mode}`,
        engineVersion: 'test-editor',
        image: {
          blob: new Blob(['edited'], { type: 'image/png' }),
          dimensions: request.original.dimensions,
        },
        dewarp: { kind: 'not-requested' },
      }),
    );
    const editorInitialize = vi.fn<ScannerEngine['initialize']>(() => Promise.resolve());
    const editorDispose = vi.fn<ScannerEngine['dispose']>(() => Promise.resolve());
    const editorEngine: ScannerEngine = {
      lifecycle: { kind: 'uninitialized' },
      initialize: editorInitialize,
      detect: vi.fn(() => Promise.reject(new Error('batch edits must not run detection again'))),
      render: editorRender,
      dispose: editorDispose,
    };
    const editorEngineFactory = vi.fn(() => editorEngine);
    const view = render(
      <App
        cameraService={cameraService}
        cameraCapture={{ capture }}
        cameraEngineFactory={() => cameraEngine}
        cameraFrameSourceFactory={() => ({
          capture: () => ({ dimensions: { width: 100, height: 100 }, close: vi.fn() }),
          dispose: vi.fn(),
        })}
        editorEngineFactory={editorEngineFactory}
        pageProcessorFactory={() => pageProcessor}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Chụp tài liệu' }));
    await screen.findByRole('heading', { name: 'Camera đã sẵn sàng' });

    fireEvent.click(screen.getByRole('button', { name: 'Chụp tài liệu' }));
    await waitFor(() => {
      expect(enqueue).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Chụp tài liệu' }));
    await waitFor(() => {
      expect(enqueue).toHaveBeenCalledTimes(2);
    });
    expect(enqueue.mock.calls[0]?.[3]).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: 'Hoàn tất chụp 2 trang' }));
    expect(await screen.findByRole('heading', { name: 'Kiểm tra 2 trang' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tải PDF 2 trang' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Chụp thêm trang' }));

    expect(await screen.findByRole('heading', { name: 'Camera đã sẵn sàng' })).toBeInTheDocument();
    expect(startCamera).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Cho phép camera' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Thoát camera' }));
    expect(await screen.findByRole('heading', { name: 'Kiểm tra 2 trang' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Chụp lại trang 1' }));
    await screen.findByRole('heading', { name: 'Camera đã sẵn sàng' });
    expect(screen.getByText('Chụp lại trang 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Hoàn tất chụp/u })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Chụp tài liệu' }));
    await waitFor(() => {
      expect(enqueue).toHaveBeenCalledTimes(3);
    });
    expect(enqueue.mock.calls[2]?.[0]).toBe(replacement);
    expect(await screen.findByRole('heading', { name: 'Kiểm tra 2 trang' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Xám' }));
    await waitFor(() => {
      expect(editorInitialize).toHaveBeenCalledOnce();
      expect(editorRender).toHaveBeenCalledOnce();
    });
    expect(editorRender.mock.calls[0]?.[0].recipe.filter.mode).toBe('grayscale');

    fireEvent.click(screen.getByRole('button', { name: 'Gốc' }));
    await waitFor(() => {
      expect(editorRender).toHaveBeenCalledTimes(2);
    });
    expect(editorEngineFactory).toHaveBeenCalledOnce();
    expect(editorInitialize).toHaveBeenCalledOnce();
    expect(editorDispose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cắt trang 1' }));
    expect(screen.getByRole('heading', { name: 'Điều chỉnh 4 góc' })).toBeInTheDocument();
    expect(screen.getAllByRole('slider')).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: 'Hủy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Chọn trang 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Xóa trang 2' }));
    expect(screen.getByRole('heading', { name: 'Kiểm tra 1 trang' })).toBeInTheDocument();

    view.unmount();
    await waitFor(() => {
      expect(editorDispose).toHaveBeenCalledOnce();
    });
  });
});
