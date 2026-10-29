import { createRoot } from 'react-dom/client';
import { ManualCropEditor } from '../../src/features/editor/ManualCropEditor';
import { PageOrderEditor } from '../../src/features/scanner/PageOrderEditor';
import '../../src/styles/tokens.css';
import '../../src/styles/global.css';
import '../../src/features/scanner/scan-workspace.css';

// A small sheet in a wide camera image, matching the reported failure without personal photos.
const canvas = document.createElement('canvas');
canvas.width = 1600;
canvas.height = 1200;
const context = canvas.getContext('2d')!;
context.fillStyle = '#44654b';
context.fillRect(0, 0, 1600, 1200);
context.fillStyle = '#fff';
context.fillRect(650, 420, 300, 400);
context.fillStyle = '#222';
context.font = '24px sans-serif';
context.fillText('TÀI LIỆU NHỎ', 680, 480);
for (let y = 520; y < 780; y += 35) context.fillRect(680, y, 240, 3);
const blob = await new Promise<Blob>((resolve) =>
  canvas.toBlob((result) => resolve(result!), 'image/jpeg'),
);
const original = { blob, dimensions: { width: 1600, height: 1200 } };
const root = createRoot(document.querySelector('#root')!);
root.render(
  <div className="app-shell">
    <main className="app-main batch-review batch-review--cropping">
      {new URLSearchParams(location.search).has('order') ? (
        <PageOrderEditor
          pages={Array.from({ length: 7 }, (_, index) => ({
            id: String(index + 1),
            kind: 'loading-saved' as const,
            previewUrl: URL.createObjectURL(blob),
          }))}
          selectedPageId="1"
          onCancel={() => {}}
          onApply={(ids) => {
            document.title = `Thứ tự: ${ids.join(',')}`;
          }}
        />
      ) : (
        <ManualCropEditor
          original={original}
          initialCrop={{
            kind: 'document',
            corners: [
              { x: 650, y: 420 },
              { x: 950, y: 420 },
              { x: 950, y: 820 },
              { x: 650, y: 820 },
            ],
          }}
          busy={false}
          onCancel={() => {}}
          onApply={() => {}}
        />
      )}
    </main>
    <button
      id="check-crop"
      style={{ position: 'fixed', left: 800, top: 20 }}
      onClick={() => {
        const image = document.querySelector('.manual-crop__stage img')!.getBoundingClientRect();
        const overlay = document.querySelector('.manual-crop__overlay')!.getBoundingClientRect();
        const handles = [...document.querySelectorAll('[role="slider"]')].map((el) =>
          el.getBoundingClientRect(),
        );
        const aligned =
          Math.abs(image.width - overlay.width) < 1 && Math.abs(image.height - overlay.height) < 1;
        const viewport = document.querySelector('.manual-crop__viewport')?.getBoundingClientRect();
        document.querySelector('#crop-result')!.textContent =
          aligned &&
          (!viewport || viewport.height > 150) &&
          handles.length === 4 &&
          handles.every((r) => r.width >= 43)
            ? `PASS: khung ${Math.round(overlay.width)} × ${Math.round(overlay.height)}, 4 góc dễ chạm.`
            : `FAIL: ảnh ${Math.round(image.width)} × ${Math.round(image.height)}, khung ${Math.round(overlay.width)} × ${Math.round(overlay.height)}.`;
      }}
    >
      Kiểm tra khung cắt
    </button>
    <p id="crop-result" role="status" style={{ position: 'fixed', left: 800, top: 70 }}>
      Chưa kiểm tra
    </p>
  </div>,
);
