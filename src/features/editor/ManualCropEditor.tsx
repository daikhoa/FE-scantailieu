import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { AssetImage } from '../../components/AssetImage';

import type { CropRegion, DocumentCorners, ImageAsset, Point } from '../../domain/document';
import { validateQuad } from '../../imaging/geometry/quad';
import { useCropViewport } from './use-crop-viewport';
import './manual-crop.css';

interface ManualCropEditorProps {
  readonly original: ImageAsset;
  readonly preview?: ImageAsset;
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
  preview,
  initialCrop,
  busy,
  onCancel,
  onApply,
}: ManualCropEditorProps) {
  const { width, height } = original.dimensions;
  const [corners, setCorners] = useState<DocumentCorners>(() =>
    initialCrop.kind === 'document' ? initialCrop.corners : fullFrameCorners(width, height),
  );
  const activeDrag = useRef<{ corner: number; pointer: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const { viewportRef, stageRef, stageWidth, zoom, changeZoom, focusDocument, maxZoom } =
    useCropViewport(width, height);
  const screenPixel = width / stageWidth;
  const validation = validateQuad(corners, original.dimensions, width * height * 0.005);
  const points = corners.map((point) => `${String(point.x)},${String(point.y)}`).join(' ');

  const updateFromPointer = (event: PointerEvent<SVGSVGElement>) => {
    const drag = activeDrag.current;
    if (drag?.pointer !== event.pointerId || busy) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    setCorners((current) =>
      replaceCorner(current, drag.corner, {
        x: clamp(((event.clientX - bounds.left) / bounds.width) * width, width),
        y: clamp(((event.clientY - bounds.top) / bounds.height) * height, height),
      }),
    );
  };

  const moveWithKeyboard = (index: number, event: KeyboardEvent<SVGCircleElement>) => {
    if (busy) return;
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

      <p className="manual-crop__hint">
        Kéo 4 chấm tới góc giấy. Phóng to rồi vuốt ảnh để chỉnh kỹ hơn.
      </p>
      <div className="manual-crop__zoom" role="group" aria-label="Phóng ảnh để chỉnh góc">
        <button
          type="button"
          aria-label="Thu nhỏ"
          disabled={busy || zoom <= 1}
          onClick={() => {
            changeZoom(zoom / 1.5);
          }}
        >
          −
        </button>
        <output aria-label="Mức phóng to">{Math.round(zoom * 100)}%</output>
        <button
          type="button"
          aria-label="Phóng to"
          disabled={busy || zoom >= maxZoom}
          onClick={() => {
            changeZoom(zoom * 1.5);
          }}
        >
          +
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            focusDocument(corners);
          }}
        >
          Phóng tới tài liệu
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            changeZoom(1, { x: 0.5, y: 0.5 });
          }}
        >
          Vừa ảnh
        </button>
      </div>

      <div className="manual-crop__viewport" ref={viewportRef}>
        <div className="manual-crop__canvas">
          <div
            className="manual-crop__stage"
            ref={stageRef}
            style={{ width: stageWidth, height: (stageWidth * height) / width }}
          >
            <AssetImage
              image={preview ?? original}
              alt="Ảnh gốc để điều chỉnh vùng cắt"
              draggable={false}
            />
            <svg
              ref={svgRef}
              className="manual-crop__overlay"
              viewBox={`0 0 ${String(width)} ${String(height)}`}
              aria-label="Vùng cắt bốn góc"
              onPointerMove={updateFromPointer}
              onPointerUp={() => {
                activeDrag.current = null;
              }}
              onPointerCancel={() => {
                activeDrag.current = null;
              }}
              onLostPointerCapture={() => {
                activeDrag.current = null;
              }}
            >
              <polygon
                className="manual-crop__shade"
                points={`0,0 ${String(width)},0 ${String(width)},${String(height)} 0,${String(height)}`}
              />
              <polygon className="manual-crop__polygon" points={points} />
              {corners.map((point, index) => (
                <g key={CORNER_LABELS[index]}>
                  <circle
                    className="manual-crop__handle"
                    cx={point.x}
                    cy={point.y}
                    r={22 * screenPixel}
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
                      if (busy || activeDrag.current !== null) return;
                      event.preventDefault();
                      activeDrag.current = { corner: index, pointer: event.pointerId };
                      const overlay = svgRef.current;
                      if (overlay !== null && typeof overlay.setPointerCapture === 'function') {
                        overlay.setPointerCapture(event.pointerId);
                      }
                    }}
                  />
                  <circle
                    className="manual-crop__marker"
                    cx={point.x}
                    cy={point.y}
                    r={7 * screenPixel}
                    aria-hidden="true"
                  />
                </g>
              ))}
            </svg>
          </div>
        </div>
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
