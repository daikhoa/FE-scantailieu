import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import type { DocumentCorners, Point } from '../src/domain/document.ts';
import type { ContentRiskTag, FixtureManifest } from '../tests/golden/schema.ts';

const WIDTH = 640;
const HEIGHT = 480;
const GENERATOR_VERSION = 'clonecamscanner-synthetic-raster-v1';
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

type Rgb = readonly [red: number, green: number, blue: number];

interface Raster {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

interface FixtureSpec {
  readonly id: string;
  readonly fileName: string;
  readonly tags: readonly ContentRiskTag[];
  readonly corners?: DocumentCorners;
  readonly render: () => Raster;
}

function seededNoise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function createRaster(seed: number, base: Rgb): Raster {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
  const noise = seededNoise(seed);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const variation = Math.round((noise() - 0.5) * 12 + (y / HEIGHT - 0.5) * 8);
      setPixel(pixels, x, y, [
        clampChannel(base[0] + variation),
        clampChannel(base[1] + variation),
        clampChannel(base[2] + variation),
      ]);
    }
  }
  return { width: WIDTH, height: HEIGHT, pixels };
}

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function setPixel(pixels: Uint8Array, x: number, y: number, color: Rgb): void {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
  const offset = (y * WIDTH + x) * 4;
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
  pixels[offset + 3] = 255;
}

function pointInsideConvexPolygon(point: Point, corners: DocumentCorners): boolean {
  let sign = 0;
  for (let index = 0; index < corners.length; index += 1) {
    const start = corners[index]!;
    const end = corners[(index + 1) % corners.length]!;
    const cross = (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x);
    if (Math.abs(cross) < 0.001) continue;
    const nextSign = Math.sign(cross);
    if (sign !== 0 && nextSign !== sign) return false;
    sign = nextSign;
  }
  return true;
}

function fillDocument(raster: Raster, corners: DocumentCorners, seed: number): void {
  const noise = seededNoise(seed);
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      if (!pointInsideConvexPolygon({ x: x + 0.5, y: y + 0.5 }, corners)) continue;
      const paperNoise = Math.round((noise() - 0.5) * 8);
      const shade = Math.round(((x / raster.width) * 0.35 + (y / raster.height) * 0.65) * 8);
      setPixel(raster.pixels, x, y, [
        clampChannel(247 + paperNoise - shade),
        clampChannel(245 + paperNoise - shade),
        clampChannel(237 + paperNoise - shade),
      ]);
    }
  }
  for (let index = 0; index < corners.length; index += 1) {
    drawLine(raster, corners[index]!, corners[(index + 1) % corners.length]!, [49, 55, 61], 3);
  }
}

function interpolate(start: Point, end: Point, amount: number): Point {
  return {
    x: start.x + (end.x - start.x) * amount,
    y: start.y + (end.y - start.y) * amount,
  };
}

function documentRow(
  corners: DocumentCorners,
  verticalPosition: number,
  inset: number,
): [Point, Point] {
  const left = interpolate(corners[0], corners[3], verticalPosition);
  const right = interpolate(corners[1], corners[2], verticalPosition);
  return [interpolate(left, right, inset), interpolate(right, left, inset)];
}

function drawDocumentContent(raster: Raster, corners: DocumentCorners): void {
  const heading = documentRow(corners, 0.13, 0.2);
  drawLine(raster, heading[0], heading[1], [38, 57, 76], 5, corners);

  for (let row = 0; row < 13; row += 1) {
    const position = 0.22 + row * 0.045;
    const inset = row % 4 === 3 ? 0.19 : 0.11;
    const line = documentRow(corners, position, inset);
    drawLine(raster, line[0], line[1], [78, 84, 90], row % 3 === 0 ? 2 : 1, corners);
  }

  const tableTop = 0.71;
  const tableBottom = 0.9;
  for (let row = 0; row <= 4; row += 1) {
    const line = documentRow(corners, tableTop + ((tableBottom - tableTop) * row) / 4, 0.1);
    drawLine(raster, line[0], line[1], [64, 92, 105], 1, corners);
  }
  for (let column = 0; column <= 3; column += 1) {
    const fraction = 0.1 + (0.8 * column) / 3;
    const topLeft = interpolate(corners[0], corners[3], tableTop);
    const topRight = interpolate(corners[1], corners[2], tableTop);
    const bottomLeft = interpolate(corners[0], corners[3], tableBottom);
    const bottomRight = interpolate(corners[1], corners[2], tableBottom);
    drawLine(
      raster,
      interpolate(topLeft, topRight, fraction),
      interpolate(bottomLeft, bottomRight, fraction),
      [64, 92, 105],
      1,
      corners,
    );
  }
}

function drawLine(
  raster: Raster,
  start: Point,
  end: Point,
  color: Rgb,
  thickness: number,
  clip?: DocumentCorners,
): void {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(deltaX), Math.abs(deltaY))));
  const radius = Math.max(0, Math.floor(thickness / 2));
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(start.x + (deltaX * step) / steps);
    const y = Math.round(start.y + (deltaY * step) / steps);
    for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
      for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
        const point = { x: x + offsetX, y: y + offsetY };
        if (clip && !pointInsideConvexPolygon(point, clip)) continue;
        setPixel(raster.pixels, point.x, point.y, color);
      }
    }
  }
}

function fillRectangle(
  raster: Raster,
  left: number,
  top: number,
  width: number,
  height: number,
  color: Rgb,
): void {
  for (let y = top; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) setPixel(raster.pixels, x, y, color);
  }
}

function renderDocument(corners: DocumentCorners, seed: number, background: Rgb): Raster {
  const raster = createRaster(seed, background);
  fillDocument(raster, corners, seed ^ 0xa5a5_a5a5);
  drawDocumentContent(raster, corners);
  return raster;
}

function renderNoDocumentScene(seed: number): Raster {
  const raster = createRaster(seed, [92, 111, 117]);
  for (let row = 0; row < 18; row += 1) {
    const y = 20 + row * 26;
    const color: Rgb = row % 2 === 0 ? [73, 93, 99] : [113, 128, 130];
    drawLine(raster, { x: 0, y }, { x: WIDTH - 1, y: y + 34 }, color, 4);
  }
  fillRectangle(raster, 35, 290, 150, 115, [61, 75, 83]);
  fillRectangle(raster, 410, 38, 95, 155, [124, 98, 74]);
  fillRectangle(raster, 500, 330, 105, 80, [70, 119, 101]);
  return raster;
}

function renderClutterScene(seed: number): Raster {
  const raster = createRaster(seed, [150, 132, 112]);
  const colors: readonly Rgb[] = [
    [66, 88, 101],
    [176, 92, 68],
    [80, 126, 93],
    [117, 83, 128],
  ];
  for (let index = 0; index < 12; index += 1) {
    const left = 18 + ((index * 137) % 540);
    const top = 16 + ((index * 79) % 390);
    const width = 28 + ((index * 19) % 72);
    const height = 22 + ((index * 31) % 68);
    fillRectangle(raster, left, top, width, height, colors[index % colors.length]!);
  }
  for (let index = 0; index < 9; index += 1) {
    drawLine(
      raster,
      { x: (index * 73) % WIDTH, y: 0 },
      { x: WIDTH - 1 - ((index * 41) % WIDTH), y: HEIGHT - 1 },
      [109, 95, 83],
      2,
    );
  }
  return raster;
}

const FIXTURES: readonly FixtureSpec[] = [
  {
    id: 'synthetic-flat-document',
    fileName: 'flat-document.png',
    tags: ['table', 'small-text'],
    corners: [
      { x: 96, y: 72 },
      { x: 544, y: 72 },
      { x: 544, y: 408 },
      { x: 96, y: 408 },
    ],
    render: () =>
      renderDocument(
        [
          { x: 96, y: 72 },
          { x: 544, y: 72 },
          { x: 544, y: 408 },
          { x: 96, y: 408 },
        ],
        0x1020_3040,
        [80, 102, 109],
      ),
  },
  {
    id: 'synthetic-perspective-document',
    fileName: 'perspective-document.png',
    tags: ['small-text', 'colored-mark'],
    corners: [
      { x: 120, y: 50 },
      { x: 560, y: 110 },
      { x: 500, y: 420 },
      { x: 75, y: 360 },
    ],
    render: () =>
      renderDocument(
        [
          { x: 120, y: 50 },
          { x: 560, y: 110 },
          { x: 500, y: 420 },
          { x: 75, y: 360 },
        ],
        0x5060_7080,
        [68, 91, 81],
      ),
  },
  {
    id: 'synthetic-no-document-room',
    fileName: 'no-document-room.png',
    tags: [],
    render: () => renderNoDocumentScene(0x91a2_b3c4),
  },
  {
    id: 'synthetic-no-document-clutter',
    fileName: 'no-document-clutter.png',
    tags: ['illustration'],
    render: () => renderClutterScene(0xd5e6_f708),
  },
];

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1)
    crc = (crc & 1) !== 0 ? 0xedb8_8320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(buffer: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffff_ffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

function encodePng(raster: Raster): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(raster.width, 0);
  header.writeUInt32BE(raster.height, 4);
  header[8] = 8;
  header[9] = 6;

  const rowLength = raster.width * 4;
  const raw = Buffer.alloc((rowLength + 1) * raster.height);
  for (let y = 0; y < raster.height; y += 1) {
    const rowOffset = y * (rowLength + 1);
    raw[rowOffset] = 0;
    raw.set(raster.pixels.subarray(y * rowLength, (y + 1) * rowLength), rowOffset + 1);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export async function generateSyntheticFixtureSet(outputRoot: string): Promise<string> {
  const root = resolve(outputRoot);
  const imageDirectory = resolve(root, 'synthetic');
  await mkdir(imageDirectory, { recursive: true });

  const fixtures: FixtureManifest['fixtures'][number][] = [];
  for (const spec of FIXTURES) {
    const png = encodePng(spec.render());
    await writeFile(resolve(imageDirectory, spec.fileName), png);
    fixtures.push({
      id: spec.id,
      image: {
        path: `synthetic/${spec.fileName}`,
        sha256: createHash('sha256').update(png).digest('hex'),
        mimeType: 'image/png',
        dimensions: { width: WIDTH, height: HEIGHT },
        exifOrientationApplied: true,
      },
      label:
        spec.corners === undefined
          ? { kind: 'no-document', geometryEligible: false }
          : { kind: 'document', geometryEligible: true, corners: spec.corners },
      contentRiskTags: spec.tags,
      provenance: {
        kind: 'synthetic',
        generator: GENERATOR_VERSION,
        licenseSpdx: 'CC0-1.0',
        repoRedistributable: true,
        approvalRef: 'project-owned-deterministic-synthetic-fixture',
      },
      privacy: {
        containsPersonalData: false,
        repoApproved: true,
        sanitization: 'Programmatically generated pixels; no person or real document source used',
      },
    });
  }

  const manifest: FixtureManifest = {
    schemaVersion: 1,
    dataset: {
      id: 'clonecamscanner-synthetic-smoke',
      revision: GENERATOR_VERSION,
      createdAt: '2026-10-11T00:00:00.000Z',
      split: 'synthetic',
      coordinateSpace: 'original-image-pixels',
    },
    fixtures,
  };
  const manifestPath = resolve(root, 'manifest.example.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifestPath;
}

const executedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (executedPath && fileURLToPath(import.meta.url) === executedPath) {
  const outputRoot = process.argv[2] ? resolve(process.argv[2]) : resolve('tests/fixtures');
  const manifestPath = await generateSyntheticFixtureSet(outputRoot);
  process.stdout.write(`${manifestPath}\n`);
}
