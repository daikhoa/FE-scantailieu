import { useEffect, useRef } from 'react';
import type { PdfPreviewPage } from './PdfPreview';
import { PdfPageImage } from './PdfPageImage';

/** Generated PDFs contain these page images in this order, fitted to A4. No native PDF plugin needed. */
export function PdfReader({
  pages,
  name,
  onClose,
}: {
  readonly pages: readonly PdfPreviewPage[];
  readonly name: string;
  readonly onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement;
    dialog.current?.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="pdf-reader"
      aria-label="Đọc PDF"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="pdf-reader__toolbar">
        <div>
          <strong>{name}</strong>
          <span>{pages.length} trang · A4</span>
        </div>
        <button type="button" onClick={onClose} aria-label="Đóng trình đọc PDF">
          Đóng
        </button>
      </header>
      <div className="pdf-reader__pages" tabIndex={0} aria-label="Các trang PDF">
        {pages.map((page, index) => (
          <section key={page.id} aria-label={`Trang PDF ${String(index + 1)}`}>
            <div className="pdf-workspace__sheet">
              <PdfPageImage image={page.image} number={index + 1} lazy />
            </div>
            <p>
              Trang {index + 1} / {pages.length}
            </p>
          </section>
        ))}
      </div>
    </dialog>
  );
}
