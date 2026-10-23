import { useEffect, useRef } from 'react';
import type { RgbaBackendInput } from '../../imaging/engines/scanic-backend-contract';

export function PendingPagePreview({
  preview,
  number,
}: {
  readonly preview: RgbaBackendInput;
  readonly number: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    context?.putImageData(
      new ImageData(preview.pixels, preview.dimensions.width, preview.dimensions.height),
      0,
      0,
    );
  }, [preview]);
  return (
    <canvas
      ref={canvas}
      width={preview.dimensions.width}
      height={preview.dimensions.height}
      role="img"
      aria-label={`Trang ${String(number)} đang hoàn thiện`}
    />
  );
}
