import { useEffect, useRef, useState } from 'react';
import type { ImageAsset } from '../../domain/document';
import { PdfPageImage } from './PdfPageImage';
import { PdfReader } from './PdfReader';
import './pdf-preview.css';

export interface PdfPreviewPage {
  readonly id: string;
  readonly image: ImageAsset | string;
}

export function PdfPreview({
  pages,
  pdf,
  name: initialName = 'clonecamscanner',
  onBack,
  onSave,
  onEdit,
  onNameChange,
  fileUrl,
  download,
  saved = false,
}: {
  readonly pages: readonly PdfPreviewPage[];
  readonly pdf: Blob;
  readonly name?: string;
  readonly onBack: () => void;
  readonly onSave?: (name: string, signal: AbortSignal) => Promise<void>;
  readonly onEdit?: () => void;
  readonly onNameChange?: (name: string) => void;
  readonly fileUrl?: string;
  readonly download?: (blob: Blob, filename: string) => void;
  readonly saved?: boolean;
}) {
  const [index, setIndex] = useState(0);
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [wasSaved, setWasSaved] = useState(saved);
  const [error, setError] = useState('');
  const [actionHint, setActionHint] = useState('');
  const [reading, setReading] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const page = pages[index];
  const downloadLink = useRef<HTMLAnchorElement>(null);
  const filename = `${
    Array.from(name.trim())
      .filter((character) => character.charCodeAt(0) >= 32)
      .join('')
      .replace(/[\\/:*?"<>|]/gu, '_') || 'document'
  }.pdf`;
  const file = new File([pdf], filename, { type: 'application/pdf' });
  let canShare = false;
  try {
    canShare = typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  } catch {
    /* File sharing is optional in embedded browsers. */
  }

  useEffect(() => {
    heading.current?.focus();
    return () => operation.current?.abort();
  }, []);
  useEffect(() => {
    const url = fileUrl ?? URL.createObjectURL(pdf);
    if (downloadLink.current)
      downloadLink.current.href = fileUrl
        ? `${fileUrl}${fileUrl.includes('?') ? '&' : '?'}download=true`
        : url;
    return () => {
      if (!fileUrl) URL.revokeObjectURL(url);
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

  const share = () => {
    // Invoke directly in the gesture; awaiting PDF generation here loses mobile user activation.
    void navigator.share({ files: [file], title: name }).catch((failure: unknown) => {
      if (!(failure instanceof Error && failure.name === 'AbortError'))
        setError('Chưa chia sẻ được PDF. Hãy dùng Tải PDF hoặc Mở PDF.');
    });
  };

  return (
    <main id="main-content" className="app-main pdf-workspace">
      <button className="back-button" type="button" disabled={busy} onClick={onBack}>
        ← {onEdit ? 'Kho tài liệu' : 'Quay lại chỉnh sửa'}
      </button>
      <header>
        <p className="eyebrow">{pages.length} trang · PDF</p>
        <h1 ref={heading} tabIndex={-1}>
          Xem trước PDF
        </h1>
      </header>
      <label htmlFor="pdf-name">Tên tài liệu</label>
      <input
        id="pdf-name"
        value={name}
        maxLength={160}
        readOnly={!onSave}
        disabled={busy}
        onChange={(event) => {
          setName(event.target.value);
          onNameChange?.(event.target.value);
          setWasSaved(false);
          setActionHint('');
        }}
      />
      <div className="pdf-workspace__page" aria-label={`Trang PDF ${String(index + 1)}`}>
        <div className="pdf-workspace__sheet">
          {page && <PdfPageImage image={page.image} number={index + 1} />}
        </div>
      </div>
      <div className="pdf-workspace__pager" role="group" aria-label="Chuyển trang PDF">
        <button
          type="button"
          disabled={index === 0}
          onClick={() => {
            setIndex(index - 1);
          }}
        >
          ← Trang trước
        </button>
        <span aria-live="polite">
          {index + 1} / {pages.length}
        </span>
        <button
          type="button"
          disabled={index >= pages.length - 1}
          onClick={() => {
            setIndex(index + 1);
          }}
        >
          Trang sau →
        </button>
      </div>
      <p className="pdf-workspace__hint">
        Mỗi trang PDF dùng khổ A4 dọc. Ảnh được căn giữa, giữ tỷ lệ và nằm trọn trong trang.
      </p>
      <div className="pdf-workspace__actions">
        {onSave && (
          <button
            type="button"
            className="primary-button"
            disabled={busy || !name.trim() || wasSaved}
            aria-busy={busy}
            onClick={() => void save()}
          >
            {busy ? 'Đang lưu…' : wasSaved ? 'Đã lưu' : 'Lưu vào tài khoản'}
          </button>
        )}
        {onEdit && (
          <button type="button" className="primary-button" onClick={onEdit}>
            Chỉnh sửa tài liệu
          </button>
        )}
        <a
          ref={downloadLink}
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
              if (download) {
                event.preventDefault();
                download(pdf, filename);
              }
              setActionHint(
                'Nếu chưa thấy PDF trong Tệp hoặc Tải xuống, hãy dùng Chia sẻ / Lưu vào Tệp.',
              );
            } catch {
              event.preventDefault();
              setError('Chưa tải được PDF. Hãy chọn Mở PDF hoặc Chia sẻ.');
            }
          }}
        >
          Tải PDF
        </a>
        <button
          type="button"
          onClick={() => {
            setReading(true);
          }}
        >
          Mở PDF
        </button>
        {canShare && (
          <button type="button" onClick={share}>
            Chia sẻ / Lưu vào Tệp
          </button>
        )}
      </div>
      {wasSaved && <p role="status">Tài liệu đã được lưu trong tài khoản.</p>}
      {actionHint && <p role="status">{actionHint}</p>}
      {onSave && !fileUrl && (
        <p className="pdf-workspace__hint">
          Lưu tài liệu trước khi tải PDF trên điện thoại. Bạn có thể Mở PDF hoặc Chia sẻ / Lưu vào
          Tệp ngay.
        </p>
      )}
      {error && (
        <p className="editor__error" role="alert">
          {error}
        </p>
      )}
      {reading && (
        <PdfReader
          pages={pages}
          name={name}
          onClose={() => {
            setReading(false);
          }}
        />
      )}
    </main>
  );
}
