import { useEffect, useRef, useState } from 'react';
import { AssetImage } from '../../components/AssetImage';
import { ActionIcon } from '../../components/ActionIcon';
import { PendingPagePreview } from './PendingPagePreview';
import type { ScanBatchPage } from './scan-batch';
import { usePageOrderDrag } from './use-page-order-drag';
import './page-order.css';

interface PageOrderEditorProps {
  readonly pages: readonly ScanBatchPage[];
  readonly selectedPageId: string | null;
  readonly onApply: (ids: readonly string[]) => void;
  readonly onCancel: () => void;
}

function movePage(order: readonly string[], id: string, index: number): readonly string[] {
  const from = order.indexOf(id);
  if (from < 0 || from === index || index < 0 || index >= order.length) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(index, 0, id);
  return next;
}

export function PageOrderEditor({
  pages,
  selectedPageId,
  onApply,
  onCancel,
}: PageOrderEditorProps) {
  // Keep only IDs in the draft, so a background-loaded/edited page never becomes stale.
  const [order, setOrder] = useState<readonly string[]>(() => pages.map((page) => page.id));
  const [selected, setSelected] = useState(selectedPageId ?? pages[0]?.id ?? null);
  const grid = useRef<HTMLOListElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const byId = new Map(pages.map((page) => [page.id, page]));
  const selectedIndex = order.findIndex((id) => id === selected);
  const moveTo = (id: string, index: number) => {
    setOrder((current) => movePage(current, id, index));
  };
  const drag = usePageOrderDrag(
    grid,
    order,
    (id, targetId) => {
      setOrder((current) => movePage(current, id, current.indexOf(targetId)));
    },
    setOrder,
  );

  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <section className="page-order" aria-labelledby="page-order-title">
      <header className="page-order__heading">
        <button type="button" onClick={onCancel}>
          Hủy
        </button>
        <h1 id="page-order-title" ref={heading} tabIndex={-1}>
          Sắp xếp trang
        </h1>
        <button
          className="primary-button"
          type="button"
          onClick={() => {
            onApply(order);
          }}
        >
          Xong
        </button>
      </header>
      <p className="page-order__hint">
        Kéo nút ⠿ để đổi chỗ. Hoặc chạm chọn trang rồi đưa tới vị trí bên dưới.
      </p>
      <ol ref={grid} className="page-order__grid" aria-label="Thứ tự các trang PDF">
        {order.map((id, index) => {
          const page = byId.get(id);
          if (!page) return null;
          return (
            <li
              key={id}
              data-order-id={id}
              className={`page-order__page${selected === id ? ' page-order__page--selected' : ''}${drag.draggingId === id ? ' page-order__page--dragging' : ''}`}
            >
              <button
                className="page-order__preview"
                type="button"
                aria-label={`Chọn trang ${String(index + 1)} để sắp xếp`}
                aria-pressed={selected === id}
                onClick={() => {
                  setSelected(id);
                }}
              >
                {page.kind === 'ready' ? (
                  <AssetImage
                    image={page.page.variant.thumbnail ?? page.page.variant.image}
                    alt={`Trang ${String(index + 1)}`}
                  />
                ) : page.kind === 'loading-saved' || page.kind === 'failed-saved' ? (
                  <img src={page.previewUrl} alt={`Trang ${String(index + 1)}`} loading="lazy" />
                ) : page.preview ? (
                  <PendingPagePreview preview={page.preview} number={index + 1} />
                ) : (
                  <span>Đang xử lý…</span>
                )}
              </button>
              <div className="page-order__caption">
                <span>
                  {selected === id ? '✓ ' : ''}Trang {index + 1}
                </span>
                <button
                  type="button"
                  className="page-order__grip"
                  aria-label={`Kéo trang ${String(index + 1)} để đổi thứ tự`}
                  onClick={() => {
                    setSelected(id);
                  }}
                  onKeyDown={(event) => {
                    const offset =
                      event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                        ? -1
                        : event.key === 'ArrowRight' || event.key === 'ArrowDown'
                          ? 1
                          : 0;
                    if (offset) {
                      event.preventDefault();
                      setSelected(id);
                      moveTo(id, index + offset);
                    }
                  }}
                  onPointerDown={(event) => {
                    setSelected(id);
                    drag.start(event, id);
                  }}
                  onPointerMove={drag.update}
                  onPointerUp={drag.end}
                  onPointerCancel={drag.cancel}
                  onLostPointerCapture={drag.cancel}
                >
                  <span aria-hidden="true">⠿</span>
                </button>
              </div>
            </li>
          );
        })}
      </ol>
      <footer className="page-order__controls">
        <p role="status" aria-live="polite">
          Đang chọn trang {selectedIndex + 1} / {order.length}
        </p>
        <div>
          <button
            type="button"
            disabled={selectedIndex <= 0}
            onClick={() => {
              if (selected) moveTo(selected, selectedIndex - 1);
            }}
          >
            <ActionIcon name="back" /> Lên trước
          </button>
          <label>
            Đưa tới vị trí
            <select
              aria-label="Đưa trang đã chọn tới vị trí"
              value={selectedIndex + 1}
              onChange={(event) => {
                if (selected) moveTo(selected, Number(event.target.value) - 1);
              }}
            >
              {order.map((id, index) => (
                <option key={id} value={index + 1}>
                  {index + 1}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={selectedIndex >= order.length - 1}
            onClick={() => {
              if (selected) moveTo(selected, selectedIndex + 1);
            }}
          >
            Xuống sau <span aria-hidden="true">›</span>
          </button>
        </div>
        <small>Bấm Xong, sau đó PDF để lưu thứ tự mới.</small>
      </footer>
    </section>
  );
}
