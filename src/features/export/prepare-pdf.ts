import type { ImageAsset } from '../../domain/document';
import { createImagePdf } from './image-pdf';

/** Bound even a stalled exporter; the SDK also observes cancellation between page operations. */
export async function preparePdf(
  pages: readonly ImageAsset[],
  controller: AbortController,
  exporter: typeof createImagePdf = createImagePdf,
  timeoutMs = 60_000,
): Promise<Blob> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(new DOMException('Đã huỷ tạo PDF.', 'AbortError'));
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      reject(new Error('Tạo PDF mất quá nhiều thời gian. Hãy thử lại với ít trang hơn.'));
      controller.abort();
    }, timeoutMs);
  });
  try {
    if (controller.signal.aborted) throw new DOMException('Đã huỷ tạo PDF.', 'AbortError');
    const blob = await Promise.race([exporter(pages, controller.signal), stopped]);
    if (blob.size === 0 || blob.type !== 'application/pdf')
      throw new Error('Tệp PDF không hợp lệ.');
    return blob;
  } finally {
    clearTimeout(timer);
    if (onAbort) controller.signal.removeEventListener('abort', onAbort);
  }
}
