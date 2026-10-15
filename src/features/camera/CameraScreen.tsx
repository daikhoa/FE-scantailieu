import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import type { ScannerEngine } from '../../imaging/contracts/scanner-engine';
import { createScanicEngine } from '../../imaging/engines/scanic-classical-engine';
import type { LiveDetectionResult } from '../scanner/detection-scheduler';
import { startLiveDetectionSession } from '../scanner/live-detection-session';
import { createVideoFrameSource, type VideoFrameSource } from '../scanner/video-frame-source';
import { ActiveCameraView } from './ActiveCameraView';
import { createCameraCapture, type CameraCapture } from './camera-capture';
import { CameraServiceError, type CameraFailureCode, type CameraService } from './camera-service';

type CameraViewState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'active'; readonly stream: MediaStream }
  | { readonly kind: 'error'; readonly code: CameraFailureCode };

const ERROR_GUIDANCE: Readonly<Record<CameraFailureCode, string>> = {
  unavailable: 'Trình duyệt này chưa cung cấp camera. Bạn vẫn có thể quay lại thư viện.',
  'permission-denied': 'Hãy cho phép camera trong cài đặt trình duyệt rồi thử lại.',
  'not-found': 'Không tìm thấy camera phù hợp trên thiết bị này.',
  busy: 'Camera có thể đang được ứng dụng khác sử dụng. Hãy đóng ứng dụng đó rồi thử lại.',
  failed: 'Không thể mở camera. Hãy thử lại hoặc kiểm tra quyền của trình duyệt.',
};

interface CameraScreenProps {
  readonly service: CameraService;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly onBack: () => void;
  readonly onPhotoCaptured: (source: Blob) => void;
  readonly onFinishCapture?: () => void;
  readonly batchStatus?: {
    readonly total: number;
    readonly processing: number;
    readonly failed: number;
  };
  readonly engineFactory?: () => ScannerEngine;
  readonly frameSourceFactory?: () => VideoFrameSource;
  readonly cameraCapture?: CameraCapture;
}

function defaultFrameSourceFactory(): VideoFrameSource {
  return createVideoFrameSource();
}

export function CameraScreen({
  service,
  headingRef,
  onBack,
  onPhotoCaptured,
  onFinishCapture,
  batchStatus,
  engineFactory = createScanicEngine,
  frameSourceFactory = defaultFrameSourceFactory,
  cameraCapture,
}: CameraScreenProps) {
  const [state, setState] = useState<CameraViewState>({ kind: 'idle' });
  const [liveDetection, setLiveDetection] = useState<LiveDetectionResult | null>(null);
  const [detectionFailed, setDetectionFailed] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [captureFailed, setCaptureFailed] = useState(false);
  const [activationRequest, setActivationRequest] = useState(0);
  const [resolvedCapture] = useState(() => cameraCapture ?? createCameraCapture());
  const request = useRef<AbortController | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
      request.current = null;
      service.stop();
    };
  }, [service]);

  useEffect(() => {
    const suspendCamera = () => {
      request.current?.abort();
      request.current = null;
      service.stop();
      setState({ kind: 'idle' });
    };
    const onVisibilityChange = () => {
      if (document.hidden) {
        suspendCamera();
      } else {
        setActivationRequest((current) => current + 1);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', suspendCamera);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', suspendCamera);
    };
  }, [service]);

  useEffect(() => {
    const element = video.current;
    if (element === null || state.kind !== 'active') return;
    element.srcObject = state.stream;
    return () => {
      element.srcObject = null;
    };
  }, [state]);

  useEffect(() => {
    if (state.kind !== 'active' || video.current === null) return;
    setLiveDetection(null);
    setDetectionFailed(false);
    const session = startLiveDetectionSession({
      engineFactory,
      source: frameSourceFactory(),
      video: video.current,
      onResult: (result) => {
        if (!mounted.current) return;
        setDetectionFailed(false);
        setLiveDetection(result);
      },
      onError: () => {
        if (!mounted.current) return;
        setLiveDetection((current) =>
          current === null
            ? null
            : {
                kind: 'full-frame',
                dimensions: current.dimensions,
                reason: 'unstable-document',
              },
        );
        setDetectionFailed(true);
      },
    });
    return () => {
      void session.stop().catch(() => undefined);
    };
  }, [engineFactory, frameSourceFactory, state]);

  const closeCamera = useCallback(() => {
    request.current?.abort();
    request.current = null;
    service.stop();
    setLiveDetection(null);
    setCaptureFailed(false);
    setCapturing(false);
    setState({ kind: 'idle' });
  }, [service]);

  const startCamera = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setState({ kind: 'starting' });
    try {
      const session = await service.start(controller.signal);
      if (!mounted.current || request.current !== controller) {
        session.stop();
        return;
      }
      setState({ kind: 'active', stream: session.stream });
    } catch (error) {
      if (!mounted.current || request.current !== controller) return;
      if (error instanceof Error && error.name === 'AbortError') {
        setState({ kind: 'idle' });
      } else {
        setState({
          kind: 'error',
          code: error instanceof CameraServiceError ? error.code : 'failed',
        });
      }
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, [service]);

  useEffect(() => {
    const launch = window.setTimeout(() => void startCamera(), 0);
    return () => {
      window.clearTimeout(launch);
    };
  }, [activationRequest, startCamera]);

  const capturePhoto = async () => {
    if (state.kind !== 'active' || video.current === null || capturing) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setCaptureFailed(false);
    setCapturing(true);
    try {
      const photo = await resolvedCapture.capture(state.stream, video.current, controller.signal);
      if (!mounted.current || request.current !== controller) return;
      onPhotoCaptured(photo);
    } catch (error) {
      if (!mounted.current || request.current !== controller) return;
      if (!(error instanceof Error && error.name === 'AbortError')) setCaptureFailed(true);
    } finally {
      if (mounted.current) setCapturing(false);
      if (request.current === controller) request.current = null;
    }
  };

  const cameraActive = state.kind === 'active';

  useEffect(() => {
    if (!cameraActive) return;
    document.documentElement.classList.add('camera-active');
    return () => {
      document.documentElement.classList.remove('camera-active');
    };
  }, [cameraActive]);

  const exitCamera = () => {
    closeCamera();
    onBack();
  };

  if (state.kind === 'active') {
    return (
      <ActiveCameraView
        videoRef={video}
        headingRef={headingRef}
        liveDetection={liveDetection}
        detectionFailed={detectionFailed}
        captureFailed={captureFailed}
        capturing={capturing}
        {...(batchStatus === undefined ? {} : { batchStatus })}
        canFinish={onFinishCapture !== undefined && batchStatus !== undefined}
        onCapture={() => void capturePhoto()}
        onClose={exitCamera}
        onExit={exitCamera}
        onFinish={() => {
          closeCamera();
          onFinishCapture?.();
        }}
      />
    );
  }

  const cameraError = state.kind === 'error';
  return (
    <main
      id="main-content"
      className="camera-launch-screen"
      aria-label={cameraError ? 'Không thể mở camera' : 'Đang mở camera'}
    >
      <button
        className="camera-icon-button camera-launch-screen__close"
        type="button"
        aria-label="Quay lại"
        onClick={exitCamera}
      >
        <span aria-hidden="true">×</span>
      </button>
      <section className="camera-launch-screen__status" aria-live="polite">
        {cameraError ? null : (
          <span className="camera-launch-screen__indicator" aria-hidden="true" />
        )}
        <h1 ref={headingRef} tabIndex={-1}>
          {cameraError ? 'Không thể mở camera' : 'Đang mở camera…'}
        </h1>
        {cameraError ? (
          <>
            <p className="camera-error" role="alert">
              {ERROR_GUIDANCE[state.code]}
            </p>
            <button className="primary-button" type="button" onClick={() => void startCamera()}>
              Thử mở camera lại
            </button>
          </>
        ) : (
          <p>Vui lòng xác nhận quyền camera của trình duyệt nếu được hỏi.</p>
        )}
      </section>
    </main>
  );
}
