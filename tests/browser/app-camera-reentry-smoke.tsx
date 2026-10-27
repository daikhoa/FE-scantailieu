import { createRoot } from 'react-dom/client';
import { App } from '../../src/app/App';
import {
  createRgbaScannerFrame,
  createScanicEngine,
} from '../../src/imaging/engines/scanic-classical-engine';
import type { ScannerEngine } from '../../src/imaging/contracts/scanner-engine';
import { createCompatibleScanicBackend } from '../../src/imaging/engines/scanic-compatible-backend';
import { ScannerEngineError } from '../../src/imaging/engines/scanner-engine-error';

const output = document.querySelector<HTMLPreElement>('#result')!;
const host = document.querySelector<HTMLDivElement>('#app')!;
const root = createRoot(host);
const active = new Map<ScannerEngine, string>();
const cycles: unknown[] = [];
const forceDom = location.search.includes('fallback');
let stream: MediaStream | null = null;

async function until(check: () => boolean, description: string) {
  const deadline = Date.now() + 30_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(description);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function click(label: string) {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button || button.disabled) throw new Error(`Button unavailable: ${label}`);
  button.click();
}
function trackedEngine(kind: string): ScannerEngine {
  const engine = createScanicEngine(
    forceDom
      ? {
          createBackend: () =>
            createCompatibleScanicBackend({
              createWorker() {
                throw new ScannerEngineError('unavailable');
              },
            }),
        }
      : {},
  );
  return {
    get lifecycle() {
      return engine.lifecycle;
    },
    async initialize(signal) {
      await engine.initialize(signal);
      active.set(engine, kind);
    },
    detect: (frame, signal) => engine.detect(frame, signal),
    render: (request, signal) => engine.render(request, signal),
    renderPixels: (request, signal) => engine.renderPixels!(request, signal),
    async dispose() {
      await engine.dispose();
      active.delete(engine);
    },
  };
}
async function run() {
  const response = await fetch('/tests/fixtures/synthetic/flat-document.png');
  if (!response.ok) throw new Error('Fixture could not load.');
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 960 / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const dimensions = { width: canvas.width, height: canvas.height };
  root.render(
    <App
      editorEngineFactory={() => trackedEngine('processing')}
      cameraEngineFactory={() => trackedEngine('camera')}
      cameraFrameSourceFactory={() => ({
        capture: () => createRgbaScannerFrame(dimensions, pixels),
        dispose: () => undefined,
      })}
      cameraCapture={{ capture: async () => blob }}
      cameraService={{
        lifecycle: { kind: 'idle' },
        start: async () => {
          stream = canvas.captureStream();
          return { stream, stop: () => stream?.getTracks().forEach((track) => track.stop()) };
        },
        stop: () => stream?.getTracks().forEach((track) => track.stop()),
      }}
    />,
  );
  try {
    await until(() => document.querySelector('input[type=file]') !== null, 'Home did not mount.');
    const selection = new DataTransfer();
    selection.items.add(new File([blob], 'first.png', { type: blob.type }));
    selection.items.add(new File([blob], 'second.png', { type: blob.type }));
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
    input.files = selection.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await until(
      () =>
        document.querySelector<HTMLButtonElement>('button[aria-label="Xem PDF 2 trang"]')
          ?.disabled === false,
      'Imported pages did not finish.',
    );
    const gray = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Xám',
    )!;
    gray.click();
    await until(
      () => gray.getAttribute('aria-pressed') === 'true' && active.size === 2,
      'Edit runtime did not initialize.',
    );
    for (let cycle = 0; cycle < 3; cycle++) {
      click('Chụp thêm trang');
      await until(
        () => host.textContent?.includes('Đã định khung tài liệu.') === true,
        'Live detection did not recover after Add.',
      );
      if (active.size !== 1 || [...active.values()][0] !== 'camera')
        throw new Error('Review runtime retained during camera activation.');
      if (host.querySelector('[role=alert]')) throw new Error('Unexpected recognition alert.');
      click('Chụp tài liệu');
      const pages = cycle + 3;
      await until(
        () =>
          document.querySelector<HTMLButtonElement>(
            `button[aria-label="Hoàn tất chụp ${pages} trang"]`,
          )?.disabled === false,
        'New capture did not finish processing.',
      );
      click(`Hoàn tất chụp ${pages} trang`);
      await until(
        () => host.textContent?.includes(`Kiểm tra ${pages} trang`) === true,
        'Review did not reopen.',
      );
      cycles.push({ cycle, pages, recovered: true });
    }
    return {
      realApp: true,
      realInference: true,
      forceDom,
      importedPages: 2,
      filterEdit: true,
      cycles,
    };
  } finally {
    root.unmount();
    await until(() => active.size === 0, 'Runtime remained after App unmount.');
    canvas.width = canvas.height = 1;
  }
}
void run().then(
  (result) => {
    output.textContent = JSON.stringify({ ...result, activeRuntimesAfterUnmount: active.size });
    output.dataset.status = 'complete';
  },
  (error: unknown) => {
    output.textContent = JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error',
      cycles,
      active: [...active.values()],
    });
    output.dataset.status = 'failed';
  },
);
