import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DocumentCorners } from '../../domain/document';

const VIEWPORT_PADDING = 48;
const MAX_ZOOM = 6;

/** Zoom changes only the display; crop points always remain in original-image pixels. */
export function useCropViewport(width: number, height: number) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 320, height: 400 });
  const [zoom, setZoom] = useState(1);
  const pendingCenter = useRef<{ x: number; y: number } | null>(null);
  const availableWidth = Math.max(1, size.width - VIEWPORT_PADDING);
  const availableHeight = Math.max(1, size.height - VIEWPORT_PADDING);
  const fitWidth = Math.min(availableWidth, availableHeight * (width / height));
  const stageWidth = fitWidth * zoom;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => {
      if (viewport.clientWidth > 0 && viewport.clientHeight > 0) {
        setSize({ width: viewport.clientWidth, height: viewport.clientHeight });
      }
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => {
        window.removeEventListener('resize', measure);
      };
    }
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => {
      observer.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const stage = stageRef.current;
    const center = pendingCenter.current;
    if (!viewport || !stage || !center) return;
    const bounds = stage.getBoundingClientRect();
    const view = viewport.getBoundingClientRect();
    viewport.scrollLeft +=
      bounds.left - view.left + bounds.width * center.x - viewport.clientWidth / 2;
    viewport.scrollTop +=
      bounds.top - view.top + bounds.height * center.y - viewport.clientHeight / 2;
    pendingCenter.current = null;
  }, [stageWidth, zoom]);

  const changeZoom = (value: number, center?: { x: number; y: number }) => {
    const next = Math.max(1, Math.min(MAX_ZOOM, value));
    const viewport = viewportRef.current;
    const stage = stageRef.current;
    if (!center && viewport && stage) {
      const bounds = stage.getBoundingClientRect();
      const view = viewport.getBoundingClientRect();
      center = {
        x:
          bounds.width > 0
            ? (view.left + viewport.clientWidth / 2 - bounds.left) / bounds.width
            : 0.5,
        y:
          bounds.height > 0
            ? (view.top + viewport.clientHeight / 2 - bounds.top) / bounds.height
            : 0.5,
      };
    }
    pendingCenter.current = center ?? { x: 0.5, y: 0.5 };
    if (next === zoom && viewport && stage) {
      const bounds = stage.getBoundingClientRect();
      const view = viewport.getBoundingClientRect();
      viewport.scrollLeft +=
        bounds.left - view.left + bounds.width * pendingCenter.current.x - viewport.clientWidth / 2;
      viewport.scrollTop +=
        bounds.top - view.top + bounds.height * pendingCenter.current.y - viewport.clientHeight / 2;
      pendingCenter.current = null;
    }
    setZoom(next);
  };

  const focusDocument = (corners: DocumentCorners) => {
    const left = Math.min(...corners.map((point) => point.x));
    const right = Math.max(...corners.map((point) => point.x));
    const top = Math.min(...corners.map((point) => point.y));
    const bottom = Math.max(...corners.map((point) => point.y));
    const scale = Math.min(
      availableWidth / Math.max(1, right - left),
      availableHeight / Math.max(1, bottom - top),
    );
    changeZoom(((scale * width) / fitWidth) * 0.8, {
      x: (left + right) / (2 * width),
      y: (top + bottom) / (2 * height),
    });
  };

  return { viewportRef, stageRef, stageWidth, zoom, changeZoom, focusDocument, maxZoom: MAX_ZOOM };
}
