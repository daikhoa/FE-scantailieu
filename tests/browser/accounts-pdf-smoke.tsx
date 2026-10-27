import { createRoot } from 'react-dom/client';
import { PdfPreview } from '../../src/features/export/PdfPreview';
import { createImagePdf } from '../../src/features/export/image-pdf';
import type { ImageAsset } from '../../src/domain/document';
import type { DocumentSummary, StoredDocument } from '../../src/features/library/document-api';
import '../../src/styles/tokens.css';
import '../../src/styles/global.css';

const status = document.querySelector<HTMLParagraphElement>('#smoke-status');
const preview = document.querySelector<HTMLDivElement>('#smoke-preview');
if (!status || !preview) throw new Error('Missing smoke-test root');
const previewRoot = createRoot(preview);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function jpegPage(label: string): Promise<ImageAsset> {
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 800;
  const context = canvas.getContext('2d');
  assert(context, 'Canvas unavailable');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, 600, 800);
  context.fillStyle = '#153b2e';
  context.font = 'bold 32px sans-serif';
  context.fillText(label, 48, 80);
  context.font = '20px sans-serif';
  context.fillText('Tài liệu giả lập để kiểm thử PDF', 48, 130);
  for (let index = 0; index < 12; index++)
    context.fillRect(48, 200 + index * 32, 460 - index * 8, 2);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) => (value ? resolve(value) : reject(new Error('JPEG encoding failed'))),
      'image/jpeg',
      0.9,
    ),
  );
  canvas.width = 1;
  canvas.height = 1;
  return { blob, dimensions: { width: 600, height: 800 } };
}

async function run() {
  status!.textContent = 'Đang đăng ký tài khoản QA trên backend…';
  assert(
    ['localhost', '127.0.0.1'].includes(location.hostname),
    'This disposable-data test is localhost-only',
  );
  const images = [await jpegPage('Trang 1'), await jpegPage('Trang 2')];
  status!.textContent = 'Đang tạo PDF JPEG bằng SDK trong trình duyệt…';
  const signal = new AbortController().signal;
  const pdf = await createImagePdf(images, signal);
  assert(pdf.type === 'application/pdf' && pdf.size > 1000, 'Browser SDK did not create a PDF');
  previewRoot.render(
    <PdfPreview
      pages={images.map((image, index) => ({ id: String(index), image }))}
      pdf={pdf}
      name="PDF kiểm thử trình duyệt"
      onBack={() => history.back()}
    />,
  );

  const suffix = crypto.randomUUID();
  const credentials = { email: `qa-${suffix}@example.com`, password: crypto.randomUUID() };
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Requested-With': 'docscan',
  };
  const registration = await fetch('/api/v1/auth/register', {
    method: 'POST',
    headers,
    body: JSON.stringify(credentials),
  });
  assert(registration.status === 201, `Registration: ${String(registration.status)}`);
  const login = await fetch('/api/v1/auth/token', {
    method: 'POST',
    headers,
    body: JSON.stringify(credentials),
  });
  assert(login.ok, `Token: ${String(login.status)}`);
  const token = (await login.json()) as { access_token: string };
  const authorization = {
    Authorization: `Bearer ${token.access_token}`,
    'X-Requested-With': 'docscan',
  };

  const form = (pdfBlob: Blob, revision: number | null, sources = images) => {
    const body = new FormData();
    body.set(
      'manifest',
      JSON.stringify({
        schemaVersion: 1,
        name: 'PDF kiểm thử trình duyệt',
        revision,
        pages: sources.map((image, index) => ({
          id: `page-${String(index + 1)}`,
          original: { ...image.dimensions, mime: image.blob.type },
          rendered: { ...image.dimensions, mime: image.blob.type },
          recipe: {
            version: 1,
            crop: { kind: 'full-frame' },
            rotation: 0,
            dewarp: { mode: 'perspective-only' },
            filter: { mode: 'original', presetVersion: 'original-v1', parameters: {} },
          },
          engineVersion: 'browser-smoke',
          recipeKey: `page-${String(index)}`,
          outcome: { kind: 'not-requested' },
        })),
      }),
    );
    sources.forEach((image, index) => {
      body.set(`original_${String(index)}`, image.blob, 'page.jpg');
      body.set(`rendered_${String(index)}`, image.blob, 'page.jpg');
    });
    body.set('pdf', pdfBlob, 'document.pdf');
    return body;
  };
  const created = await fetch('/api/v1/documents', {
    method: 'POST',
    headers: authorization,
    body: form(pdf, null),
  });
  if (created.status !== 201)
    throw new Error(`Create document: ${String(created.status)}: ${await created.text()}`);
  const document = (await created.json()) as DocumentSummary;
  assert(document.pageCount === 2, 'Wrong saved page count');
  const firstDetail = await fetch(`/api/v1/documents/${document.id}`, { headers: authorization });
  const detail = (await firstDetail.json()) as StoredDocument;
  assert(
    detail.pages.length === 2 && detail.pages[0]?.recipe.crop.kind === 'full-frame',
    'Editable sources/recipe not restored',
  );
  const firstPage = detail.pages[0];
  assert(firstPage, 'Missing saved page');
  const restoredOriginal = await fetch(firstPage.originalUrl, { headers: authorization });
  assert(
    restoredOriginal.ok && (await restoredOriginal.blob()).size === images[0]!.blob.size,
    'Original source changed',
  );
  const onePagePdf = await createImagePdf(images.slice(1), signal);
  const updated = await fetch(`/api/v1/documents/${document.id}`, {
    method: 'PUT',
    headers: authorization,
    body: form(onePagePdf, 1, images.slice(1)),
  });
  assert(updated.ok, `Update document: ${String(updated.status)}`);
  const saved = (await updated.json()) as DocumentSummary;
  assert(
    saved.id === document.id && saved.revision === 2 && saved.pageCount === 1,
    'Update created a duplicate or lost the revision',
  );
  const conflict = await fetch(`/api/v1/documents/${document.id}`, {
    method: 'PUT',
    headers: authorization,
    body: form(onePagePdf, 1, images.slice(1)),
  });
  assert(conflict.status === 409, 'Stale save was not rejected');
  const download = await fetch(`/api/v1/documents/${document.id}/pdf?revision=2&download=true`, {
    headers: authorization,
  });
  assert(
    download.ok && download.headers.get('content-disposition')?.includes('attachment'),
    'Server download headers incorrect',
  );
  assert(
    (await download.blob()).size === onePagePdf.size,
    'Downloaded PDF differs from the saved PDF',
  );
  const logout = await fetch('/api/v1/auth/session', { method: 'DELETE', headers: authorization });
  assert(logout.status === 204, 'Token revocation failed');
  const denied = await fetch(`/api/v1/documents/${document.id}`, { headers: authorization });
  assert(denied.status === 401, 'Revoked token still accesses documents');
  // The preview below exercises the real mobile-friendly view; its PDF is already ready to download.
  previewRoot.render(
    <PdfPreview
      pages={[{ id: 'page-2', image: images[1]! }]}
      pdf={onePagePdf}
      name="PDF kiểm thử trình duyệt"
      onBack={() => history.back()}
    />,
  );
  status!.textContent =
    'PASS: đăng ký, bearer, JPEG → PDF trong trình duyệt, lưu/mở ảnh và recipe, sửa cùng ID, xung đột, tải PDF và thu hồi phiên.';
  status!.dataset.result = 'pass';
}

void run().catch((error: unknown) => {
  status.textContent = `FAIL: ${error instanceof Error ? error.message : 'Unknown failure'}`;
  status.dataset.result = 'fail';
});
