import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { PdfPreview } from '../../src/features/export/PdfPreview';
import '../../src/styles/tokens.css';
import '../../src/styles/global.css';

const root = document.querySelector<HTMLDivElement>('#layout-root');
const status = document.querySelector<HTMLParagraphElement>('#layout-status');
if (!root || !status) throw new Error('Missing layout-test root');

async function run() {
  const image = `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="210" height="297"><rect width="210" height="297" fill="white"/></svg>',
  )}`;
  flushSync(() => {
    createRoot(root!).render(
      <div className="app-shell">
        <header className="top-bar">clonecamscanner</header>
        <PdfPreview
          pages={[
            { id: 'one', image },
            { id: 'two', image },
          ]}
          name="Layout test"
          fileUrl="#download"
          saved
          onLibrary={() => undefined}
          onBack={() => undefined}
        />
      </div>,
    );
  });
  // Reproduce returning to controls after scrolling through a document.
  window.scrollTo(0, 500);
  for (const label of ['← Kho tài liệu', 'Chỉnh sửa tài liệu', 'Tải PDF']) {
    const control = Array.from(root!.querySelectorAll<HTMLElement>('button, a')).find(
      (element) => element.textContent?.trim() === label,
    );
    if (!control) throw new Error(`Missing control: ${label}`);
    control.scrollIntoView({ block: 'center' });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const bounds = control.getBoundingClientRect();
    const hit = document.elementFromPoint(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    if (!hit || !control.contains(hit)) throw new Error(`Control is covered: ${label}`);
  }
  window.scrollTo(0, 0);
  status!.textContent = 'PASS: Kho tài liệu, chỉnh sửa và tải PDF không bị che sau khi cuộn.';
}

void run().catch((error: unknown) => {
  status!.textContent = `FAIL: ${error instanceof Error ? error.message : String(error)}`;
});
