import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef, type ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ScannerEngine } from '../../imaging/contracts/scanner-engine';
import type { VideoFrameSource } from '../scanner/video-frame-source';
import type { CameraCapture } from './camera-capture';
import { CameraServiceError, type CameraService } from './camera-service';
import { CameraScreen } from './CameraScreen';

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
    Omit<
      ComponentProps<typeof CameraScreen>,
      'service' | 'headingRef' | 'onBack' | 'onPhotoCaptured'
    >
  > & { readonly onPhotoCaptured?: ComponentProps<typeof CameraScreen>['onPhotoCaptured'] } = {},
) {
  return {
    onBack,
    ...render(
      <CameraScreen
        service={service}
        headingRef={createRef<HTMLHeadingElement>()}
        onBack={onBack}
        onPhotoCaptured={vi.fn()}
        {...props}
      />,
    ),
  };
}

function detectionEngine(detect: ScannerEngine['detect']): ScannerEngine {
  return {
    lifecycle: { kind: 'uninitialized' },
    initialize: vi.fn(() => Promise.resolve()),
    detect,
    render: vi.fn(() => Promise.reject(new Error('not used'))),
    dispose: vi.fn(() => Promise.resolve()),
  };
}

function videoFrameSource(): VideoFrameSource {
  return {
    capture: vi.fn(() => ({ dimensions: { width: 100, height: 100 }, close: vi.fn() })),
    dispose: vi.fn(),
  };
}

describe('CameraScreen', () => {
  it('opens the camera immediately and connects its stream to the preview', async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const start = vi.fn<CameraService['start']>(() => Promise.resolve({ stream, stop: vi.fn() }));

    renderCamera(fakeService(start));

    expect(await screen.findByRole('heading', { name: 'Camera đã sẵn sàng' })).toBeInTheDocument();
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    expect(screen.queryByRole('button', { name: 'Cho phép camera' })).not.toBeInTheDocument();
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

  it('keeps the camera preview and capture controls together in a fullscreen scanner surface', async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const view = renderCamera(
      fakeService(() => Promise.resolve({ stream, stop: vi.fn() })),
      vi.fn(),
      {
        onPhotoCaptured: vi.fn(),
        onFinishCapture: vi.fn(),
        batchStatus: { total: 2, processing: 1, failed: 0 },
      },
    );

    const scanner = await screen.findByRole('main', { name: 'Camera quét tài liệu' });
    const viewport = within(scanner).getByRole('region', { name: 'Khung ngắm camera' });
    const controls = within(scanner).getByRole('group', { name: 'Điều khiển chụp' });

    expect(scanner).toHaveClass('camera-capture-screen');
    expect(viewport).toContainElement(
      within(scanner).getByLabelText('Hình ảnh trực tiếp từ camera'),
    );
    expect(controls).toContainElement(
      within(scanner).getByRole('button', { name: 'Chụp tài liệu' }),
    );
    expect(controls).toContainElement(
      within(scanner).getByRole('button', { name: 'Hoàn tất chụp 2 trang' }),
    );
    await waitFor(() => {
      expect(document.documentElement).toHaveClass('camera-active');
    });

    view.unmount();
    expect(document.documentElement).not.toHaveClass('camera-active');
  });

  it('shows one launch state while the camera request is pending', async () => {
    const pending = deferred<Awaited<ReturnType<CameraService['start']>>>();
    const start = vi.fn(() => pending.promise);
    renderCamera(fakeService(start));

    expect(screen.getByRole('heading', { name: 'Đang mở camera…' })).toBeInTheDocument();
    await waitFor(() => {
      expect(start).toHaveBeenCalledOnce();
    });
    expect(screen.queryByRole('button', { name: 'Cho phép camera' })).not.toBeInTheDocument();
  });

  it('gives specific recovery guidance and permits retry after denial', async () => {
    const start = vi
      .fn<CameraService['start']>()
      .mockRejectedValueOnce(new CameraServiceError('permission-denied'))
      .mockRejectedValueOnce(new CameraServiceError('busy'));
    renderCamera(fakeService(start));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Hãy cho phép camera trong cài đặt trình duyệt rồi thử lại.',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Thử mở camera lại' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Camera có thể đang được ứng dụng khác sử dụng.',
    );
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('stops camera when leaving and again during final cleanup', async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const service = fakeService(() => Promise.resolve({ stream, stop: vi.fn() }));
    const stop = vi.spyOn(service, 'stop');
    const view = renderCamera(service);
    await screen.findByRole('heading', { name: 'Camera đã sẵn sàng' });

    fireEvent.click(screen.getByRole('button', { name: 'Đóng camera' }));
    expect(stop).toHaveBeenCalledOnce();
    expect(view.onBack).toHaveBeenCalledOnce();

    view.unmount();
    expect(stop).toHaveBeenCalledTimes(2);
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

    await waitFor(() => {
      expect(operationSignal).toBeInstanceOf(AbortSignal);
    });
    view.unmount();

    expect(operationSignal?.aborted).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
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

    renderCamera(
      fakeService(() => Promise.resolve({ stream, stop: vi.fn() })),
      vi.fn(),
      {
        engineFactory: () => detectionEngine(detect),
        frameSourceFactory: videoFrameSource,
      },
    );

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

    renderCamera(
      fakeService(() => Promise.resolve({ stream, stop: vi.fn() })),
      vi.fn(),
      {
        engineFactory: () => detectionEngine(detect),
        frameSourceFactory: videoFrameSource,
      },
    );

    expect(await screen.findByText('Đã định khung tài liệu.')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Scanic tạm thời không nhận diện được',
    );
    expect(screen.queryByText('Đã định khung tài liệu.')).not.toBeInTheDocument();
    expect(screen.getByText('Giữ máy ổn định để định khung tài liệu.')).toBeInTheDocument();
  });

  it('captures a high-resolution photo and queues the original without closing the camera', async () => {
    const stream = {
      getTracks: () => [],
      getVideoTracks: () => [{} as MediaStreamTrack],
    } as unknown as MediaStream;
    const photo = new Blob(['captured'], { type: 'image/jpeg' });
    const capture = vi.fn<CameraCapture['capture']>(() => Promise.resolve(photo));
    const onPhotoCaptured = vi.fn<ComponentProps<typeof CameraScreen>['onPhotoCaptured']>();
    const stop = vi.fn();
    const service: CameraService = {
      lifecycle: { kind: 'idle' },
      start: () => Promise.resolve({ stream, stop: vi.fn() }),
      stop,
    };

    renderCamera(service, vi.fn(), {
      cameraCapture: { capture },
      onPhotoCaptured,
    });
    await screen.findByRole('heading', { name: 'Camera đã sẵn sàng' });

    fireEvent.click(screen.getByRole('button', { name: 'Chụp tài liệu' }));

    await waitFor(() => {
      expect(onPhotoCaptured).toHaveBeenCalledWith(photo, null);
    });
    expect(capture).toHaveBeenCalledWith(
      stream,
      expect.any(HTMLVideoElement),
      expect.any(AbortSignal),
    );
    expect(screen.getByRole('heading', { name: 'Camera đã sẵn sàng' })).toBeInTheDocument();
    expect(stop).not.toHaveBeenCalled();
  });

  it('keeps the camera open for multiple pages and finishes the batch once', async () => {
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
    const onPhotoCaptured = vi.fn<ComponentProps<typeof CameraScreen>['onPhotoCaptured']>();
    const onFinishCapture = vi.fn();
    const view = renderCamera(service, vi.fn(), {
      cameraCapture: { capture },
      onPhotoCaptured,
      onFinishCapture,
      batchStatus: { total: 0, processing: 0, failed: 0 },
    });
    await screen.findByRole('heading', { name: 'Camera đã sẵn sàng' });

    fireEvent.click(screen.getByRole('button', { name: 'Chụp tài liệu' }));
    await waitFor(() => {
      expect(onPhotoCaptured).toHaveBeenCalledWith(first, null);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Chụp tài liệu' }));
    await waitFor(() => {
      expect(onPhotoCaptured).toHaveBeenCalledWith(second, null);
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
    const finish = screen.getByRole('button', { name: 'Hoàn tất chụp 2 trang' });
    expect(finish).toBeDisabled();
    fireEvent.click(finish);
    expect(onFinishCapture).not.toHaveBeenCalled();

    view.rerender(
      <CameraScreen
        service={service}
        headingRef={createRef<HTMLHeadingElement>()}
        onBack={vi.fn()}
        cameraCapture={{ capture }}
        onPhotoCaptured={onPhotoCaptured}
        onFinishCapture={onFinishCapture}
        batchStatus={{ total: 2, processing: 0, failed: 0 }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Hoàn tất chụp 2 trang' }));
    expect(onFinishCapture).toHaveBeenCalledOnce();
    expect(stopCamera).toHaveBeenCalledOnce();
  });
});
