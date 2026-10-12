import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DocumentCorners, ImageDimensions } from '../src/domain/document.ts';
import type { ContentRiskTag, FixtureManifest } from '../tests/golden/schema.ts';
import { parseFixtureManifest } from '../tests/golden/schema.ts';

export interface SmartDocFrame {
  readonly index: number;
  readonly corners: DocumentCorners;
}

interface DocumentSpec {
  readonly id: string;
  readonly split: 'development' | 'holdout';
  readonly tags: readonly ContentRiskTag[];
}

const DOCUMENTS: readonly DocumentSpec[] = [
  { id: 'datasheet001', split: 'development', tags: ['table', 'small-text'] },
  { id: 'letter001', split: 'development', tags: ['small-text'] },
  {
    id: 'magazine001',
    split: 'holdout',
    tags: ['colored-mark', 'illustration', 'small-text'],
  },
];

const SOURCE_URI = 'https://zenodo.org/records/1230218';
const SOURCE_REVISION = '10.5281/zenodo.1230218';
const LICENSE_URI = 'https://creativecommons.org/licenses/by/4.0/';
const ATTRIBUTION =
  'ICDAR2015 SmartDoc Challenge 1; Burie, Chazalon, Coustaty, Eskenazi, Luqman, Mehri, Nayef, Ogier, Prum and Rusinol.';
const PREVIEW_MAX_SIDE = 960;
const SELECTED_FRAMES_PER_DOCUMENT = 5;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 60_000;

function invalid(reason: string): never {
  throw new Error(`Invalid SmartDoc ground truth: ${reason}`);
}

function attribute(input: string, name: string): string | null {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(input)?.[1] ?? null;
}

function positiveInteger(value: string | null, field: string): number {
  const parsed = value === null ? Number.NaN : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) invalid(`${field} must be a positive integer`);
  return parsed;
}

function coordinate(value: string | null, field: string): number {
  const parsed = value === null ? Number.NaN : Number(value);
  if (!Number.isFinite(parsed)) invalid(`${field} must be finite`);
  return parsed;
}

export function parseSmartDocGroundTruth(xml: string): readonly SmartDocFrame[] {
  if (xml.includes('<!DOCTYPE') || xml.includes('<!ENTITY')) {
    invalid('document type and entity declarations are not allowed');
  }
  const frames: SmartDocFrame[] = [];
  const indexes = new Set<number>();
  const framePattern = /<frame\s+([^>]*?)>([\s\S]*?)<\/frame>/g;
  for (const match of xml.matchAll(framePattern)) {
    const frameAttributes = match[1];
    const frameBody = match[2];
    if (frameAttributes === undefined || frameBody === undefined) invalid('malformed frame');
    const index = positiveInteger(attribute(frameAttributes, 'index'), 'frame index');
    if (indexes.has(index)) invalid(`duplicate frame index ${String(index)}`);
    indexes.add(index);
    const rejected = attribute(frameAttributes, 'rejected');
    if (rejected !== 'true' && rejected !== 'false') invalid('frame rejected must be boolean');
    if (rejected === 'true') continue;

    const points = new Map<string, { x: number; y: number }>();
    const pointPattern = /<point\s+([^>]*?)\/?\s*>/g;
    for (const pointMatch of frameBody.matchAll(pointPattern)) {
      const pointAttributes = pointMatch[1];
      if (pointAttributes === undefined) invalid('malformed point');
      const name = attribute(pointAttributes, 'name');
      if (name === null || !['tl', 'tr', 'br', 'bl'].includes(name)) {
        invalid('unknown corner name');
      }
      if (points.has(name)) invalid(`duplicate ${name} corner`);
      points.set(name, {
        x: coordinate(attribute(pointAttributes, 'x'), `${name}.x`),
        y: coordinate(attribute(pointAttributes, 'y'), `${name}.y`),
      });
    }
    const topLeft = points.get('tl');
    const topRight = points.get('tr');
    const bottomRight = points.get('br');
    const bottomLeft = points.get('bl');
    if (
      topLeft === undefined ||
      topRight === undefined ||
      bottomRight === undefined ||
      bottomLeft === undefined ||
      points.size !== 4
    ) {
      invalid(`frame ${String(index)} must contain exactly four corners`);
    }
    frames.push({ index, corners: [topLeft, topRight, bottomRight, bottomLeft] });
  }
  if (frames.length === 0) invalid('no accepted frames');
  return frames;
}

export function selectRepresentativeFrames(
  frames: readonly SmartDocFrame[],
  count: number,
): readonly SmartDocFrame[] {
  if (!Number.isSafeInteger(count) || count < 1) throw new RangeError('Invalid frame count.');
  if (frames.length === 0) throw new RangeError('Cannot select from an empty frame sequence.');
  if (count >= frames.length) return frames.slice();
  if (count === 1) return [frames[Math.floor((frames.length - 1) / 2)]!];
  return Array.from({ length: count }, (_, position) => {
    const index = Math.round((position * (frames.length - 1)) / (count - 1));
    return frames[index]!;
  });
}

function run(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf8',
        maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
        timeout: COMMAND_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error === null) resolveCommand(stdout);
        else rejectCommand(new Error(`${command} failed while preparing SmartDoc fixtures.`));
      },
    );
  });
}

function scaledDimensions(source: ImageDimensions): ImageDimensions {
  const scale = Math.min(1, PREVIEW_MAX_SIDE / Math.max(source.width, source.height));
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}

async function videoDimensions(path: string): Promise<ImageDimensions> {
  const stdout = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'json',
    path,
  ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('ffprobe returned invalid JSON.');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('streams' in parsed) ||
    !Array.isArray(parsed.streams) ||
    parsed.streams.length !== 1
  ) {
    throw new Error('ffprobe did not return one video stream.');
  }
  const stream: unknown = parsed.streams[0];
  if (
    typeof stream !== 'object' ||
    stream === null ||
    !('width' in stream) ||
    !('height' in stream) ||
    !Number.isSafeInteger(stream.width) ||
    !Number.isSafeInteger(stream.height) ||
    Number(stream.width) < 1 ||
    Number(stream.height) < 1
  ) {
    throw new Error('ffprobe returned invalid video dimensions.');
  }
  return { width: Number(stream.width), height: Number(stream.height) };
}

function scaleCorners(
  corners: DocumentCorners,
  source: ImageDimensions,
  target: ImageDimensions,
): DocumentCorners {
  const scaleX = target.width / source.width;
  const scaleY = target.height / source.height;
  return corners.map(({ x, y }) => ({
    x: x * scaleX,
    y: y * scaleY,
  })) as unknown as DocumentCorners;
}

async function extractFrame(
  videoPath: string,
  frameIndex: number,
  dimensions: ImageDimensions,
  outputPath: string,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  const zeroBasedIndex = frameIndex - 1;
  await run('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    videoPath,
    '-vf',
    `select=eq(n\\,${String(zeroBasedIndex)}),scale=${String(dimensions.width)}:${String(dimensions.height)}`,
    '-frames:v',
    '1',
    outputPath,
  ]);
}

async function imageHash(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

function fixtureId(documentId: string, frameIndex: number): string {
  return `smartdoc15-${documentId}-frame-${String(frameIndex).padStart(4, '0')}`;
}

async function prepareDocument(
  sourceRoot: string,
  outputRoot: string,
  spec: DocumentSpec,
): Promise<FixtureManifest['fixtures']> {
  const videoPath = resolve(sourceRoot, 'input_sample', 'background00', `${spec.id}.avi`);
  const groundTruthPath = resolve(
    sourceRoot,
    'input_sample_groundtruth',
    'background00_gt',
    `${spec.id}.gt.xml`,
  );
  const sourceDimensions = await videoDimensions(videoPath);
  const dimensions = scaledDimensions(sourceDimensions);
  const frames = selectRepresentativeFrames(
    parseSmartDocGroundTruth(await readFile(groundTruthPath, 'utf8')),
    SELECTED_FRAMES_PER_DOCUMENT,
  );
  const fixtures: FixtureManifest['fixtures'][number][] = [];
  for (const frame of frames) {
    const id = fixtureId(spec.id, frame.index);
    const relativePath = `images/${id}.png`;
    const outputPath = resolve(outputRoot, spec.split, relativePath);
    await extractFrame(videoPath, frame.index, dimensions, outputPath);
    fixtures.push({
      id,
      image: {
        path: relativePath,
        sha256: await imageHash(outputPath),
        mimeType: 'image/png',
        dimensions,
        exifOrientationApplied: true,
      },
      label: {
        kind: 'document',
        geometryEligible: true,
        corners: scaleCorners(frame.corners, sourceDimensions, dimensions),
      },
      contentRiskTags: spec.tags,
      provenance: {
        kind: 'licensed',
        licenseSpdx: 'CC-BY-4.0',
        repoRedistributable: true,
        sourceUri: SOURCE_URI,
        sourceRevision: SOURCE_REVISION,
        acquiredAt: '2026-10-12T00:00:00.000Z',
        attribution: ATTRIBUTION,
        licenseUrl: LICENSE_URI,
        approvalRef: 'project-owner-approved-smartdoc15-source-2026-10-12',
      },
      privacy: {
        containsPersonalData: false,
        repoApproved: true,
        sanitization:
          'Official benchmark sample built from public document models; selected frames contain no real identity or personal record.',
      },
    });
  }
  return fixtures;
}

export async function prepareSmartDocSample(sourceRoot: string, outputRoot: string): Promise<void> {
  const grouped: Record<'development' | 'holdout', FixtureManifest['fixtures'][number][]> = {
    development: [],
    holdout: [],
  };
  for (const spec of DOCUMENTS) {
    grouped[spec.split].push(...(await prepareDocument(sourceRoot, outputRoot, spec)));
  }
  for (const split of ['development', 'holdout'] as const) {
    const manifest: FixtureManifest = {
      schemaVersion: 1,
      dataset: {
        id: `smartdoc15-sample-${split}`,
        revision: `${SOURCE_REVISION}-preview-960-v1`,
        createdAt: '2026-10-12T00:00:00.000Z',
        split,
        coordinateSpace: 'original-image-pixels',
      },
      fixtures: grouped[split],
    };
    parseFixtureManifest(manifest);
    const manifestPath = resolve(outputRoot, split, 'manifest.json');
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
}

const currentScript = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (currentScript === fileURLToPath(import.meta.url)) {
  const sourceRoot = resolve(process.argv[2] ?? 'tests/datasets/smartdoc15-sample/sampleDataset');
  const outputRoot = resolve(process.argv[3] ?? 'tests/fixtures/smartdoc15');
  prepareSmartDocSample(sourceRoot, outputRoot).catch(() => {
    process.stderr.write('prepare-smartdoc-sample: fixture preparation failed\n');
    process.exitCode = 1;
  });
}
