import { useEffect, useRef } from 'react';
import type { ImageAsset } from '../domain/document';

const sources = new WeakMap<Blob, { url: string; users: number }>();

/** A live image owns its URL; shared filter samples reuse the same decoded source. */
export function AssetImage({
  image,
  alt,
  lazy = false,
  draggable,
  width,
  height,
}: {
  readonly image: ImageAsset | string;
  readonly alt: string;
  readonly lazy?: boolean;
  readonly draggable?: boolean;
  readonly width?: number;
  readonly height?: number;
}) {
  const element = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (typeof image === 'string') {
      if (element.current) element.current.src = image;
      return;
    }
    let source = sources.get(image.blob);
    if (!source) {
      source = { url: URL.createObjectURL(image.blob), users: 0 };
      sources.set(image.blob, source);
    }
    source.users++;
    if (element.current) element.current.src = source.url;
    return () => {
      source.users--;
      if (source.users === 0) {
        URL.revokeObjectURL(source.url);
        sources.delete(image.blob);
      }
    };
  }, [image]);
  return (
    <img
      ref={element}
      alt={alt}
      loading={lazy ? 'lazy' : 'eager'}
      decoding="async"
      {...(draggable === undefined ? {} : { draggable })}
      {...(width === undefined ? {} : { width })}
      {...(height === undefined ? {} : { height })}
    />
  );
}
