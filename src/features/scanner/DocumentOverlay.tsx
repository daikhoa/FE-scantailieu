import type { LiveDetectionResult } from './detection-scheduler';

interface DocumentOverlayProps {
  readonly result: LiveDetectionResult | null;
  readonly unavailable?: boolean;
}

function statusText(result: LiveDetectionResult | null): string {
  if (result === null) return 'Đang tìm tài liệu…';
  if (result.kind === 'document') return 'Đã định khung tài liệu.';
  switch (result.reason) {
    case 'no-document':
      return 'Chưa thấy tài liệu — ảnh sẽ giữ toàn bộ khung.';
    case 'low-confidence':
      return 'Chưa nhận diện chắc chắn — ảnh sẽ giữ toàn bộ khung.';
    case 'unstable-document':
      return 'Giữ máy ổn định để định khung tài liệu.';
  }
}

function polygonPoints(result: LiveDetectionResult): string {
  if (result.kind === 'document') {
    return result.corners.map(({ x, y }) => `${String(x)},${String(y)}`).join(' ');
  }
  const { width, height } = result.dimensions;
  return `0,0 ${String(width)},0 ${String(width)},${String(height)} 0,${String(height)}`;
}

export function DocumentOverlay({ result, unavailable = false }: DocumentOverlayProps) {
  const detection = unavailable ? 'unavailable' : (result?.kind ?? 'searching');
  return (
    <div className="document-overlay" data-detection={detection}>
      {result === null ? null : (
        <svg
          className="document-overlay__geometry"
          viewBox={[
            '0',
            '0',
            String(result.dimensions.width),
            String(result.dimensions.height),
          ].join(' ')}
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
          focusable="false"
        >
          <polygon
            className={`document-overlay__polygon document-overlay__polygon--${result.kind}`}
            points={polygonPoints(result)}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
      <p className="document-overlay__status" role="status" aria-live="polite">
        {unavailable ? 'Nhận diện đang lỗi — bạn vẫn có thể chụp toàn khung.' : statusText(result)}
      </p>
    </div>
  );
}
