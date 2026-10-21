import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';

import type { CropRegion, DocumentCorners, ImageAsset, Point } from '../../domain/document';
import { validateQuad } from '../../imaging/geometry/quad';

interface ManualCropEditorProps {
  readonly original: ImageAsset;
  readonly initialCrop: CropRegion;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onApply: (crop: CropRegion) => void;
}

const CORNER_LABELS = ['Góc trên trái', 'Góc trên phải', 'Góc dưới phải', 'Góc dưới trái'] as const;

function fullFrameCorners(width: number, height: number): DocumentCorners {
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
}

function replaceCorner(corners: DocumentCorners, index: number, point: Point): DocumentCorners {
  if (index === 0) return [point, corners[1], corners[2], corners[3]];
  if (index === 1) return [corners[0], point, corners[2], corners[3]];
  if (index === 2) return [corners[0], corners[1], point, corners[3]];
  if (index === 3) return [corners[0], corners[1], corners[2], point];
  return corners;
}

function clamp(value: number, maximum: number): number {
  return Math.min(maximum, Math.max(0, value));
}

export function ManualCropEditor({
  original,
  initialCrop,
  busy,
  onCancel,
  onApply,
}: ManualCropEditorProps) {
  const { width, height } = original.dimensions;
  const [corners, setCorners] = useState<DocumentCorners>(() =>
    initialCrop.kind === 'document' ? initialCrop.corners : fullFrameCorners(width, height),
  );
  const [activeCorner, setActiveCorner] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const originalUrl = useMemo(() => URL.createObjectURL(original.blob), [original.blob]);
  const validation = validateQuad(corners, original.dimensions, width * height * 0.005);
  const points = corners.map((point) => `${String(point.x)},${String(point.y)}`).join(' ');

  useEffect(
    () => () => {
      URL.revokeObjectURL(originalUrl);
    },
    [originalUrl],
  );

  const updateFromPointer = (event: PointerEvent<SVGSVGElement>) => {
    if (activeCorner === null) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    setCorners((current) =>
      replaceCorner(current, activeCorner, {
        x: clamp(((event.clientX - bounds.left) / bounds.width) * width, width),
        y: clamp(((event.clientY - bounds.top) / bounds.height) * height, height),
      }),
    );
  };

  const moveWithKeyboard = (index: number, event: KeyboardEvent<SVGCircleElement>) => {
    const step = Math.max(1, Math.round(Math.min(width, height) / 100));
    const direction =
      event.key === 'ArrowLeft'
        ? { x: -step, y: 0 }
        : event.key === 'ArrowRight'
          ? { x: step, y: 0 }
          : event.key === 'ArrowUp'
            ? { x: 0, y: -step }
            : event.key === 'ArrowDown'
              ? { x: 0, y: step }
              : null;
    if (direction === null) return;
    event.preventDefault();
    setCorners((current) => {
      const point = current[index];
      if (point === undefined) return current;
      return replaceCorner(current, index, {
        x: clamp(point.x + direction.x, width),
        y: clamp(point.y + direction.y, height),
      });
    });
  };

  return (
    <section className="manual-crop" aria-labelledby="manual-crop-title">
      <header className="manual-crop__heading">
        <div>
          <p className="eyebrow">Cắt tài liệu</p>
          <h2 id="manual-crop-title">Điều chỉnh 4 góc</h2>
        </div>
        <button type="button" onClick={onCancel} disabled={busy}>
          Hủy
        </button>
      </header>

      <p className="manual-crop__hint">Kéo từng chấm xanh vào đúng bốn góc của tờ giấy.</p>

      <div className="manual-crop__stage">
        <img src={originalUrl} alt="Ảnh gốc để điều chỉnh vùng cắt" draggable={false} />
        <svg
          ref={svgRef}
          className="manual-crop__overlay"
          viewBox={`0 0 ${String(width)} ${String(height)}`}
          aria-label="Vùng cắt bốn góc"
          onPointerMove={updateFromPointer}
          onPointerUp={() => {
            setActiveCorner(null);
          }}
          onPointerCancel={() => {
            setActiveCorner(null);
          }}
        >
          <polygon className="manual-crop__shade" points={`0,0 ${String(width)},0 ${String(width)},${String(height)} 0,${String(height)}`} />
          <polygon className="manual-crop__polygon" points={points} />
          {corners.map((point, index) => (
            <circle
              key={CORNER_LABELS[index]}
              className="manual-crop__handle"
              cx={point.x}
              cy={point.y}
              r={Math.max(width, height) * 0.025}
              role="slider"
              tabIndex={0}
              aria-label={CORNER_LABELS[index]}
              aria-valuemin={0}
              aria-valuemax={Math.max(width, height)}
              aria-valuenow={Math.round((point.x + point.y) / 2)}
              aria-valuetext={`${String(Math.round(point.x))}, ${String(Math.round(point.y))}`}
              onKeyDown={(event) => {
                moveWithKeyboard(index, event);
              }}
              onPointerDown={(event) => {
                event.preventDefault();
                setActiveCorner(index);
                const overlay = svgRef.current;
                if (overlay !== null && typeof overlay.setPointerCapture === 'function') {
                  overlay.setPointerCapture(event.pointerId);
                }
              }}
            />
          ))}
        </svg>
      </div>

      {!validation.valid ? (
        <p className="manual-crop__error" role="alert">
          Bốn góc chưa tạo thành một vùng tài liệu hợp lệ. Hãy kéo lại các góc.
        </p>
      ) : null}

      <button
        className="primary-button manual-crop__apply"
        type="button"
        disabled={busy || !validation.valid}
        aria-busy={busy}
        onClick={() => {
          onApply({ kind: 'document', corners });
        }}
      >
        {busy ? 'Đang cắt lại…' : 'Áp dụng vùng cắt'}
      </button>
    </section>
  );
}
