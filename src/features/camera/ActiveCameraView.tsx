import type { RefObject } from 'react';

import type { LiveDetectionResult } from '../scanner/detection-scheduler';
import { DocumentOverlay } from '../scanner/DocumentOverlay';

interface CaptureBatchStatus {
  readonly total: number;
  readonly processing: number;
  readonly failed: number;
}

interface ActiveCameraViewProps {
  readonly videoRef: RefObject<HTMLVideoElement | null>;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly liveDetection: LiveDetectionResult | null;
  readonly detectionFailed: boolean;
  readonly captureFailed: boolean;
  readonly capturing: boolean;
  readonly batchStatus?: CaptureBatchStatus;
  readonly canFinish: boolean;
  readonly onCapture: () => void;
  readonly onClose: () => void;
  readonly onExit: () => void;
  readonly onFinish: () => void;
}

function CaptureProgress({ status }: { readonly status: CaptureBatchStatus }) {
  return (
    <div
      className="capture-progress capture-progress--camera"
      role="status"
      aria-label="Tiến độ chụp"
    >
      <strong>{status.total} trang</strong>
      {status.processing > 0 ? (
        <span> · {status.processing} đang xử lý</span>
      ) : status.failed > 0 ? (
        <span> · {status.failed} cần kiểm tra</span>
      ) : status.total > 0 ? (
        <span> · đã xử lý xong</span>
      ) : (
        <span> · sẵn sàng chụp</span>
      )}
    </div>
  );
}

export function ActiveCameraView({
  videoRef,
  headingRef,
  liveDetection,
  detectionFailed,
  captureFailed,
  capturing,
  batchStatus,
  canFinish,
  onCapture,
  onClose,
  onExit,
  onFinish,
}: ActiveCameraViewProps) {
  const total = batchStatus?.total ?? 0;

  return (
    <main id="main-content" className="camera-capture-screen" aria-label="Camera quét tài liệu">
      <header className="camera-capture-screen__topbar">
        <button
          className="camera-icon-button"
          type="button"
          aria-label="Quay lại thư viện"
          onClick={onExit}
        >
          <span aria-hidden="true">×</span>
        </button>
        <div className="camera-capture-screen__title">
          <span>Quét tài liệu</span>
          <h1 className="visually-hidden" ref={headingRef} tabIndex={-1}>
            Camera đã sẵn sàng
          </h1>
        </div>
        <span className="camera-page-count" aria-label={`${String(total)} trang đã chụp`}>
          {total}
        </span>
      </header>

      <section
        className="camera-capture-screen__viewport"
        role="region"
        aria-label="Khung ngắm camera"
      >
        <div className="camera-frame camera-frame--active camera-frame--fullscreen">
          <video
            ref={videoRef}
            className="camera-preview"
            aria-label="Hình ảnh trực tiếp từ camera"
            data-frame-fit="contain"
            autoPlay
            muted
            playsInline
          />
          <DocumentOverlay result={liveDetection} />
        </div>
        {detectionFailed || captureFailed ? (
          <div className="camera-capture-screen__errors">
            {detectionFailed ? (
              <p className="camera-error camera-error--overlay" role="alert">
                Scanic tạm thời không nhận diện được; ảnh chụp vẫn được giữ toàn khung.
              </p>
            ) : null}
            {captureFailed ? (
              <p className="camera-error camera-error--overlay" role="alert">
                Không thể chụp ảnh. Hãy giữ máy ổn định rồi thử lại.
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      <footer className="camera-capture-screen__controls">
        {batchStatus === undefined ? null : <CaptureProgress status={batchStatus} />}
        <div className="camera-control-row" role="group" aria-label="Điều khiển chụp">
          <button
            className="camera-control-button"
            type="button"
            aria-label="Đóng camera"
            onClick={onClose}
          >
            <span aria-hidden="true">↶</span>
            <small>Đóng</small>
          </button>
          <button
            className="camera-shutter camera-shutter--compact"
            type="button"
            aria-label="Chụp tài liệu"
            aria-busy={capturing}
            disabled={capturing}
            onClick={onCapture}
          >
            <span aria-hidden="true" />
            <b className="visually-hidden">{capturing ? 'Đang chụp…' : 'Chụp tài liệu'}</b>
          </button>
          {canFinish ? (
            <button
              className="camera-done-button"
              type="button"
              aria-label={`Hoàn tất chụp ${String(total)} trang`}
              disabled={total === 0}
              onClick={onFinish}
            >
              Xong
            </button>
          ) : (
            <span aria-hidden="true" />
          )}
        </div>
      </footer>
    </main>
  );
}
