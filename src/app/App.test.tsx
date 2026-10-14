import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScannerEngine } from '../imaging/contracts/scanner-engine';
import type { CameraCapture } from '../features/camera/camera-capture';
import type { CameraService } from '../features/camera/camera-service';
import type {
  BackgroundPageProcessor,
  ProcessedScanPage,
} from '../features/scanner/background-page-processor';
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
  it('opens the scan preparation view and returns to the library', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu quét' }));

    expect(screen.getByRole('heading', { name: 'Sẵn sàng mở camera' })).toBeInTheDocument();
    expect(
      screen.getByText('Camera chỉ được yêu cầu sau khi bạn chủ động cho phép.'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Quay lại thư viện' }));

    expect(
      screen.getByRole('heading', { name: 'Scan rõ từng nét. PDF sẵn sàng cho OCR.' }),
    ).toBeInTheDocument();
  });

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
    expect(screen.getByText('Ảnh không được tải lên máy chủ.')).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu quét' }));
    fireEvent.change(screen.getByLabelText('Chọn ảnh từ thư viện'), {
      target: { files: [new File(['image'], 'page.png', { type: 'image/png' })] },
    });

    expect(
      await screen.findByRole('heading', { name: 'Chỉnh chất lượng trang' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText('Scanic chưa đủ chắc chắn nên giữ toàn bộ ảnh.'),
    ).toBeInTheDocument();
  });

  it('captures multiple pages while background processing continues and opens one batch', async () => {
    const stream = {
      getTracks: () => [],
      getVideoTracks: () => [{} as MediaStreamTrack],
    } as unknown as MediaStream;
    const cameraService: CameraService = {
      lifecycle: { kind: 'idle' },
      start: vi.fn(() => Promise.resolve({ stream, stop: vi.fn() })),
      stop: vi.fn(),
    };
    const first = new Blob(['first'], { type: 'image/jpeg' });
    const second = new Blob(['second'], { type: 'image/jpeg' });
    const capture = vi
      .fn<CameraCapture['capture']>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    let nextPage = 0;
    const enqueue = vi.fn<BackgroundPageProcessor['enqueue']>(
      (source, _captureDetection, _signal, onStart) => {
        onStart?.();
        nextPage++;
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
      },
    );
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
    render(
      <App
        cameraService={cameraService}
        cameraCapture={{ capture }}
        cameraEngineFactory={() => cameraEngine}
        cameraFrameSourceFactory={() => ({
          capture: () => ({ dimensions: { width: 100, height: 100 }, close: vi.fn() }),
          dispose: vi.fn(),
        })}
        pageProcessorFactory={() => pageProcessor}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu quét' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cho phép camera' }));
    await screen.findByRole('heading', { name: 'Camera đã sẵn sàng' });

    fireEvent.click(screen.getByRole('button', { name: 'Chụp tài liệu' }));
    await waitFor(() => {
      expect(enqueue).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Chụp tài liệu' }));
    await waitFor(() => {
      expect(enqueue).toHaveBeenCalledTimes(2);
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Hoàn tất chụp 2 trang' }));
    expect(await screen.findByRole('heading', { name: 'Kiểm tra 2 trang' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tải PDF 2 trang' })).toBeEnabled();
  });
});
