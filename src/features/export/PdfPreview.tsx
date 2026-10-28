import { useEffect, useRef, useState } from 'react';
import type { ImageAsset } from '../../domain/document';
import { PdfReader } from './PdfReader';
import { PdfShareButton } from './PdfShareButton';
import './pdf-preview.css';

export interface PdfPreviewPage {
  readonly id: string;
  readonly image: ImageAsset | string;
}

export function PdfPreview({
  pages,
  pdf,
  loadPdf,
  name: initialName = 'clonecamscanner',
  onBack,
  onLibrary,
  onSave,
  onEdit,
  onNameChange,
  fileUrl,
  download,
  saved = false,
}: {
  readonly pages: readonly PdfPreviewPage[];
  readonly pdf?: Blob;
  readonly loadPdf?: (signal: AbortSignal) => Promise<Blob>;
  readonly name?: string;
  readonly onBack: () => void;
  readonly onLibrary?: () => void;
  readonly onSave?: (name: string, signal: AbortSignal) => Promise<void>;
  readonly onEdit?: () => void;
  readonly onNameChange?: (name: string) => void;
  readonly fileUrl?: string;
  readonly download?: (blob: Blob, filename: string) => void;
  readonly saved?: boolean;
}) {
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [wasSaved, setWasSaved] = useState(saved);
  const [error, setError] = useState('');
  const [actionHint, setActionHint] = useState('');
  const operation = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const downloadLink = useRef<HTMLAnchorElement>(null);
  const filename = `${
    Array.from(name.trim())
      .filter((character) => character.charCodeAt(0) >= 32)
      .join('')
      .replace(/[\\/:*?"<>|]/gu, '_') || 'document'
  }.pdf`;
  const goLibrary = onLibrary ?? (onEdit ? onBack : undefined);

  useEffect(() => {
    heading.current?.focus();
    return () => operation.current?.abort();
  }, []);
  useEffect(() => {
    if (fileUrl || !pdf) return;
    const url = URL.createObjectURL(pdf);
    if (downloadLink.current) downloadLink.current.href = url;
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [pdf, fileUrl]);

  const save = async (prepareDownload = false) => {
    if (!onSave || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError('');
    setActionHint('');
    try {
      await onSave(name.trim(), controller.signal);
      if (!controller.signal.aborted) {
        setWasSaved(true);
        if (prepareDownload) setActionHint('PDF đã sẵn sàng. Bấm Tải PDF để lưu về máy.');
      }
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof Error ? failure.message : 'Chưa lưu được tài liệu. Hãy thử lại.',
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (operation.current === controller) operation.current = null;
    }
  };

  return (
    <main id="main-content" className="app-main pdf-workspace">
      <header className="pdf-workspace__toolbar">
        {goLibrary && (
          <button className="back-button" type="button" disabled={busy} onClick={goLibrary}>
            ← Kho tài liệu
          </button>
        )}
        <p className="eyebrow">{pages.length} trang · PDF</p>
        <h1 ref={heading} tabIndex={-1}>
          Tài liệu PDF
        </h1>
        <div className="pdf-workspace__actions">
          {onSave && !wasSaved && (
            <button
              type="button"
              className="primary-button"
              disabled={busy || !name.trim() || wasSaved}
              aria-busy={busy}
              onClick={() => void save()}
            >
              {busy ? 'Đang lưu…' : 'Lưu thay đổi'}
            </button>
          )}
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={onEdit ?? onBack}
          >
            Chỉnh sửa tài liệu
          </button>
          <a
            ref={downloadLink}
            href={
              fileUrl ? `${fileUrl}${fileUrl.includes('?') ? '&' : '?'}download=true` : undefined
            }
            className="pdf-action"
            download={filename}
            aria-disabled={busy}
            onClick={(event) => {
              if (busy) {
                event.preventDefault();
                return;
              }
              // A separate second gesture follows saving: WebKit may block a delayed popup/download.
              if (!fileUrl && onSave) {
                event.preventDefault();
                void save(true);
                return;
              }
              setError('');
              try {
                if (download && pdf) {
                  event.preventDefault();
                  download(pdf, filename);
                }
                setActionHint(
                  'Nếu chưa thấy PDF trong Tệp hoặc Tải xuống, hãy dùng Chia sẻ / Lưu vào Tệp.',
                );
              } catch {
                event.preventDefault();
                setError('Chưa tải được PDF. Hãy dùng Chia sẻ / Lưu vào Tệp.');
              }
            }}
          >
            Tải PDF
          </a>
          <PdfShareButton
            {...(pdf ? { pdf } : {})}
            {...(loadPdf ? { loadPdf } : {})}
            filename={filename}
            title={name}
          />
        </div>
        {wasSaved && <p role="status">Tài liệu đã được lưu trong tài khoản.</p>}
      </header>
      {onSave ? (
        <details className="pdf-workspace__rename">
          <summary>Đổi tên tài liệu</summary>
          <label htmlFor="pdf-name">Tên tài liệu</label>
          <input
            id="pdf-name"
            value={name}
            maxLength={160}
            disabled={busy}
            onChange={(event) => {
              setName(event.target.value);
              onNameChange?.(event.target.value);
              setWasSaved(false);
              setActionHint('');
            }}
          />
        </details>
      ) : (
        <p className="pdf-workspace__name">{name}</p>
      )}
      {actionHint && <p role="status">{actionHint}</p>}
      {onSave && !fileUrl && (
        <p className="pdf-workspace__hint">
          Lưu tài liệu trước khi tải PDF trên điện thoại. Bạn có thể dùng Chia sẻ / Lưu vào Tệp
          ngay.
        </p>
      )}
      {error && (
        <p className="editor__error" role="alert">
          {error}
        </p>
      )}
      <PdfReader pages={pages} />
    </main>
  );
}
