import type { RgbaBackendInput } from '../engines/scanic-backend-contract';

export interface PaperBackgroundField {
  columns: number;
  rows: number;
  background: Float64Array<ArrayBuffer>;
  connected: Uint8Array<ArrayBuffer>;
}

/** Fine background estimates inherit coarse paper evidence, never dark-value alone. */
export function refinePaperBackground(
  input: RgbaBackendInput,
  coarse: PaperBackgroundField,
  strokeMeans: Float64Array,
): PaperBackgroundField & { hasNarrowShadow: boolean } {
  const { width, height } = input.dimensions;
  const gray = (x: number, y: number) => {
    const at = (y * width + x) * 4;
    return input.pixels[at + 3] === 255
      ? (54 * (input.pixels[at] ?? 0) +
          183 * (input.pixels[at + 1] ?? 0) +
          19 * (input.pixels[at + 2] ?? 0)) >>
          8
      : 0;
  };
  const probeRadius = Math.max(2, Math.min(8, Math.round(Math.max(width, height) / 400)));
  // Spend the same bounded grid budget along the sharper illumination axis.
  const rowSum = new Float64Array(128),
    columnSum = new Float64Array(128),
    rowCount = new Uint32Array(128),
    columnCount = new Uint32Array(128);
  const probeStride = Math.max(1, Math.ceil(Math.max(width, height) / 128));
  const probeRows = Math.ceil(height / probeStride),
    probeColumns = Math.ceil(width / probeStride);
  for (let y = 0; y < height; y += probeStride)
    for (let x = 0; x < width; x += probeStride) {
      const at = (y * width + x) * 4;
      if (input.pixels[at + 3] !== 255) continue;
      const cell =
          Math.floor((y * coarse.rows) / height) * coarse.columns +
          Math.floor((x * coarse.columns) / width),
        ci = cell * 3;
      const paper =
        (54 * (coarse.background[ci] ?? 0) +
          183 * (coarse.background[ci + 1] ?? 0) +
          19 * (coarse.background[ci + 2] ?? 0)) /
        256;
      const value =
        (54 * (input.pixels[at] ?? 0) +
          183 * (input.pixels[at + 1] ?? 0) +
          19 * (input.pixels[at + 2] ?? 0)) /
        256;
      if (paper < 70 || value < paper * 0.55) continue;
      const center = gray(x, y);
      if (
        value < paper * 0.78 &&
        ((gray(Math.max(0, x - probeRadius), y) > center + 8 &&
          gray(Math.min(width - 1, x + probeRadius), y) > center + 8) ||
          (gray(x, Math.max(0, y - probeRadius)) > center + 8 &&
            gray(x, Math.min(height - 1, y + probeRadius)) > center + 8))
      )
        continue;
      const yy = Math.floor(y / probeStride),
        xx = Math.floor(x / probeStride),
        ratio = value / paper;
      rowSum[yy] = (rowSum[yy] ?? 0) + ratio;
      rowCount[yy] = (rowCount[yy] ?? 0) + 1;
      columnSum[xx] = (columnSum[xx] ?? 0) + ratio;
      columnCount[xx] = (columnCount[xx] ?? 0) + 1;
    }
  const curvature = (sum: Float64Array, n: Uint32Array, size: number) => {
    let maximum = 0;
    for (let i = 4; i < size - 4; i++) {
      if ((n[i - 1] ?? 0) < 2 || (n[i] ?? 0) < 2 || (n[i + 1] ?? 0) < 2) continue;
      maximum = Math.max(
        maximum,
        Math.abs(
          (sum[i - 1] ?? 0) / (n[i - 1] ?? 1) -
            (2 * (sum[i] ?? 0)) / (n[i] ?? 1) +
            (sum[i + 1] ?? 0) / (n[i + 1] ?? 1),
        ),
      );
    }
    return maximum;
  };
  const vertical =
    curvature(columnSum, columnCount, probeColumns) >
    Math.max(0.03, curvature(rowSum, rowCount, probeRows) * 1.2);
  const columns = Math.min(vertical ? 256 : 64, Math.ceil(width / (vertical ? 2 : 8))),
    rows = Math.min(vertical ? 64 : 256, Math.ceil(height / (vertical ? 8 : 2))),
    count = columns * rows;
  const hist = new Uint32Array(count * 64),
    samples = new Uint32Array(count),
    level = new Float64Array(count),
    background = new Float64Array(count * 3),
    amount = new Uint32Array(count),
    strokes = new Uint32Array(count),
    ink = new Float64Array(count);
  const stride = Math.max(1, Math.ceil(Math.max(width, height) / 720)),
    radius = Math.max(2, Math.min(8, Math.round(Math.max(width, height) / 400)));
  for (let y = 0; y < height; y += stride)
    for (let x = 0; x < width; x += stride) {
      const at = (y * width + x) * 4;
      if (input.pixels[at + 3] !== 255) continue;
      const i = Math.floor((y * rows) / height) * columns + Math.floor((x * columns) / width),
        bin = gray(x, y) >> 2;
      hist[i * 64 + bin] = (hist[i * 64 + bin] ?? 0) + 1;
      samples[i] = (samples[i] ?? 0) + 1;
    }
  for (let i = 0; i < count; i++) {
    let seen = 0;
    for (let b = 0; b < 64; b++) {
      seen += hist[i * 64 + b] ?? 0;
      if (seen >= Math.max(1, Math.ceil((samples[i] ?? 0) * 0.85))) {
        level[i] = Math.min(255, b * 4 + 2);
        break;
      }
    }
  }
  for (let y = 0; y < height; y += stride)
    for (let x = 0; x < width; x += stride) {
      const at = (y * width + x) * 4;
      if (input.pixels[at + 3] !== 255) continue;
      const i = Math.floor((y * rows) / height) * columns + Math.floor((x * columns) / width),
        v = gray(x, y);
      if (Math.abs(v - (level[i] ?? 255)) <= 6) {
        amount[i] = (amount[i] ?? 0) + 1;
        for (let c = 0; c < 3; c++)
          background[i * 3 + c] = (background[i * 3 + c] ?? 0) + (input.pixels[at + c] ?? 0);
      }
      if (
        v < (level[i] ?? 255) * 0.78 &&
        ((gray(Math.max(0, x - radius), y) > v + 8 &&
          gray(Math.min(width - 1, x + radius), y) > v + 8) ||
          (gray(x, Math.max(0, y - radius)) > v + 8 &&
            gray(x, Math.min(height - 1, y + radius)) > v + 8))
      ) {
        ink[i] = (ink[i] ?? 0) + v;
        strokes[i] = (strokes[i] ?? 0) + 1;
      }
    }
  for (let i = 0; i < count; i++)
    ink[i] = (strokes[i] ?? 0) > 0 ? (ink[i] ?? 0) / (strokes[i] ?? 1) : 255;
  const references: number[] = [];
  for (let i = 0; i < coarse.connected.length; i++)
    if (coarse.connected[i] === 1 && (strokeMeans[i] ?? 255) < 255) {
      const at = i * 3,
        paper =
          (54 * (coarse.background[at] ?? 0) +
            183 * (coarse.background[at + 1] ?? 0) +
            19 * (coarse.background[at + 2] ?? 0)) /
          256;
      references.push((strokeMeans[i] ?? 255) / Math.max(1, paper));
    }
  references.sort((a, b) => a - b);
  const reference = references[Math.floor(references.length / 2)] ?? 0;
  const fallback = new Float64Array(count * 3),
    support = new Uint8Array(count),
    candidate = new Uint8Array(count),
    trusted = new Uint8Array(count),
    valid = new Uint8Array(count);
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < columns; x++) {
      const i = y * columns + x,
        cx = Math.min(coarse.columns - 1, Math.floor(((x + 0.5) * coarse.columns) / columns)),
        cy = Math.min(coarse.rows - 1, Math.floor(((y + 0.5) * coarse.rows) / rows)),
        co = cy * coarse.columns + cx;
      let neighbors = 0;
      if (coarse.connected[co] === 1) {
        support[i] = 1;
        for (let c = 0; c < 3; c++) fallback[i * 3 + c] = coarse.background[co * 3 + c] ?? 255;
      } else {
        // Only a small gap surrounded by recognized paper can be bridged.
        const top = Math.max(0, cy - 2) * coarse.columns + cx,
          bottom = Math.min(coarse.rows - 1, cy + 2) * coarse.columns + cx,
          left = cy * coarse.columns + Math.max(0, cx - 2),
          right = cy * coarse.columns + Math.min(coarse.columns - 1, cx + 2);
        const vertical = coarse.connected[top] === 1 && coarse.connected[bottom] === 1,
          horizontal = coarse.connected[left] === 1 && coarse.connected[right] === 1;
        if (vertical || horizontal) {
          support[i] = 2;
          for (const j of vertical ? [top, bottom] : [left, right]) {
            neighbors++;
            for (let c = 0; c < 3; c++)
              fallback[i * 3 + c] =
                (fallback[i * 3 + c] ?? 0) + (coarse.background[j * 3 + c] ?? 255);
          }
          for (let c = 0; c < 3; c++)
            fallback[i * 3 + c] = (fallback[i * 3 + c] ?? 255) / neighbors;
        }
      }
      const n = amount[i] ?? 0;
      for (let c = 0; c < 3; c++)
        background[i * 3 + c] = n ? (background[i * 3 + c] ?? 0) / n : (fallback[i * 3 + c] ?? 255);
      if (!support[i] || n < 3) continue;
      const r = background[i * 3] ?? 0,
        g = background[i * 3 + 1] ?? 0,
        b = background[i * 3 + 2] ?? 0,
        paper = (54 * r + 183 * g + 19 * b) / 256;
      const coarsePaper =
        (54 * (fallback[i * 3] ?? 0) +
          183 * (fallback[i * 3 + 1] ?? 0) +
          19 * (fallback[i * 3 + 2] ?? 0)) /
        256;
      if (paper < 70 || Math.max(r, g, b) - Math.min(r, g, b) > Math.max(r, g, b) * 0.22) continue;
      candidate[i] = 1;
      if (support[i] === 1 && paper >= coarsePaper * 0.85) {
        valid[i] = 1;
      }
      if (
        (strokes[i] ?? 0) >= 2 &&
        reference >= 0.03 &&
        Math.abs((ink[i] ?? 255) / paper - reference) <= Math.max(0.025, reference * 0.25)
      )
        trusted[i] = 1;
    }
  const visited = new Uint8Array(count),
    queue: number[] = [];
  for (let i = 0; i < count; i++)
    if (trusted[i] === 1) {
      visited[i] = 1;
      queue.push(i);
    }
  for (const i of queue) {
    valid[i] = 1;
    const x = i % columns,
      y = Math.floor(i / columns),
      here = level[i] ?? 255;
    for (const j of [
      x > 0 ? i - 1 : -1,
      x + 1 < columns ? i + 1 : -1,
      y > 0 ? i - columns : -1,
      y + 1 < rows ? i + columns : -1,
    ]) {
      if (j < 0 || candidate[j] !== 1 || visited[j] === 1) continue;
      if (Math.abs((level[j] ?? 255) - here) > Math.max(8, here * 0.12)) continue;
      if (valid[j] !== 1 && (strokes[j] ?? 0) >= 2 && trusted[j] !== 1) continue;
      visited[j] = 1;
      queue.push(j);
    }
  }
  // Unknown dark fills keep the coarse estimate, which the pixel guard protects.
  const strong = new Uint8Array(count),
    shadowSeen = new Uint8Array(count);
  for (let i = 0; i < count; i++)
    if (
      visited[i] === 1 &&
      (level[i] ?? 255) <
        0.85 *
          ((54 * (fallback[i * 3] ?? 0) +
            183 * (fallback[i * 3 + 1] ?? 0) +
            19 * (fallback[i * 3 + 2] ?? 0)) /
            256)
    )
      strong[i] = 1;
  let hasNarrowShadow = false;
  for (let seed = 0; seed < count && !hasNarrowShadow; seed++) {
    if (strong[seed] !== 1 || shadowSeen[seed] === 1) continue;
    const component = [seed];
    shadowSeen[seed] = 1;
    let minX = columns,
      maxX = 0,
      minY = rows,
      maxY = 0,
      inkEvidence = 0;
    for (const i of component) {
      const x = i % columns,
        y = Math.floor(i / columns);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      if (trusted[i] === 1) inkEvidence++;
      for (const j of [
        x > 0 ? i - 1 : -1,
        x + 1 < columns ? i + 1 : -1,
        y > 0 ? i - columns : -1,
        y + 1 < rows ? i + columns : -1,
      ]) {
        if (j < 0 || strong[j] !== 1 || shadowSeen[j] === 1) continue;
        if (Math.abs((level[i] ?? 0) - (level[j] ?? 0)) > Math.max(8, (level[i] ?? 0) * 0.12))
          continue;
        shadowSeen[j] = 1;
        component.push(j);
      }
    }
    hasNarrowShadow =
      inkEvidence >= 2 &&
      component.length >= 8 &&
      component.length < count * 0.18 &&
      (maxX - minX >= columns / 4 || maxY - minY >= rows / 4);
  }
  const connected = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    connected[i] = support[i] === 1 || valid[i] === 1 ? 1 : 0;
    if (valid[i] !== 1)
      for (let c = 0; c < 3; c++) background[i * 3 + c] = fallback[i * 3 + c] ?? 255;
  }
  return { columns, rows, background, connected, hasNarrowShadow };
}
