import type { DocumentQualityProfile } from '../analysis/document-quality';
import type { RgbaBackendInput } from '../engines/scanic-backend-contract';

/** A shared RGB curve removes mild haze without whitening colored regions independently. */
export function enhanceColorContrast(
  input: RgbaBackendInput,
  brightness: DocumentQualityProfile['brightness'],
): void {
  const { darkPercentile, brightPercentile } = brightness;
  // A nearly flat surface has no reliable black/white reference to stretch.
  if (brightPercentile - darkPercentile < 32) return;
  const black = Math.max(0, Math.min(40, darkPercentile - 8));
  const white = Math.max(215, Math.min(255, brightPercentile + 8));
  const blackTarget = black * 0.35;
  const whiteTarget = white + (255 - white) * 0.65;
  const curve = new Uint8Array(256);
  for (let value = 1; value < 255; value += 1) {
    let mapped: number;
    if (value < black) mapped = (value * blackTarget) / black;
    else if (value <= white)
      mapped = blackTarget + ((value - black) * (whiteTarget - blackTarget)) / (white - black);
    else mapped = whiteTarget + ((value - white) * (255 - whiteTarget)) / (255 - white);
    // Soft toe/shoulder retain existing extremes without introducing clipped pixels.
    curve[value] = Math.max(1, Math.min(254, Math.round(mapped)));
  }
  curve[255] = 255;
  for (let offset = 0; offset < input.pixels.length; offset += 4) {
    if (input.pixels[offset + 3] === 0) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      const index = offset + channel;
      input.pixels[index] = curve[input.pixels[index] ?? 0] ?? 0;
    }
  }
}
