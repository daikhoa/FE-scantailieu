import type { PdfPreviewPage } from './PdfPreview';
import { PdfPageImage } from './PdfPageImage';

/** Generated PDFs contain these page images in this order, fitted to A4. No native PDF plugin needed. */
export function PdfReader({ pages }: { readonly pages: readonly PdfPreviewPage[] }) {
  return (
    <section className="pdf-reader__pages" aria-label="Các trang PDF">
      {pages.map((page, index) => (
        <section key={page.id} aria-label={`Trang PDF ${String(index + 1)}`}>
          <div className="pdf-workspace__sheet">
            <PdfPageImage image={page.image} number={index + 1} lazy={index > 0} />
          </div>
          <p>
            Trang {index + 1} / {pages.length}
          </p>
        </section>
      ))}
    </section>
  );
}
