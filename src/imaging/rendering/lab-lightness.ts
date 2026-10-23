// D65 Lab conversion uses lookup tables to avoid per-channel powers in large pixel loops.
const RESOLUTION = 8192;
const linear = new Float32Array(256);
const encoded = new Uint8Array(RESOLUTION + 1);
const cie = new Float32Array(RESOLUTION + 1);
for (let value = 0; value <= RESOLUTION; value++) {
  const ratio = value / RESOLUTION;
  encoded[value] = Math.round(
    255 * (ratio <= 0.0031308 ? 12.92 * ratio : 1.055 * ratio ** (1 / 2.4) - 0.055),
  );
  cie[value] = ratio > 216 / 24389 ? Math.cbrt(ratio) : ((24389 / 27) * ratio + 16) / 116;
}
for (let value = 0; value < 256; value++) {
  const ratio = value / 255;
  linear[value] = ratio <= 0.04045 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
}
const f = (value: number) =>
  cie[Math.max(0, Math.min(RESOLUTION, Math.round(value * RESOLUTION)))] ?? 0;
const inverse = (value: number) =>
  value > 6 / 29 ? value ** 3 : 3 * (6 / 29) ** 2 * (value - 4 / 29);
const rgb = (value: number) =>
  encoded[Math.max(0, Math.min(RESOLUTION, Math.round(value * RESOLUTION)))] ?? 0;

export function labLightness(red: number, green: number, blue: number): number {
  return (
    (116 *
      f(
        0.2126729 * (linear[red] ?? 0) +
          0.7151522 * (linear[green] ?? 0) +
          0.072175 * (linear[blue] ?? 0),
      ) -
      16) *
    2.55
  );
}

/** Changes L* while retaining a* and b*. */
export function adjustLabLightness(
  pixels: Uint8ClampedArray,
  offset: number,
  adjustment: number,
): void {
  if (Math.abs(adjustment) < 0.3) return;
  const red = pixels[offset] ?? 0,
    green = pixels[offset + 1] ?? 0,
    blue = pixels[offset + 2] ?? 0;
  const r = linear[red] ?? 0,
    g = linear[green] ?? 0,
    b = linear[blue] ?? 0;
  const fx = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
  const fy = f(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
  const fz = f((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
  const delta = adjustment / (2.55 * 116);
  const x = 0.95047 * inverse(fx + delta),
    y = inverse(fy + delta),
    z = 1.08883 * inverse(fz + delta);
  // Roll off positive corrections before any channel clips; do not brighten clipped source areas.
  const cr = rgb(3.2404542 * x - 1.5371385 * y - 0.4985314 * z),
    cg = rgb(-0.969266 * x + 1.8760108 * y + 0.041556 * z),
    cb = rgb(0.0556434 * x - 0.2040259 * y + 1.0572252 * z);
  const maximum = Math.max(red, green, blue);
  const gain =
    adjustment > 0
      ? Math.min(1, Math.max(0, 248 - maximum) / Math.max(1, Math.max(cr, cg, cb) - maximum))
      : 1;
  pixels[offset] = red + (cr - red) * gain;
  pixels[offset + 1] = green + (cg - green) * gain;
  pixels[offset + 2] = blue + (cb - blue) * gain;
}
