import { useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';

interface PageDrag {
  readonly id: string;
  readonly pointer: number;
  readonly before: readonly string[];
  x: number;
  y: number;
}

/** Capture only the grip: the rest of the grid keeps native touch scrolling. */
export function usePageOrderDrag(
  grid: RefObject<HTMLOListElement | null>,
  order: readonly string[],
  move: (id: string, targetId: string) => void,
  restore: (ids: readonly string[]) => void,
) {
  const drag = useRef<PageDrag | null>(null);
  const frame = useRef<number | null>(null);
  const moveRef = useRef(move);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  useEffect(() => {
    moveRef.current = move;
  }, [move]);
  const hitTarget = () => {
    const current = drag.current;
    const list = grid.current;
    if (!current || !list) return;
    const hit = list.ownerDocument
      .elementFromPoint(current.x, current.y)
      ?.closest<HTMLElement>('[data-order-id]');
    if (hit && list.contains(hit) && hit.dataset.orderId)
      moveRef.current(current.id, hit.dataset.orderId);
  };
  const scrollAtEdge = () => {
    const current = drag.current;
    const list = grid.current;
    if (!current || !list) return;
    const bounds = list.getBoundingClientRect();
    const edge = Math.min(64, bounds.height / 4);
    const step = current.y < bounds.top + edge ? -10 : current.y > bounds.bottom - edge ? 10 : 0;
    if (step !== 0) {
      list.scrollBy({ top: step });
      hitTarget();
    }
    frame.current = requestAnimationFrame(scrollAtEdge);
  };
  const stop = (cancel: boolean) => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (cancel && drag.current) restore(drag.current.before);
    drag.current = null;
    setDraggingId(null);
  };
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      drag.current = null;
    },
    [],
  );
  return {
    draggingId,
    start: (event: PointerEvent<HTMLButtonElement>, id: string) => {
      if (drag.current || event.button !== 0) return;
      event.preventDefault();
      drag.current = {
        id,
        pointer: event.pointerId,
        before: order,
        x: event.clientX,
        y: event.clientY,
      };
      setDraggingId(id);
      event.currentTarget.focus({ preventScroll: true });
      if (typeof event.currentTarget.setPointerCapture === 'function')
        event.currentTarget.setPointerCapture(event.pointerId);
      frame.current = requestAnimationFrame(scrollAtEdge);
    },
    update: (event: PointerEvent<HTMLButtonElement>) => {
      if (drag.current?.pointer !== event.pointerId) return;
      drag.current.x = event.clientX;
      drag.current.y = event.clientY;
      hitTarget();
    },
    end: () => {
      stop(false);
    },
    cancel: () => {
      stop(true);
    },
  };
}
