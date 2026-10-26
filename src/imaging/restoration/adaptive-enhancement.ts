import type { RgbaBackendInput } from '../engines/scanic-backend-contract';
import type { ShadowField } from './shadow-field';

export interface EnhancementPlan {
  readonly columns: number;
  readonly rows: number;
  readonly background: Float64Array;
  readonly ratios: Float64Array;
  readonly coverage: Float64Array;
  readonly inkSupport: Float64Array;
  readonly needsModel: boolean;
  readonly baseGain: number;
  readonly periodic: boolean;
  readonly field?: ShadowField;
}

const quantile = (values: number[], q: number) => {
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.floor(values.length * q))] ?? 0;
};

function validate(sample: ShadowField, illumination = false): void {
  if (
    !Number.isInteger(sample.width) ||
    !Number.isInteger(sample.height) ||
    sample.width < 1 ||
    sample.height < 1 ||
    sample.width > 384 ||
    sample.height > 384 ||
    sample.data.length !== sample.width * sample.height * 3 ||
    sample.data.some((v) => !Number.isFinite(v) || v < 0 || v > 1.5 || (illumination && v === 0))
  )
    throw new RangeError('invalid-enhancement-field');
}

/** Paper evidence controls learned illumination; printed colors are not a white reference. */
export function analyzeEnhancement(
  sample: ShadowField,
  field?: ShadowField,
  periodicRatio = 0,
): EnhancementPlan {
  validate(sample);
  if (field) {
    validate(field, true);
    if (field.width !== sample.width || field.height !== sample.height)
      throw new RangeError('invalid-enhancement-field');
  }
  const { width, height, data } = sample,
    plane = width * height;
  const columns = Math.min(16, width),
    rows = Math.min(16, height),
    count = columns * rows;
  const hist = new Uint32Array(count * 64),
    totals = new Uint32Array(count);
  const luma = new Float64Array(plane),
    levels = new Float64Array(count);
  const cell = (x: number, y: number) =>
    Math.floor((y * rows) / height) * columns + Math.floor((x * columns) / width);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = y * width + x,
        tile = cell(x, y);
      const value =
        (54 * (data[plane * 2 + at] ?? 0) + 183 * (data[plane + at] ?? 0) + 19 * (data[at] ?? 0)) /
        256;
      luma[at] = value;
      const bin = Math.max(0, Math.min(63, Math.floor(value * 64)));
      hist[tile * 64 + bin] = (hist[tile * 64 + bin] ?? 0) + 1;
      totals[tile] = (totals[tile] ?? 0) + 1;
    }
  for (let i = 0; i < count; i++) {
    let seen = 0;
    for (let b = 0; b < 64; b++) {
      seen += hist[i * 64 + b] ?? 0;
      if (seen >= Math.max(1, Math.ceil((totals[i] ?? 0) * 0.85))) {
        levels[i] = (b + 0.5) / 64;
        break;
      }
    }
  }
  const backgrounds = new Float64Array(count * 3),
    model = new Float64Array(count * 3);
  const amounts = new Uint32Array(count),
    strokes = new Uint32Array(count),
    ink = new Float64Array(count);
  const light = (x: number, y: number) =>
    luma[Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))] ?? 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = y * width + x,
        i = cell(x, y),
        v = luma[at] ?? 0,
        bg = levels[i] ?? 1;
      if (Math.abs(v - bg) < 0.025) {
        amounts[i] = (amounts[i] ?? 0) + 1;
        for (let c = 0; c < 3; c++) {
          backgrounds[i * 3 + c] = (backgrounds[i * 3 + c] ?? 0) + (data[c * plane + at] ?? 0);
          model[i * 3 + c] = (model[i * 3 + c] ?? 0) + (field?.data[c * plane + at] ?? 1);
        }
      }
      if (
        v < bg * 0.78 &&
        ((light(x - 2, y) > v + 0.03 && light(x + 2, y) > v + 0.03) ||
          (light(x, y - 2) > v + 0.03 && light(x, y + 2) > v + 0.03))
      ) {
        ink[i] = (ink[i] ?? 0) + v / Math.max(bg, 0.05);
        strokes[i] = (strokes[i] ?? 0) + 1;
      }
    }
  const candidates = new Uint8Array(count),
    trusted = new Uint8Array(count),
    blocked = new Uint8Array(count);
  const inkSupport = new Float64Array(count);
  let colored = 0,
    anchors = 0;
  const bright = quantile([...levels], 0.9),
    low = quantile([...levels], 0.1);
  const references: number[] = [];
  for (let i = 0; i < count; i++) {
    const n = amounts[i] ?? 0;
    for (let c = 0; c < 3; c++) {
      backgrounds[i * 3 + c] = n ? (backgrounds[i * 3 + c] ?? 0) / n : (levels[i] ?? 1);
      model[i * 3 + c] = n ? (model[i * 3 + c] ?? 0) / n : 1;
    }
    const b = backgrounds[i * 3] ?? 0,
      g = backgrounds[i * 3 + 1] ?? 0,
      r = backgrounds[i * 3 + 2] ?? 0;
    const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(0.001, r, g, b);
    if (chroma > 0.18) colored++;
    const strokeCount = strokes[i] ?? 0,
      fraction = strokeCount / Math.max(1, totals[i] ?? 0);
    ink[i] = strokeCount ? (ink[i] ?? 0) / strokeCount : 1;
    inkSupport[i] = Math.max(0, Math.min(1, (0.22 - fraction) / 0.08));
    if (n >= 3 && chroma < 0.18 && (levels[i] ?? 0) > 0.15 && strokeCount >= 2 && fraction < 0.22) {
      candidates[i] = 1;
      anchors++;
      if ((levels[i] ?? 0) >= bright - 0.08) references.push(ink[i] ?? 1);
    }
  }
  const reference = references.length ? quantile(references, 0.5) : 0.25;
  for (let i = 0; i < count; i++) {
    const mismatch =
      (ink[i] ?? 1) > reference * 1.8 + 0.025 || (ink[i] ?? 1) < reference * 0.6 - 0.025;
    if ((levels[i] ?? 0) < bright * 0.85 && (strokes[i] ?? 0) >= 2 && mismatch) blocked[i] = 1;
    if (candidates[i] === 1 && blocked[i] === 0) trusted[i] = 1;
  }
  const colorful = colored > count * 0.2;
  const needsModel =
    anchors >= Math.max(4, count * 0.025) && bright - low > (colorful ? 0.24 : 0.12);
  const coverage = new Float64Array(count),
    ratios = new Float64Array(count * 3).fill(1);
  if (needsModel && field) {
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < columns; x++) {
        const i = y * columns + x;
        if (trusted[i] === 1) {
          coverage[i] = 1;
          continue;
        }
        if (blocked[i] === 1) continue;
        const total = [0, 0, 0];
        let weight = 0;
        for (let dy = -3; dy <= 3; dy++)
          for (let dx = -3; dx <= 3; dx++) {
            const xx = x + dx,
              yy = y + dy;
            if (xx < 0 || xx >= columns || yy < 0 || yy >= rows || trusted[yy * columns + xx] !== 1)
              continue;
            const w = 1 / (dx * dx + dy * dy);
            weight += w;
            for (let c = 0; c < 3; c++)
              total[c] = (total[c] ?? 0) + (model[(yy * columns + xx) * 3 + c] ?? 1) * w;
          }
        if (weight > 0) {
          coverage[i] = 1;
          for (let c = 0; c < 3; c++)
            ratios[i * 3 + c] = Math.max(
              0.35,
              Math.min(3, (total[c] ?? 0) / weight / Math.max(0.05, model[i * 3 + c] ?? 1)),
            );
        }
      }
  }
  return {
    columns,
    rows,
    background: levels,
    ratios,
    coverage,
    inkSupport,
    needsModel,
    baseGain:
      !field && !colorful && anchors >= 8
        ? Math.max(1, Math.min(1.25, 0.94 / Math.max(0.1, bright)))
        : 1,
    periodic: periodicRatio > 0.35,
    ...(field && needsModel ? { field } : {}),
  };
}

/** Single owned-pixel pass, original-neighbor ring and bounded row interpolation buffers. */
export function applyEnhancement(input: RgbaBackendInput, plan: EnhancementPlan): void {
  const { width, height } = input.dimensions,
    pixels = input.pixels;
  if (pixels.length !== width * height * 4 || width < 1 || height < 1)
    throw new RangeError('invalid-input');
  const radius = Math.max(2, Math.min(8, Math.round(Math.max(width, height) / 400)));
  const ring = new Uint8Array((2 * radius + 1) * width);
  const remember = (y: number) => {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      ring[(y % (2 * radius + 1)) * width + x] =
        (54 * (pixels[at] ?? 0) + 183 * (pixels[at + 1] ?? 0) + 19 * (pixels[at + 2] ?? 0)) >> 8;
    }
  };
  const gray = (x: number, y: number) =>
    ring[
      (Math.max(0, Math.min(height - 1, y)) % (2 * radius + 1)) * width +
        Math.max(0, Math.min(width - 1, x))
    ] ?? 0;
  for (let y = 0; y <= Math.min(radius, height - 1); y++) remember(y);
  const field = plan.field,
    fieldPlane = (field?.width ?? 1) * (field?.height ?? 1);
  const fieldRow = new Float64Array((field?.width ?? 1) * 3);
  const rows = new Float64Array(plan.columns * 6);
  for (let y = 0; y < height; y++) {
    if (y > 0 && y + radius < height) remember(y + radius);
    const yy = Math.max(0, Math.min(plan.rows - 1, ((y + 0.5) * plan.rows) / height - 0.5));
    const top = Math.floor(yy),
      bottom = Math.min(top + 1, plan.rows - 1),
      fy = yy - top;
    for (let x = 0; x < plan.columns; x++) {
      const a = top * plan.columns + x,
        b = bottom * plan.columns + x;
      rows[x * 6] = (plan.background[a] ?? 1) * (1 - fy) + (plan.background[b] ?? 1) * fy;
      rows[x * 6 + 1] = (plan.coverage[a] ?? 0) * (1 - fy) + (plan.coverage[b] ?? 0) * fy;
      rows[x * 6 + 2] = (plan.inkSupport[a] ?? 0) * (1 - fy) + (plan.inkSupport[b] ?? 0) * fy;
      for (let c = 0; c < 3; c++)
        rows[x * 6 + 3 + c] =
          (plan.ratios[a * 3 + c] ?? 1) * (1 - fy) + (plan.ratios[b * 3 + c] ?? 1) * fy;
    }
    if (field) {
      const yField = Math.max(
        0,
        Math.min(field.height - 1, ((y + 0.5) * field.height) / height - 0.5),
      );
      const a = Math.floor(yField),
        b = Math.min(a + 1, field.height - 1),
        t = yField - a;
      for (let c = 0; c < 3; c++)
        for (let x = 0; x < field.width; x++)
          fieldRow[c * field.width + x] =
            (field.data[c * fieldPlane + a * field.width + x] ?? 1) * (1 - t) +
            (field.data[c * fieldPlane + b * field.width + x] ?? 1) * t;
    }
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      if (pixels[at + 3] !== 255) continue;
      const value = gray(x, y);
      const pulse =
        (gray(x - radius, y) > value + 8 && gray(x + radius, y) > value + 8) ||
        (gray(x, y - radius) > value + 8 && gray(x, y + radius) > value + 8);
      // A protected flat background needs neither interpolation nor channel writes.
      if (!field && plan.baseGain === 1 && !pulse) continue;
      const xx = Math.max(0, Math.min(plan.columns - 1, ((x + 0.5) * plan.columns) / width - 0.5));
      const left = Math.floor(xx),
        right = Math.min(left + 1, plan.columns - 1),
        fx = xx - left;
      const interpolate = (c: number) =>
        (rows[left * 6 + c] ?? 0) * (1 - fx) + (rows[right * 6 + c] ?? 0) * fx;
      const paper = interpolate(0) * 255;
      const ink =
        value < paper * (plan.periodic ? 0.62 : 0.82) && pulse
          ? 1 -
            (1 - Math.max(0.72, Math.pow(Math.max(0.01, value / Math.max(1, paper)), 0.25))) *
              interpolate(2)
          : 1;
      let fieldLeft = 0,
        fieldRight = 0,
        fieldFraction = 0;
      if (field) {
        const xf = Math.max(0, Math.min(field.width - 1, ((x + 0.5) * field.width) / width - 0.5));
        fieldLeft = Math.floor(xf);
        fieldRight = Math.min(fieldLeft + 1, field.width - 1);
        fieldFraction = xf - fieldLeft;
      }
      for (let c = 0; c < 3; c++) {
        let gain = plan.baseGain;
        if (field) {
          const light =
            ((fieldRow[c * field.width + fieldLeft] ?? 1) * (1 - fieldFraction) +
              (fieldRow[c * field.width + fieldRight] ?? 1) * fieldFraction) *
            interpolate(3 + c);
          gain = 1 + (Math.max(1, Math.min(4, 0.96 / Math.max(0.05, light))) - 1) * interpolate(1);
        }
        pixels[at + 2 - c] = Math.min(255, Math.round((pixels[at + 2 - c] ?? 0) * gain * ink));
      }
    }
  }
}
