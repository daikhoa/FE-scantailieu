import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { downloadBlob } from '../export/download-blob';
import { createImagePdf } from '../export/image-pdf';
import type { ScanBatchPage } from './scan-batch';
import type { RestorationWarning } from '../../imaging/restoration/restoration-types';

interface ScanBatchReviewProps {
  readonly pages: readonly ScanBatchPage[];
  readonly headingRef: RefObject<HTMLHeadingElement | null> | null;
  readonly onCaptureMore: () => void;
  readonly onEditPage: (id: string) => void;
  readonly onRetakePage: (id: string) => void;
  readonly onRetryPage: (id: string) => void;
  readonly onRemovePage: (id: string) => void;
  readonly pdfExporter?: typeof createImagePdf;
  readonly download?: (blob: Blob, filename: string) => void;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

type ReadyScanBatchPage = Extract<ScanBatchPage, { readonly kind: 'ready' }>;

const RESTORATION_WARNING_LABELS: Record<RestorationWarning, string> = {
  'retake-finger': 'Tay đang che tài liệu — nên chụp lại trang này.',
  'unsupported-moire': 'Có vân moiré — bộ xử lý hiện tại chưa khử hoàn toàn.',
};

function pageWarnings(page: ReadyScanBatchPage): readonly RestorationWarning[] {
  const restoration = page.page.restoration;
  return restoration?.kind === 'classified-local' || restoration?.kind === 'applied'
    ? restoration.warnings
    : [];
}

function PagePreview({
  page,
  number,
}: {
  readonly page: ReadyScanBatchPage;
  readonly number: number;
}) {
  const url = useMemo(() => URL.createObjectURL(page.page.variant.image.blob), [page]);

  useEffect(
    () => () => {
      URL.revokeObjectURL(url);
    },
    [url],
  );

  return (
    <img src={url} alt={`Bản xem trước trang ${String(number)}`} loading="lazy" decoding="async" />
  );
}

export function ScanBatchReview({
  pages,
  headingRef,
  onCaptureMore,
  onEditPage,
  onRetakePage,
  onRetryPage,
  onRemovePage,
  pdfExporter = createImagePdf,
  download = downloadBlob,
}: ScanBatchReviewProps) {
  const [exporting, setExporting] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);
  const exportOperation = useRef<AbortController | null>(null);
  const readyPages = useMemo(() => pages.filter((page) => page.kind === 'ready'), [pages]);
  const pendingCount = pages.filter(
    (page) =>
      page.kind === 'queued' ||
      page.kind === 'processing' ||
      (page.kind === 'ready' && page.page.restoration?.kind === 'processing'),
  ).length;
  const failedCount = pages.filter((page) => page.kind === 'failed').length;
  const canExport = pages.length > 0 && readyPages.length === pages.length && pendingCount === 0;

  useEffect(
    () => () => {
      exportOperation.current?.abort();
      exportOperation.current = null;
    },
    [],
  );

  const exportPdf = async () => {
    if (!canExport || exporting) return;
    const controller = new AbortController();
    exportOperation.current?.abort();
    exportOperation.current = controller;
    setExportFailed(false);
    setExporting(true);
    try {
      const pdf = await pdfExporter(
        readyPages.map((page) => page.page.variant.image),
        controller.signal,
      );
      if (exportOperation.current !== controller) return;
      download(pdf, 'clonecamscanner.pdf');
    } catch (error) {
      if (exportOperation.current === controller && !isAbort(error)) setExportFailed(true);
    } finally {
      if (exportOperation.current === controller) {
        exportOperation.current = null;
        setExporting(false);
      }
    }
  };

  return (
    <main id="main-content" className="app-main batch-review" aria-label="Tài liệu nhiều trang">
      <button className="back-button" type="button" onClick={onCaptureMore}>
        <span aria-hidden="true">←</span>
        Chụp thêm trang
      </button>

      <section className="batch-review__content" aria-labelledby="batch-review-title">
        <header className="batch-review__heading">
          <p className="eyebrow">Tài liệu nhiều trang</p>
          <h1 id="batch-review-title" ref={headingRef} tabIndex={-1}>
            Kiểm tra {pages.length} trang
          </h1>
          <p>
            Các trang giữ đúng thứ tự chụp. Bạn có thể chụp thêm hoặc chỉnh từng trang trước khi tạo
            PDF.
          </p>
        </header>

        {pages.length === 0 ? (
          <div className="batch-review__empty">
            <strong>Chưa còn trang nào</strong>
            <p>Chụp một trang mới để tiếp tục tạo tài liệu.</p>
            <button className="primary-button" type="button" onClick={onCaptureMore}>
              Chụp trang mới
            </button>
          </div>
        ) : (
          <ol className="batch-page-list" aria-label="Các trang đã chụp">
            {pages.map((page, index) => {
              const number = index + 1;
              const warnings = page.kind === 'ready' ? pageWarnings(page) : [];
              return (
                <li className={`batch-page batch-page--${page.kind}`} key={page.id}>
                  {page.kind === 'ready' ? (
                    <button
                      className="batch-page__preview"
                      type="button"
                      aria-label={`Chỉnh trang ${String(number)}`}
                      onClick={() => {
                        onEditPage(page.id);
                      }}
                    >
                      <PagePreview page={page} number={number} />
                    </button>
                  ) : (
                    <div
                      className="batch-page__preview batch-page__placeholder"
                      role="img"
                      aria-label={
                        page.kind === 'failed'
                          ? `Trang ${String(number)} chưa xử lý được`
                          : `Trang ${String(number)} đang xử lý`
                      }
                    >
                      <span aria-hidden="true" />
                    </div>
                  )}
                  <div className="batch-page__details">
                    <strong>Trang {number}</strong>
                    {page.kind === 'queued' || page.kind === 'processing' ? (
                      <span>Đang xử lý</span>
                    ) : page.kind === 'failed' ? (
                      <span>Cần xử lý lại</span>
                    ) : page.page.restoration?.kind === 'processing' ? (
                      <span>Đang hoàn thiện trên thiết bị</span>
                    ) : page.page.restoration?.kind === 'applied' ? (
                      <span>Đã tối ưu trên thiết bị</span>
                    ) : page.page.restoration?.kind === 'fallback' ? (
                      <span>Đã dùng bản xử lý cục bộ</span>
                    ) : (
                      <span>Đã sẵn sàng</span>
                    )}
                    {warnings.map((warning) => (
                      <span className="batch-page__warning" role="alert" key={warning}>
                        {RESTORATION_WARNING_LABELS[warning]}
                      </span>
                    ))}
                  </div>
                  <div className="batch-page__actions">
                    {page.kind === 'ready' || page.kind === 'failed' ? (
                      <button
                        type="button"
                        onClick={() => {
                          onRetakePage(page.id);
                        }}
                      >
                        Chụp lại trang {number}
                      </button>
                    ) : null}
                    {page.kind === 'failed' ? (
                      <button
                        type="button"
                        onClick={() => {
                          onRetryPage(page.id);
                        }}
                      >
                        Xử lý lại trang {number}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => {
                        onRemovePage(page.id);
                      }}
                    >
                      Xóa trang {number}
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        {pendingCount > 0 ? (
          <p className="editor__status" role="status" aria-live="polite">
            Đang hoàn tất {pendingCount} trang…
          </p>
        ) : failedCount > 0 ? (
          <p className="editor__error" role="alert">
            Có {failedCount} trang chưa xử lý được. Hãy xử lý lại hoặc xóa trang đó trước khi tạo
            PDF.
          </p>
        ) : pages.length > 0 ? (
          <p className="editor__status" role="status">
            Tất cả trang đã sẵn sàng để tạo PDF.
          </p>
        ) : null}

        {exportFailed ? (
          <p className="editor__error" role="alert">
            Không thể tạo PDF. Các trang vẫn được giữ nguyên và bạn có thể thử lại.
          </p>
        ) : null}

        {pages.length > 0 ? (
          <button
            className="primary-button batch-review__export"
            type="button"
            aria-label={`Tải PDF ${String(pages.length)} trang`}
            aria-busy={exporting}
            disabled={!canExport || exporting}
            onClick={() => void exportPdf()}
          >
            {exporting ? 'Đang tạo PDF…' : `Tải PDF ${String(pages.length)} trang`}
          </button>
        ) : null}
      </section>
    </main>
  );
}
