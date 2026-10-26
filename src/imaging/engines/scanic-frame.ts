import { ScanicDetectorRuntime } from './scanic-detector-runtime';
import { applyFinalAppearance } from '../restoration/enhanced-appearance';
import { warpPerspectiveRgba } from '../rendering/perspective-warp';
import { rotateOwnedRgba } from '../rendering/rgba-rotation';
import { warpRasterAsset } from '../rendering/raster-asset-warp';
import type { ScanicWorkerRequest, ScanicWorkerResponse } from './scanic-worker-backend';

// A separate same-origin realm gives the no-Worker fallback its own vendor ONNX cache.
const detector = new ScanicDetectorRuntime();
const connect = (event: MessageEvent) => {
  if (
    event.source !== window.parent ||
    event.origin !== window.parent.location.origin ||
    event.data !== 'scanic-connect' ||
    event.ports.length !== 1
  )
    return;
  window.removeEventListener('message', connect);
  const port = event.ports[0];
  if (port === undefined) return;
  port.onmessage = (message: MessageEvent<ScanicWorkerRequest>) => {
    const request = message.data;
    void (async () => {
      let output: unknown;
      if (request.operation === 'initialize') {
        await detector.initialize();
        output = null;
      } else if (request.operation === 'detect') {
        const result = await detector.scan(
          new ImageData(
            request.input.pixels,
            request.input.dimensions.width,
            request.input.dimensions.height,
          ),
        );
        output = {
          success: result.success,
          confidence: result.confidence,
          corners: result.corners,
          detector: 'ml',
        };
      } else {
        const warped =
          request.operation === 'warp-asset'
            ? await warpRasterAsset(request.asset, request.corners, request.maximumOutputLongSide)
            : warpPerspectiveRgba(request.input, request.corners, request.maximumOutputLongSide);
        output = rotateOwnedRgba(
          await applyFinalAppearance(warped, request.filter, request.analysis),
          request.rotation,
        );
      }
      const response: ScanicWorkerResponse = { id: request.id, kind: 'success', output };
      const transfer =
        typeof output === 'object' &&
        output !== null &&
        'pixels' in output &&
        output.pixels instanceof Uint8ClampedArray
          ? [output.pixels.buffer]
          : [];
      port.postMessage(response, transfer);
    })().catch(() => {
      port.postMessage({ id: request.id, kind: 'failure', code: 'failed' });
    });
  };
  port.start();
  port.postMessage({ kind: 'connected' });
};
window.addEventListener('message', connect);
