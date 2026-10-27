import { useEffect, useRef, useState } from 'react';
import type { ImageAsset } from '../../domain/document';
import './pdf-preview.css';

export interface PdfPreviewPage {
  readonly id: string;
  readonly image: ImageAsset | string;
}

function PreviewImage({
  page,
  number,
}: {
  readonly page: PdfPreviewPage;
  readonly number: number;
}) {
  const element = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const url = typeof page.image === 'string' ? page.image : URL.createObjectURL(page.image.blob);
    if (element.current) element.current.src = url;
    return () => {
      if (typeof page.image !== 'string') URL.revokeObjectURL(url);
    };
  }, [page.image]);
  return <img ref={element} alt={`Trang ${String(number)} của PDF`} />;
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
  const [downloadStarted, setDownloadStarted] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const page = pages[index];
  const openLink = useRef<HTMLAnchorElement>(null);
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
    if (openLink.current) openLink.current.href = url;
    if (downloadLink.current)
      downloadLink.current.href = fileUrl
        ? `${fileUrl}${fileUrl.includes('?') ? '&' : '?'}download=true`
        : url;
    return () => {
      if (!fileUrl) URL.revokeObjectURL(url);
    };
  }, [pdf, fileUrl]);

  const save = async () => {
    if (!onSave || busy) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError('');
    try {
      await onSave(name.trim(), controller.signal);
      if (!controller.signal.aborted) setWasSaved(true);
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof Error ? failure.message : 'Chưa lưu được tài liệu. Hãy thử lại.',
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
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
        }}
      />
      <div className="pdf-workspace__page" aria-label={`Trang PDF ${String(index + 1)}`}>
        {page && <PreviewImage page={page} number={index + 1} />}
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
        Bản xem trước dùng đúng ảnh và thứ tự trang của PDF. Chọn Mở PDF để xem tệp bằng trình đọc
        của thiết bị.
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
          onClick={(event) => {
            setError('');
            try {
              if (download) {
                event.preventDefault();
                download(pdf, filename);
              }
              setDownloadStarted(true);
            } catch {
              event.preventDefault();
              setError('Chưa tải được PDF. Hãy chọn Mở PDF hoặc Chia sẻ.');
            }
          }}
        >
          Tải PDF
        </a>
        <a ref={openLink} className="pdf-action" target="_blank" rel="noopener noreferrer">
          Mở PDF
        </a>
        {canShare && (
          <button type="button" onClick={share}>
            Chia sẻ / Lưu vào Tệp
          </button>
        )}
      </div>
      {wasSaved && <p role="status">Tài liệu đã được lưu trong tài khoản.</p>}
      {downloadStarted && (
        <p role="status">
          Đã yêu cầu trình duyệt tải PDF. Nếu chưa thấy tệp, chọn Mở PDF hoặc Chia sẻ để lưu bằng
          trình đọc của thiết bị.
        </p>
      )}
      {onSave && !fileUrl && (
        <p className="pdf-workspace__hint">
          Nếu trình duyệt trong ứng dụng không tải được tệp cục bộ, hãy lưu vào tài khoản rồi bấm
          Tải PDF để tải trực tiếp từ máy chủ.
        </p>
      )}
      {error && (
        <p className="editor__error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
