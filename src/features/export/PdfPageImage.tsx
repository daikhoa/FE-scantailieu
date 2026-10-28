import { useEffect, useRef } from 'react';
import type { ImageAsset } from '../../domain/document';

export function PdfPageImage({
  image,
  number,
  lazy = false,
}: {
  readonly image: ImageAsset | string;
  readonly number: number;
  readonly lazy?: boolean;
}) {
  const element = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const url = typeof image === 'string' ? image : URL.createObjectURL(image.blob);
    if (element.current) element.current.src = url;
    return () => {
      if (typeof image !== 'string') URL.revokeObjectURL(url);
    };
  }, [image]);
  return (
    <img
      ref={element}
      alt={`Trang ${String(number)} của PDF`}
      loading={lazy ? 'lazy' : 'eager'}
      decoding="async"
    />
  );
}
