import { useEffect, useMemo, useRef, useState, type RefObject, type UIEvent } from 'react';

import type { EditRecipe, QuarterTurn } from '../../domain/document';
import type { RestorationWarning } from '../../imaging/restoration/restoration-types';
import { DOCUMENT_FILTERS, recipeWithFilter } from '../editor/document-filters';
import { ManualCropEditor } from '../editor/ManualCropEditor';
import { downloadBlob } from '../export/download-blob';
import { createImagePdf } from '../export/image-pdf';
import type { ScanBatchPage } from './scan-batch';
import { PendingPagePreview } from './PendingPagePreview';
import { shadowFallbackMessage } from '../editor/shadow-status';

interface ScanBatchReviewProps {
  readonly pages: readonly ScanBatchPage[];
  readonly headingRef: RefObject<HTMLHeadingElement | null> | null;
  readonly onCaptureMore: () => void;
  readonly onBack?: () => void;
  readonly onApplyRecipe: (id: string, recipe: EditRecipe) => Promise<void>;
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
  'retake-blur': 'Ảnh quá mờ — nên chụp lại để đọc rõ chữ.',
  'retake-finger': 'Tay đang che tài liệu — nên chụp lại trang này.',
  'retake-curved': 'Trang bị cong mạnh — nên ép phẳng và chụp lại để OCR chính xác hơn.',
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
  selected,
}: {
  readonly page: ReadyScanBatchPage;
  readonly number: number;
  readonly selected: boolean;
}) {
  const asset = selected
    ? page.page.variant.image
    : (page.page.variant.thumbnail ?? page.page.variant.image);
  const url = useMemo(() => URL.createObjectURL(asset.blob), [asset]);
  const { width, height } = page.page.variant.image.dimensions;

  useEffect(
    () => () => {
      URL.revokeObjectURL(url);
    },
    [url],
  );

  return (
    <img
      src={url}
      width={width}
      height={height}
      alt={`Bản xem trước trang ${String(number)}`}
      loading="eager"
      decoding="async"
    />
  );
}

function rotateLeft(rotation: QuarterTurn): QuarterTurn {
  return rotation === 0 ? 270 : rotation === 90 ? 0 : rotation === 180 ? 90 : 180;
}

export function ScanBatchReview({
  pages,
  headingRef,
  onCaptureMore,
  onBack,
  onApplyRecipe,
  onRetakePage,
  onRetryPage,
  onRemovePage,
  pdfExporter = createImagePdf,
  download = downloadBlob,
}: ScanBatchReviewProps) {
  const [selectedPageId, setSelectedPageId] = useState<string | null>(() => pages[0]?.id ?? null);
  const [croppingPageId, setCroppingPageId] = useState<string | null>(null);
  const [busyPageId, setBusyPageId] = useState<string | null>(null);
  const [operationFailed, setOperationFailed] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);
  const exportOperation = useRef<AbortController | null>(null);
  const carouselRef = useRef<HTMLOListElement>(null);
  const readyPages = useMemo(() => pages.filter((page) => page.kind === 'ready'), [pages]);
  const pendingCount = pages.filter(
    (page) =>
      page.kind === 'queued' ||
      page.kind === 'processing' ||
      (page.kind === 'ready' && page.page.restoration?.kind === 'processing'),
  ).length;
  const failedCount = pages.filter((page) => page.kind === 'failed').length;
  const canExport = pages.length > 0 && readyPages.length === pages.length && pendingCount === 0;
  const effectiveSelectedPageId = pages.some((page) => page.id === selectedPageId)
    ? selectedPageId
    : (pages[0]?.id ?? null);
  const selectedIndex = Math.max(
    0,
    pages.findIndex((page) => page.id === effectiveSelectedPageId),
  );
  const selectedPage = pages[selectedIndex] ?? null;
  const selectedNumber = selectedPage === null ? 0 : selectedIndex + 1;
  const croppingPage =
    croppingPageId === null
      ? null
      : (pages.find(
          (page): page is ReadyScanBatchPage => page.id === croppingPageId && page.kind === 'ready',
        ) ?? null);

  useEffect(
    () => () => {
      exportOperation.current?.abort();
      exportOperation.current = null;
    },
    [],
  );

  const selectIndex = (index: number) => {
    const boundedIndex = Math.min(Math.max(index, 0), pages.length - 1);
    const page = pages[boundedIndex];
    if (page === undefined) return;
    setSelectedPageId(page.id);
    const element = carouselRef.current?.querySelector<HTMLElement>(`[data-page-id="${page.id}"]`);
    if (element !== null && element !== undefined && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  };

  const selectClosestVisiblePage = (event: UIEvent<HTMLOListElement>) => {
    const viewport = event.currentTarget.getBoundingClientRect();
    if (viewport.width === 0) return;
    const center = viewport.left + viewport.width / 2;
    let closest: { readonly id: string; readonly distance: number } | null = null;
    for (const element of event.currentTarget.querySelectorAll<HTMLElement>('[data-page-id]')) {
      const bounds = element.getBoundingClientRect();
      const distance = Math.abs(bounds.left + bounds.width / 2 - center);
      const id = element.dataset.pageId;
      if (id !== undefined && (closest === null || distance < closest.distance)) {
        closest = { id, distance };
      }
    }
    if (closest !== null) setSelectedPageId(closest.id);
  };

  const applyRecipe = async (page: ReadyScanBatchPage, recipe: EditRecipe): Promise<boolean> => {
    if (busyPageId !== null) return false;
    setBusyPageId(page.id);
    setOperationFailed(false);
    try {
      await onApplyRecipe(page.id, recipe);
      return true;
    } catch (error) {
      if (!isAbort(error)) setOperationFailed(true);
      return false;
    } finally {
      setBusyPageId(null);
    }
  };

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

  if (croppingPage !== null) {
    return (
      <main
        id="main-content"
        className="app-main batch-review batch-review--cropping"
        aria-label="Cắt trang tài liệu"
      >
        <ManualCropEditor
          original={croppingPage.page.original}
          {...(croppingPage.page.originalPreview === undefined
            ? {}
            : { preview: croppingPage.page.originalPreview })}
          initialCrop={croppingPage.page.recipe.crop}
          busy={busyPageId === croppingPage.id}
          onCancel={() => {
            setCroppingPageId(null);
          }}
          onApply={(crop) => {
            void applyRecipe(croppingPage, { ...croppingPage.page.recipe, crop }).then(
              (applied) => {
                if (applied) setCroppingPageId(null);
              },
            );
          }}
        />
      </main>
    );
  }

  return (
    <main id="main-content" className="app-main batch-review" aria-label="Tài liệu nhiều trang">
      <section className="batch-review__content" aria-labelledby="batch-review-title">
        {onBack === undefined ? null : (
          <button className="back-button" type="button" onClick={onBack}>
            <span aria-hidden="true">←</span> Trang chủ
          </button>
        )}
        <header className="batch-review__heading">
          <button
            className="batch-review__add"
            type="button"
            aria-label="Chụp thêm trang"
            onClick={onCaptureMore}
          >
            + Thêm
          </button>
          <div>
            <p className="eyebrow">Tài liệu nhiều trang</p>
            <h1 id="batch-review-title" ref={headingRef} tabIndex={-1}>
              Kiểm tra {pages.length} trang
            </h1>
          </div>
          <span className="batch-review__local">Trên thiết bị</span>
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
          <>
            <ol
              ref={carouselRef}
              className="batch-page-list"
              aria-label="Các trang tài liệu"
              onScroll={selectClosestVisiblePage}
            >
              {pages.map((page, index) => {
                const number = index + 1;
                const selected = page.id === selectedPage?.id;
                return (
                  <li
                    className={`batch-page batch-page--${page.kind}${selected ? ' batch-page--selected' : ''}`}
                    key={page.id}
                    data-page-id={page.id}
                  >
                    <button
                      className="batch-page__preview"
                      type="button"
                      aria-label={`Chọn trang ${String(number)}`}
                      aria-current={selected ? 'page' : undefined}
                      onClick={() => {
                        selectIndex(index);
                      }}
                    >
                      {page.kind === 'ready' ? (
                        <PagePreview page={page} number={number} selected={selected} />
                      ) : page.preview !== undefined ? (
                        <PendingPagePreview preview={page.preview} number={number} />
                      ) : (
                        <span
                          className="batch-page__placeholder"
                          role="img"
                          aria-label={
                            page.kind === 'failed'
                              ? `Trang ${String(number)} chưa xử lý được`
                              : `Trang ${String(number)} đang xử lý`
                          }
                        >
                          <i aria-hidden="true" />
                        </span>
                      )}
                    </button>
                    <div className="batch-page__details">
                      <strong>Trang {number}</strong>
                      <span>
                        {page.kind === 'queued' || page.kind === 'processing'
                          ? 'Đang hoàn thiện'
                          : page.kind === 'failed'
                            ? 'Cần xử lý lại'
                            : page.page.restoration?.kind === 'processing'
                              ? 'Đang hoàn thiện trên thiết bị'
                              : page.page.restoration?.kind === 'applied'
                                ? 'Đã tối ưu trên thiết bị'
                                : page.page.restoration?.kind === 'fallback'
                                  ? 'Đã dùng bản xử lý cục bộ'
                                  : 'Đã sẵn sàng'}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ol>

            <div className="batch-review__pager" aria-label="Điều hướng trang">
              <button
                type="button"
                aria-label="Trang trước"
                disabled={selectedIndex === 0}
                onClick={() => {
                  selectIndex(selectedIndex - 1);
                }}
              >
                ‹
              </button>
              <span aria-live="polite">
                {selectedNumber} / {pages.length}
              </span>
              <button
                type="button"
                aria-label="Trang kế tiếp"
                disabled={selectedIndex >= pages.length - 1}
                onClick={() => {
                  selectIndex(selectedIndex + 1);
                }}
              >
                ›
              </button>
            </div>

            {selectedPage?.kind === 'ready' ? (
              <>
                {selectedPage.page.variant.enhancement === 'model-unavailable' && (
                  <p className="batch-review__warning" role="status">
                    {shadowFallbackMessage(selectedPage.page.variant.enhancementFailure)}
                  </p>
                )}
                {pageWarnings(selectedPage).map((warning) => (
                  <p className="batch-review__warning" role="alert" key={warning}>
                    {RESTORATION_WARNING_LABELS[warning]}
                  </p>
                ))}
                <div className="batch-filter-strip" role="group" aria-label="Bộ lọc tài liệu">
                  {DOCUMENT_FILTERS.map((option) => (
                    <button
                      key={option.mode}
                      type="button"
                      aria-label={option.label}
                      aria-pressed={selectedPage.page.recipe.filter.mode === option.mode}
                      disabled={busyPageId !== null}
                      onClick={() => {
                        void applyRecipe(
                          selectedPage,
                          recipeWithFilter(selectedPage.page.recipe, option.mode),
                        );
                      }}
                    >
                      <span
                        className={`batch-filter-strip__sample batch-filter-strip__sample--${option.mode}`}
                        aria-hidden="true"
                      />
                      <strong>{option.label}</strong>
                    </button>
                  ))}
                </div>
              </>
            ) : selectedPage?.kind === 'failed' ? (
              <button
                className="batch-review__retry"
                type="button"
                onClick={() => {
                  onRetryPage(selectedPage.id);
                }}
              >
                Xử lý lại trang {selectedNumber}
              </button>
            ) : null}

            <div className="batch-action-bar" aria-label="Công cụ chỉnh trang">
              <button
                type="button"
                aria-label={`Chụp lại trang ${String(selectedNumber)}`}
                disabled={
                  selectedPage === null ||
                  selectedPage.kind === 'queued' ||
                  selectedPage.kind === 'processing'
                }
                onClick={() => {
                  if (selectedPage !== null) onRetakePage(selectedPage.id);
                }}
              >
                <span aria-hidden="true">↻</span>Chụp lại
              </button>
              <button
                type="button"
                disabled={selectedPage?.kind !== 'ready' || busyPageId !== null}
                onClick={() => {
                  if (selectedPage?.kind === 'ready')
                    void applyRecipe(selectedPage, {
                      ...selectedPage.page.recipe,
                      rotation: rotateLeft(selectedPage.page.recipe.rotation),
                    });
                }}
              >
                <span aria-hidden="true">↶</span>Xoay trái
              </button>
              <button
                type="button"
                aria-label={`Cắt trang ${String(selectedNumber)}`}
                disabled={selectedPage?.kind !== 'ready' || busyPageId !== null}
                onClick={() => {
                  if (selectedPage?.kind === 'ready') setCroppingPageId(selectedPage.id);
                }}
              >
                <span aria-hidden="true">⌗</span>Cắt
              </button>
              <button
                type="button"
                disabled={selectedPage === null || busyPageId !== null}
                onClick={() => {
                  if (selectedPage !== null) onRemovePage(selectedPage.id);
                }}
              >
                <span aria-hidden="true">⌫</span>Xóa trang {selectedNumber}
              </button>
              <button
                className="batch-action-bar__done"
                type="button"
                aria-label={`Tải PDF ${String(pages.length)} trang`}
                aria-busy={exporting}
                disabled={!canExport || exporting || busyPageId !== null}
                onClick={() => void exportPdf()}
              >
                <span aria-hidden="true">✓</span>PDF
              </button>
            </div>
          </>
        )}

        {busyPageId !== null || pendingCount > 0 ? (
          <p className="editor__status" role="status" aria-live="polite">
            {busyPageId !== null
              ? 'Đang áp dụng thay đổi…'
              : `Đang hoàn tất ${String(pendingCount)} trang…`}
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

        {operationFailed ? (
          <p className="editor__error" role="alert">
            Không thể áp dụng thay đổi. Bản trang trước vẫn được giữ nguyên.
          </p>
        ) : null}
        {exportFailed ? (
          <p className="editor__error" role="alert">
            Không thể tạo PDF. Các trang vẫn được giữ nguyên và bạn có thể thử lại.
          </p>
        ) : null}
      </section>
    </main>
  );
}
