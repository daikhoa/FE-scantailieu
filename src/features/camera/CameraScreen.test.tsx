import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef, type ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ScannerEngine } from '../../imaging/contracts/scanner-engine';
import type { VideoFrameSource } from '../scanner/video-frame-source';
import type { CameraCapture } from './camera-capture';
import type { CameraService } from './camera-service';
import { CameraServiceError } from './camera-service';
import { CameraScreen } from './CameraScreen';
import { ImageImportError, type ImageImporter, type ImportedImage } from './image-import';

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve(value: T) {
      if (resolve === undefined) throw new Error('Deferred was not initialized.');
      resolve(value);
    },
  };
}

function fakeService(start: CameraService['start']): CameraService {
  return {
    lifecycle: { kind: 'idle' },
    start,
    stop: vi.fn(),
  };
}

function renderCamera(
  service: CameraService,
  onBack = vi.fn(),
  props: Partial<
    Omit<ComponentProps<typeof CameraScreen>, 'service' | 'headingRef' | 'onBack'>
  > = {},
) {
  return {
    onBack,
    ...render(
      <CameraScreen
        service={service}
        headingRef={createRef<HTMLHeadingElement>()}
        onBack={onBack}
        {...props}
      />,
    ),
  };
}

function importedImage(blob: Blob): ImportedImage {
  return { original: { blob, dimensions: { width: 1200, height: 800 } } };
}

describe('CameraScreen', () => {
  it('requests camera only after the user presses the permission button', async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const start = vi.fn<CameraService['start']>(() => Promise.resolve({ stream, stop: vi.fn() }));
    const service = fakeService(start);
    renderCamera(service);

    expect(start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cho phép camera' }));

    expect(await screen.findByRole('heading', { name: 'Camera đã sẵn sàng' })).toBeInTheDocument();
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    expect(screen.getByText('Bạn sẽ tự bấm chụp từng trang.')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText('Hình ảnh trực tiếp từ camera')).toHaveProperty(
        'srcObject',
        stream,
      );
    });
    expect(screen.getByLabelText('Hình ảnh trực tiếp từ camera')).toHaveAttribute(
      'data-frame-fit',
      'contain',
    );
  });

  it('shows a busy state and prevents duplicate permission requests', () => {
    const pending = deferred<Awaited<ReturnType<CameraService['start']>>>();
    const start = vi.fn(() => pending.promise);
    renderCamera(fakeService(start));

    fireEvent.click(screen.getByRole('button', { name: 'Cho phép camera' }));

    const button = screen.getByRole('button', { name: 'Đang mở camera…' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(start).toHaveBeenCalledOnce();
  });

  it('gives specific recovery guidance and permits retry after denial', async () => {
    const start = vi
      .fn<CameraService['start']>()
      .mockRejectedValueOnce(new CameraServiceError('permission-denied'))
      .mockRejectedValueOnce(new CameraServiceError('busy'));
    renderCamera(fakeService(start));

    fireEvent.click(screen.getByRole('button', { name: 'Cho phép camera' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Hãy cho phép camera trong cài đặt trình duyệt rồi thử lại.',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Thử mở camera lại' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Camera có thể đang được ứng dụng khác sử dụng.',
    );
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('stops camera on explicit close, back navigation and unmount', async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const service = fakeService(() => Promise.resolve({ stream, stop: vi.fn() }));
    const stop = vi.spyOn(service, 'stop');
    const view = renderCamera(service);
    fireEvent.click(screen.getByRole('button', { name: 'Cho phép camera' }));
    await screen.findByRole('heading', { name: 'Camera đã sẵn sàng' });

    fireEvent.click(screen.getByRole('button', { name: 'Đóng camera' }));
    expect(stop).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Cho phép camera' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Quay lại thư viện' }));
    expect(stop).toHaveBeenCalledTimes(2);
    expect(view.onBack).toHaveBeenCalledOnce();

    view.unmount();
    expect(stop).toHaveBeenCalledTimes(3);
  });

  it('cancels a pending request on unmount without updating the removed screen', async () => {
    const pending = deferred<Awaited<ReturnType<CameraService['start']>>>();
    let operationSignal: AbortSignal | undefined;
    const service = fakeService((signal) => {
      operationSignal = signal;
      return pending.promise;
    });
    const stop = vi.spyOn(service, 'stop');
    const view = renderCamera(service);
    fireEvent.click(screen.getByRole('button', { name: 'Cho phép camera' }));

    view.unmount();

    await waitFor(() => {
      expect(operationSignal?.aborted).toBe(true);
    });
    expect(stop).toHaveBeenCalledOnce();
  });

  it('imports a library image after explicit selection and reports validated dimensions', async () => {
    const source = new File(['image'], 'receipt.png', { type: 'image/png' });
    const result = importedImage(source);
    const importer = vi.fn<ImageImporter>(() => Promise.resolve(result));
    const onImageImported = vi.fn();
    render(
      <CameraScreen
        service={fakeService(() => Promise.reject(new Error('camera not used')))}
        headingRef={createRef<HTMLHeadingElement>()}
        importer={importer}
        onImageImported={onImageImported}
        onBack={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Chọn ảnh từ thư viện'), {
      target: { files: [source] },
    });

    expect(await screen.findByRole('heading', { name: 'Ảnh đã sẵn sàng' })).toBeInTheDocument();
    expect(screen.getByText('1.200 × 800 px')).toBeInTheDocument();
    expect(importer).toHaveBeenCalledWith(source, expect.any(AbortSignal));
    expect(onImageImported).toHaveBeenCalledWith(result);
  });

  it('shows a safe import error and allows choosing another image', async () => {
    const importer = vi.fn<ImageImporter>(() =>
      Promise.reject(new ImageImportError('unsupported-type')),
    );
    render(
      <CameraScreen
        service={fakeService(() => Promise.reject(new Error('camera not used')))}
        headingRef={createRef<HTMLHeadingElement>()}
        importer={importer}
        onBack={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Chọn ảnh từ thư viện'), {
      target: { files: [new File(['heic'], 'photo.heic', { type: 'image/heic' })] },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Chỉ hỗ trợ ảnh JPEG, PNG hoặc WebP.',
    );
    expect(screen.getByLabelText('Chọn ảnh khác')).toBeInTheDocument();
  });

  it('connects Scanic preview detection to the live green document overlay', async () => {
    const stream = {
      getTracks: () => [],
      getVideoTracks: () => [{} as MediaStreamTrack],
    } as unknown as MediaStream;
    const detect = vi.fn<ScannerEngine['detect']>((frame) =>
      Promise.resolve({
        kind: 'document',
        dimensions: frame.dimensions,
        confidence: 0.92,
        corners: [
          { x: 10, y: 10 },
          { x: 90, y: 10 },
          { x: 90, y: 90 },
          { x: 10, y: 90 },
        ],
      }),
    );
    const engine: ScannerEngine = {
      lifecycle: { kind: 'uninitialized' },
      initialize: vi.fn(() => Promise.resolve()),
      detect,
      render: vi.fn(() => Promise.reject(new Error('not used'))),
      dispose: vi.fn(() => Promise.resolve()),
    };
    const source: VideoFrameSource = {
      capture: vi.fn(() => ({ dimensions: { width: 100, height: 100 }, close: vi.fn() })),
      dispose: vi.fn(),
    };
    renderCamera(
      fakeService(() => Promise.resolve({ stream, stop: vi.fn() })),
      vi.fn(),
      {
        engineFactory: () => engine,
        frameSourceFactory: () => source,
      },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cho phép camera' }));

    expect(await screen.findByText('Đã định khung tài liệu.')).toBeInTheDocument();
    expect(detect).toHaveBeenCalled();
  });

  it('removes a stale document overlay when live detection fails', async () => {
    const stream = {
      getTracks: () => [],
      getVideoTracks: () => [{} as MediaStreamTrack],
    } as unknown as MediaStream;
    let detections = 0;
    const detect = vi.fn<ScannerEngine['detect']>((frame) => {
      detections++;
      if (detections > 3) return Promise.reject(new Error('transient worker failure'));
      return Promise.resolve({
        kind: 'document',
        dimensions: frame.dimensions,
        confidence: 0.92,
        corners: [
          { x: 10, y: 10 },
          { x: 90, y: 10 },
          { x: 90, y: 90 },
          { x: 10, y: 90 },
        ],
      });
    });
    const engine: ScannerEngine = {
      lifecycle: { kind: 'uninitialized' },
      initialize: vi.fn(() => Promise.resolve()),
      detect,
      render: vi.fn(() => Promise.reject(new Error('not used'))),
      dispose: vi.fn(() => Promise.resolve()),
    };
    const source: VideoFrameSource = {
      capture: vi.fn(() => ({ dimensions: { width: 100, height: 100 }, close: vi.fn() })),
      dispose: vi.fn(),
    };
    renderCamera(
      fakeService(() => Promise.resolve({ stream, stop: vi.fn() })),
      vi.fn(),
      {
        engineFactory: () => engine,
        frameSourceFactory: () => source,
      },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cho phép camera' }));

    expect(await screen.findByText('Đã định khung tài liệu.')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Scanic tạm thời không nhận diện được',
    );
    expect(screen.queryByText('Đã định khung tài liệu.')).not.toBeInTheDocument();
    expect(screen.getByText('Giữ máy ổn định để định khung tài liệu.')).toBeInTheDocument();
  });

  it('captures a high-resolution photo and sends the validated original to the editor', async () => {
    const stream = {
      getTracks: () => [],
      getVideoTracks: () => [{} as MediaStreamTrack],
    } as unknown as MediaStream;
    const photo = new Blob(['captured'], { type: 'image/jpeg' });
    const image = importedImage(photo);
    const capture = vi.fn<CameraCapture['capture']>(() => Promise.resolve(photo));
    const cameraCapture: CameraCapture = { capture };
    const importer = vi.fn<ImageImporter>(() => Promise.resolve(image));
    const onImageImported = vi.fn();
    renderCamera(
      fakeService(() => Promise.resolve({ stream, stop: vi.fn() })),
      vi.fn(),
      {
        cameraCapture,
        importer,
        onImageImported,
      },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cho phép camera' }));
    await screen.findByRole('heading', { name: 'Camera đã sẵn sàng' });

    fireEvent.click(screen.getByRole('button', { name: 'Chụp tài liệu' }));

    await waitFor(() => {
      expect(onImageImported).toHaveBeenCalledWith({
        ...image,
        captureCrop: { kind: 'full-frame' },
      });
    });
    expect(capture).toHaveBeenCalledWith(
      stream,
      expect.any(HTMLVideoElement),
      expect.any(AbortSignal),
    );
    expect(importer).toHaveBeenCalledWith(photo, expect.any(AbortSignal));
  });

  it('keeps the camera open while captured pages are queued in the background', async () => {
    const stream = {
      getTracks: () => [],
      getVideoTracks: () => [{} as MediaStreamTrack],
    } as unknown as MediaStream;
    const stopCamera = vi.fn();
    const service: CameraService = {
      lifecycle: { kind: 'idle' },
      start: () => Promise.resolve({ stream, stop: vi.fn() }),
      stop: stopCamera,
    };
    const first = new Blob(['first'], { type: 'image/jpeg' });
    const second = new Blob(['second'], { type: 'image/jpeg' });
    const capture = vi
      .fn<CameraCapture['capture']>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const onPhotoCaptured = vi.fn<(source: Blob) => void>();
    const onFinishCapture = vi.fn();
    const view = renderCamera(service, vi.fn(), {
      cameraCapture: { capture },
      importer: vi.fn(() => Promise.reject(new Error('background processor owns import'))),
      onPhotoCaptured,
      onFinishCapture,
      batchStatus: { total: 0, processing: 0, failed: 0 },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cho phép camera' }));
    await screen.findByRole('heading', { name: 'Camera đã sẵn sàng' });

    fireEvent.click(screen.getByRole('button', { name: 'Chụp tài liệu' }));
    await waitFor(() => {
      expect(onPhotoCaptured).toHaveBeenCalledWith(first);
    });
    expect(screen.getByRole('heading', { name: 'Camera đã sẵn sàng' })).toBeInTheDocument();
    expect(stopCamera).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Chụp tài liệu' }));
    await waitFor(() => {
      expect(onPhotoCaptured).toHaveBeenCalledWith(second);
    });
    view.rerender(
      <CameraScreen
        service={service}
        headingRef={createRef<HTMLHeadingElement>()}
        onBack={vi.fn()}
        cameraCapture={{ capture }}
        onPhotoCaptured={onPhotoCaptured}
        onFinishCapture={onFinishCapture}
        batchStatus={{ total: 2, processing: 1, failed: 0 }}
      />,
    );

    expect(screen.getByRole('status', { name: 'Tiến độ chụp' })).toHaveTextContent(
      '2 trang · 1 đang xử lý',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Hoàn tất chụp 2 trang' }));
    expect(onFinishCapture).toHaveBeenCalledOnce();
    expect(stopCamera).toHaveBeenCalledOnce();
  });

  it('sends the live document frame as the final crop when the shutter is pressed', async () => {
    const stream = {
      getTracks: () => [],
      getVideoTracks: () => [{} as MediaStreamTrack],
    } as unknown as MediaStream;
    const detect = vi.fn<ScannerEngine['detect']>((frame) =>
      Promise.resolve({
        kind: 'document',
        dimensions: frame.dimensions,
        confidence: 0.92,
        corners: [
          { x: 10, y: 10 },
          { x: 90, y: 10 },
          { x: 90, y: 90 },
          { x: 10, y: 90 },
        ],
      }),
    );
    const engine: ScannerEngine = {
      lifecycle: { kind: 'uninitialized' },
      initialize: vi.fn(() => Promise.resolve()),
      detect,
      render: vi.fn(() => Promise.reject(new Error('not used'))),
      dispose: vi.fn(() => Promise.resolve()),
    };
    const source: VideoFrameSource = {
      capture: vi.fn(() => ({ dimensions: { width: 100, height: 100 }, close: vi.fn() })),
      dispose: vi.fn(),
    };
    const photo = new Blob(['captured'], { type: 'image/jpeg' });
    const image = {
      original: { blob: photo, dimensions: { width: 200, height: 100 } },
    };
    const onImageImported = vi.fn();
    renderCamera(
      fakeService(() => Promise.resolve({ stream, stop: vi.fn() })),
      vi.fn(),
      {
        engineFactory: () => engine,
        frameSourceFactory: () => source,
        cameraCapture: { capture: vi.fn(() => Promise.resolve(photo)) },
        importer: vi.fn(() => Promise.resolve(image)),
        onImageImported,
      },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cho phép camera' }));
    await screen.findByText('Đã định khung tài liệu.');
    fireEvent.click(screen.getByRole('button', { name: 'Chụp tài liệu' }));

    await waitFor(() => {
      expect(onImageImported).toHaveBeenCalledWith({
        ...image,
        captureCrop: {
          kind: 'document',
          corners: [
            { x: 60, y: 10 },
            { x: 140, y: 10 },
            { x: 140, y: 90 },
            { x: 60, y: 90 },
          ],
        },
      });
    });
  });
});
