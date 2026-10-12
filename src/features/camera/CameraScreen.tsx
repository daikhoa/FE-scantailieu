import { useEffect, useRef, useState, type RefObject } from 'react';

import type { ScannerEngine } from '../../imaging/contracts/scanner-engine';
import { createScanicClassicalEngine } from '../../imaging/engines/scanic-classical-engine';
import type { LiveDetectionResult } from '../scanner/detection-scheduler';
import { DocumentOverlay } from '../scanner/DocumentOverlay';
import { startLiveDetectionSession } from '../scanner/live-detection-session';
import { createVideoFrameSource, type VideoFrameSource } from '../scanner/video-frame-source';
import { createCameraCapture, type CameraCapture } from './camera-capture';
import { CameraServiceError, type CameraFailureCode, type CameraService } from './camera-service';
import {
  ImageImportError,
  importImage,
  type ImageImporter,
  type ImageImportFailureCode,
  type ImportedImage,
} from './image-import';

type CameraViewState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'active'; readonly stream: MediaStream }
  | { readonly kind: 'importing' }
  | { readonly kind: 'imported'; readonly image: ImportedImage }
  | {
      readonly kind: 'error';
      readonly source: 'camera';
      readonly code: CameraFailureCode;
    }
  | {
      readonly kind: 'error';
      readonly source: 'import';
      readonly code: ImageImportFailureCode;
    };

const ERROR_GUIDANCE: Readonly<Record<CameraFailureCode, string>> = {
  unavailable: 'Trình duyệt này chưa cung cấp camera. Bạn vẫn có thể quay lại thư viện.',
  'permission-denied': 'Hãy cho phép camera trong cài đặt trình duyệt rồi thử lại.',
  'not-found': 'Không tìm thấy camera phù hợp trên thiết bị này.',
  busy: 'Camera có thể đang được ứng dụng khác sử dụng. Hãy đóng ứng dụng đó rồi thử lại.',
  failed: 'Không thể mở camera. Hãy thử lại hoặc kiểm tra quyền của trình duyệt.',
};

const IMPORT_ERROR_GUIDANCE: Readonly<Record<ImageImportFailureCode, string>> = {
  'unsupported-type': 'Chỉ hỗ trợ ảnh JPEG, PNG hoặc WebP.',
  'too-large': 'Tệp ảnh vượt quá giới hạn 64 MiB.',
  'invalid-file': 'Tệp không phải là ảnh JPEG, PNG hoặc WebP hợp lệ.',
  'image-too-large': 'Ảnh có kích thước quá lớn để xử lý an toàn trên thiết bị này.',
  'decode-failed': 'Trình duyệt không thể đọc ảnh này. Hãy chọn ảnh khác.',
  unavailable: 'Trình duyệt này chưa hỗ trợ đọc ảnh từ thư viện.',
};

const IMPORT_CODES = new Set<ImageImportFailureCode>([
  'unsupported-type',
  'too-large',
  'invalid-file',
  'image-too-large',
  'decode-failed',
  'unavailable',
]);

interface CameraScreenProps {
  readonly service: CameraService;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly onBack: () => void;
  readonly importer?: ImageImporter;
  readonly onImageImported?: (image: ImportedImage) => void;
  readonly engineFactory?: () => ScannerEngine;
  readonly frameSourceFactory?: () => VideoFrameSource;
  readonly cameraCapture?: CameraCapture;
}

function defaultFrameSourceFactory(): VideoFrameSource {
  return createVideoFrameSource();
}

function CameraPlaceholder() {
  return (
    <div className="camera-frame" aria-hidden="true">
      <span className="camera-frame__corner camera-frame__corner--top-left" />
      <span className="camera-frame__corner camera-frame__corner--top-right" />
      <span className="camera-frame__document" />
      <span className="camera-frame__corner camera-frame__corner--bottom-left" />
      <span className="camera-frame__corner camera-frame__corner--bottom-right" />
    </div>
  );
}

function importFailureCode(error: unknown): ImageImportFailureCode {
  if (error instanceof ImageImportError) return error.code;
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    IMPORT_CODES.has(error.code as ImageImportFailureCode)
  ) {
    return error.code as ImageImportFailureCode;
  }
  return 'decode-failed';
}

function formatDimensions(image: ImportedImage): string {
  const formatter = new Intl.NumberFormat('vi-VN');
  return `${formatter.format(image.original.dimensions.width)} × ${formatter.format(
    image.original.dimensions.height,
  )} px`;
}

export function CameraScreen({
  service,
  headingRef,
  onBack,
  importer = importImage,
  onImageImported,
  engineFactory = createScanicClassicalEngine,
  frameSourceFactory = defaultFrameSourceFactory,
  cameraCapture,
}: CameraScreenProps) {
  const [state, setState] = useState<CameraViewState>({ kind: 'idle' });
  const [liveDetection, setLiveDetection] = useState<LiveDetectionResult | null>(null);
  const [detectionFailed, setDetectionFailed] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [captureFailed, setCaptureFailed] = useState(false);
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
      if (document.hidden) suspendCamera();
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
      engine: engineFactory(),
      source: frameSourceFactory(),
      video: video.current,
      onResult: (result) => {
        if (!mounted.current) return;
        setDetectionFailed(false);
        setLiveDetection(result);
      },
      onError: () => {
        if (!mounted.current) return;
        setDetectionFailed(true);
      },
    });
    return () => {
      void session.stop().catch(() => undefined);
    };
  }, [engineFactory, frameSourceFactory, state]);

  const closeCamera = () => {
    request.current?.abort();
    request.current = null;
    service.stop();
    setLiveDetection(null);
    setCaptureFailed(false);
    setCapturing(false);
    setState({ kind: 'idle' });
  };

  const startCamera = async () => {
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
          source: 'camera',
          code: error instanceof CameraServiceError ? error.code : 'failed',
        });
      }
    } finally {
      if (request.current === controller) request.current = null;
    }
  };

  const selectImage = async (source: Blob) => {
    request.current?.abort();
    service.stop();
    const controller = new AbortController();
    request.current = controller;
    setState({ kind: 'importing' });
    try {
      const image = await importer(source, controller.signal);
      if (!mounted.current || request.current !== controller) return;
      setState({ kind: 'imported', image });
      onImageImported?.(image);
    } catch (error) {
      if (!mounted.current || request.current !== controller) return;
      if (error instanceof Error && error.name === 'AbortError') {
        setState({ kind: 'idle' });
      } else {
        setState({ kind: 'error', source: 'import', code: importFailureCode(error) });
      }
    } finally {
      if (request.current === controller) request.current = null;
    }
  };

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
      await selectImage(photo);
    } catch (error) {
      if (!mounted.current || request.current !== controller) return;
      if (!(error instanceof Error && error.name === 'AbortError')) setCaptureFailed(true);
    } finally {
      if (mounted.current) setCapturing(false);
      if (request.current === controller) request.current = null;
    }
  };

  const cameraActive = state.kind === 'active';
  const imported = state.kind === 'imported';
  const heading = cameraActive
    ? 'Camera đã sẵn sàng'
    : imported
      ? 'Ảnh đã sẵn sàng'
      : 'Sẵn sàng mở camera';

  return (
    <main id="main-content" className="app-main scan-intro" aria-label="clonecamscanner">
      <button
        className="back-button"
        type="button"
        onClick={() => {
          closeCamera();
          onBack();
        }}
        aria-label="Quay lại thư viện"
      >
        <span aria-hidden="true">←</span>
        Thư viện
      </button>

      <section className="scan-intro__content" aria-labelledby="scan-intro-title">
        {cameraActive ? (
          <div className="camera-frame camera-frame--active">
            <video
              ref={video}
              className="camera-preview"
              aria-label="Hình ảnh trực tiếp từ camera"
              autoPlay
              muted
              playsInline
            />
            <DocumentOverlay result={liveDetection} />
            <span className="camera-live-badge">Trực tiếp</span>
          </div>
        ) : imported ? (
          <div className="import-summary" role="status">
            <span className="import-summary__mark" aria-hidden="true">
              ✓
            </span>
            <strong>Ảnh đã được kiểm tra trên thiết bị</strong>
            <span>{formatDimensions(state.image)}</span>
          </div>
        ) : (
          <CameraPlaceholder />
        )}
        <p className="eyebrow">Quét thủ công</p>
        <h1 id="scan-intro-title" ref={headingRef} tabIndex={-1}>
          {heading}
        </h1>
        <p className="scan-intro__description">
          {cameraActive
            ? 'Bạn sẽ tự bấm chụp từng trang.'
            : imported
              ? 'Ảnh gốc vẫn được giữ nguyên để xử lý ở bước tiếp theo.'
              : 'Camera chỉ được yêu cầu sau khi bạn chủ động cho phép.'}
        </p>

        {cameraActive ? (
          <div className="camera-actions">
            {detectionFailed ? (
              <p className="camera-error" role="alert">
                Scanic tạm thời không nhận diện được; ảnh chụp vẫn được giữ toàn khung.
              </p>
            ) : null}
            {captureFailed ? (
              <p className="camera-error" role="alert">
                Không thể chụp ảnh. Hãy giữ máy ổn định rồi thử lại.
              </p>
            ) : null}
            <button
              className="camera-shutter"
              type="button"
              aria-label="Chụp tài liệu"
              aria-busy={capturing}
              disabled={capturing}
              onClick={() => void capturePhoto()}
            >
              <span aria-hidden="true" />
              {capturing ? 'Đang chụp…' : 'Chụp tài liệu'}
            </button>
            <button className="secondary-button" type="button" onClick={closeCamera}>
              Đóng camera
            </button>
          </div>
        ) : imported ? (
          <div className="camera-actions">
            <label className="image-import-button">
              Chọn ảnh khác
              <input
                className="visually-hidden"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(event) => {
                  const source = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  if (source !== undefined) void selectImage(source);
                }}
              />
            </label>
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                setState({ kind: 'idle' });
              }}
            >
              Bỏ ảnh này
            </button>
          </div>
        ) : (
          <>
            <ul className="scan-benefits">
              <li>Ảnh và bản scan được giữ trên thiết bị này.</li>
              <li>Bạn quyết định thời điểm chụp từng trang.</li>
              <li>Ảnh gốc luôn được giữ để có thể chỉnh lại.</li>
            </ul>
            {state.kind === 'error' ? (
              <p className="camera-error" role="alert">
                {state.source === 'camera'
                  ? ERROR_GUIDANCE[state.code]
                  : IMPORT_ERROR_GUIDANCE[state.code]}
              </p>
            ) : null}
            <button
              className="primary-button"
              type="button"
              disabled={state.kind === 'starting' || state.kind === 'importing'}
              aria-busy={state.kind === 'starting'}
              onClick={() => {
                void startCamera();
              }}
            >
              {state.kind === 'starting'
                ? 'Đang mở camera…'
                : state.kind === 'error' && state.source === 'camera'
                  ? 'Thử mở camera lại'
                  : 'Cho phép camera'}
            </button>
            <div className="import-divider" aria-hidden="true">
              <span>hoặc</span>
            </div>
            <label
              className={`image-import-button${state.kind === 'importing' ? ' image-import-button--disabled' : ''}`}
              aria-busy={state.kind === 'importing'}
            >
              {state.kind === 'importing'
                ? 'Đang kiểm tra ảnh…'
                : state.kind === 'error' && state.source === 'import'
                  ? 'Chọn ảnh khác'
                  : 'Chọn ảnh từ thư viện'}
              <input
                className="visually-hidden"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={state.kind === 'importing'}
                onChange={(event) => {
                  const source = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  if (source !== undefined) void selectImage(source);
                }}
              />
            </label>
            <p className="pending-note" role="status">
              Không có ảnh nào được gửi lên máy chủ.
            </p>
          </>
        )}
      </section>
    </main>
  );
}
