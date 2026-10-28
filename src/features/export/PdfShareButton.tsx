import { useEffect, useRef, useState } from 'react';

export function PdfShareButton({
  pdf,
  loadPdf,
  filename,
  title,
}: {
  readonly pdf?: Blob;
  readonly loadPdf?: (signal: AbortSignal) => Promise<Blob>;
  readonly filename: string;
  readonly title: string;
}) {
  const [prepared, setPrepared] = useState<Blob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), []);
  const content = pdf ?? prepared;
  const file = content ? new File([content], filename, { type: 'application/pdf' }) : null;
  let available = typeof navigator.share === 'function' && typeof navigator.canShare === 'function';
  try {
    if (file && available) available = navigator.canShare({ files: [file] });
  } catch {
    available = false;
  }
  if (!available || (!file && !loadPdf)) return null;

  const prepare = async () => {
    if (!loadPdf || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError('');
    try {
      const result = await loadPdf(controller.signal);
      if (!result.size || result.type !== 'application/pdf')
        throw new Error('Tệp PDF không hợp lệ.');
      if (!controller.signal.aborted) setPrepared(result);
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof Error ? failure.message : 'Không chuẩn bị được PDF để chia sẻ.',
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (operation.current === controller) operation.current = null;
    }
  };
  const share = () => {
    if (!file) {
      void prepare();
      return;
    }
    setError('');
    // Keep the native share call in a fresh user gesture, after the file is ready.
    void navigator.share({ files: [file], title }).catch((failure: unknown) => {
      if (!(failure instanceof Error && failure.name === 'AbortError'))
        setError('Chưa chia sẻ được PDF. Bạn vẫn có thể dùng Tải PDF.');
    });
  };
  return (
    <div>
      <button type="button" disabled={busy} onClick={share}>
        {busy ? 'Đang chuẩn bị chia sẻ…' : file ? 'Chia sẻ / Lưu vào Tệp' : 'Chuẩn bị chia sẻ PDF'}
      </button>
      {prepared && <p role="status">PDF đã sẵn sàng để chia sẻ.</p>}
      {error && (
        <p role="alert" className="editor__error">
          {error}
        </p>
      )}
    </div>
  );
}
