import { createHash } from 'node:crypto';
import { open, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DocumentCorners, ImageDimensions } from '../src/domain/document.ts';
import type { CandidateDetection, NormalizedPrediction } from '../tests/golden/metrics.ts';
import {
  aggregateBenchmarkResults,
  calculateOcrTextMetrics,
  normalizeOcrText,
  OCR_NORMALIZATION_VERSION,
  validateNetworkEvidence,
} from '../tests/golden/metrics.ts';
import { parseFixtureManifest } from '../tests/golden/schema.ts';
import type { FixtureManifest } from '../tests/golden/schema.ts';

type JsonRecord = Record<string, unknown>;

export const MAX_MANIFEST_JSON_BYTES = 2 * 1024 * 1024;
export const MAX_RESULTS_JSON_BYTES = 8 * 1024 * 1024;
export const MAX_FIXTURE_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_OCR_REFERENCE_BYTES = 256 * 1024;
export const MAX_OCR_REFERENCE_TOTAL_BYTES = 16 * 1024 * 1024;
export const MAX_OCR_TEXT_CODE_POINTS = 4096;
export const MAX_OCR_EDIT_DISTANCE_CELLS = 20_000_000;

interface CandidateMetadata {
  readonly name: string;
  readonly version: string;
  readonly sourceRevision: string;
  readonly licenseSpdx: string;
}

interface EnvironmentMetadata {
  readonly browser: string;
  readonly os: string;
  readonly device: string;
  readonly runIndex: number;
}

interface TimedDetection extends CandidateDetection {
  readonly timingMs: { readonly detect: number; readonly initialize?: number };
  readonly memory: MemoryObservation;
}

type MemoryObservation =
  | {
      readonly status: 'measured';
      readonly method: string;
      readonly baselineBytes: number;
      readonly peakBytes: number;
    }
  | { readonly status: 'unavailable'; readonly method: 'unsupported'; readonly reason: string };

function fail(message: string): never {
  throw new Error(message);
}

function object(value: unknown, name: string, allowed: readonly string[]): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail(`${name} must be an object`);
  const record = value as JsonRecord;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail(`${name}.${key} is not supported`);
  }
  return record;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    fail(`${name} must be a non-empty string`);
  return value;
}

function finiteNonNegative(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(`${name} must be a finite nonnegative number`);
  }
  return value;
}

function parseCandidate(value: unknown): CandidateMetadata {
  const input = object(value, 'candidate', ['name', 'version', 'sourceRevision', 'licenseSpdx']);
  return {
    name: nonEmptyString(input.name, 'candidate.name'),
    version: nonEmptyString(input.version, 'candidate.version'),
    sourceRevision: nonEmptyString(input.sourceRevision, 'candidate.sourceRevision'),
    licenseSpdx: nonEmptyString(input.licenseSpdx, 'candidate.licenseSpdx'),
  };
}

function parseEnvironment(value: unknown): EnvironmentMetadata {
  const input = object(value, 'environment', ['browser', 'os', 'device', 'runIndex']);
  if (!Number.isSafeInteger(input.runIndex) || Number(input.runIndex) < 1) {
    fail('environment.runIndex must be a positive safe integer');
  }
  return {
    browser: nonEmptyString(input.browser, 'environment.browser'),
    os: nonEmptyString(input.os, 'environment.os'),
    device: nonEmptyString(input.device, 'environment.device'),
    runIndex: input.runIndex as number,
  };
}

function parsePoint(value: unknown, name: string): { readonly x: number; readonly y: number } {
  const input = object(value, name, ['x', 'y']);
  if (
    typeof input.x !== 'number' ||
    !Number.isFinite(input.x) ||
    typeof input.y !== 'number' ||
    !Number.isFinite(input.y)
  ) {
    fail(`${name} coordinates must be finite numbers`);
  }
  return { x: input.x, y: input.y };
}

function parseCorners(value: unknown, name: string): DocumentCorners {
  if (!Array.isArray(value) || value.length !== 4) fail(`${name} must contain four ordered points`);
  return [
    parsePoint(value[0], `${name}[0]`),
    parsePoint(value[1], `${name}[1]`),
    parsePoint(value[2], `${name}[2]`),
    parsePoint(value[3], `${name}[3]`),
  ];
}

function parsePrediction(
  value: unknown,
  dimensions: ImageDimensions,
  name: string,
): NormalizedPrediction {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail(`${name} must be an object`);
  const input = value as JsonRecord;
  if (input.kind === 'document') {
    object(input, name, ['kind', 'corners']);
    const corners = parseCorners(input.corners, `${name}.corners`);
    if (
      corners.some(
        (point) =>
          point.x < 0 || point.y < 0 || point.x > dimensions.width || point.y > dimensions.height,
      )
    ) {
      fail(`${name}.corners must be inside original image dimensions`);
    }
    return { kind: 'document', corners };
  }
  if (input.kind === 'no-document') {
    object(input, name, ['kind']);
    return { kind: 'no-document' };
  }
  if (input.kind === 'error') {
    object(input, name, ['kind', 'code']);
    return { kind: 'error', code: nonEmptyString(input.code, `${name}.code`) };
  }
  fail(`${name}.kind must be document, no-document or error`);
}

function parseMemory(value: unknown, name: string): MemoryObservation {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail(`${name} must be an object`);
  const input = value as JsonRecord;
  if (input.status === 'measured') {
    object(input, name, ['status', 'method', 'baselineBytes', 'peakBytes']);
    const baselineBytes = finiteNonNegative(input.baselineBytes, `${name}.baselineBytes`);
    const peakBytes = finiteNonNegative(input.peakBytes, `${name}.peakBytes`);
    if (peakBytes < baselineBytes) fail(`${name}.peakBytes cannot be lower than baselineBytes`);
    return {
      status: 'measured',
      method: nonEmptyString(input.method, `${name}.method`),
      baselineBytes,
      peakBytes,
    };
  }
  if (input.status === 'unavailable') {
    object(input, name, ['status', 'method', 'reason']);
    if (input.method !== 'unsupported') fail(`${name}.method must be unsupported when unavailable`);
    return {
      status: 'unavailable',
      method: 'unsupported',
      reason: nonEmptyString(input.reason, `${name}.reason`),
    };
  }
  fail(`${name}.status must be measured or unavailable`);
}

function parseDetections(value: unknown, manifest: FixtureManifest): TimedDetection[] {
  if (!Array.isArray(value)) fail('detections must be an array');
  const fixtureById = new Map(manifest.fixtures.map((fixture) => [fixture.id, fixture]));
  const seen = new Set<string>();
  const detections = value.map((entry, index) => {
    const name = `detections[${index}]`;
    const input = object(entry, name, ['fixtureId', 'prediction', 'timingMs', 'memory']);
    const fixtureId = nonEmptyString(input.fixtureId, `${name}.fixtureId`);
    const fixture = fixtureById.get(fixtureId);
    if (fixture === undefined) fail(`${name}.fixtureId is not in manifest`);
    if (seen.has(fixtureId)) fail(`${name}.fixtureId is duplicated`);
    seen.add(fixtureId);
    const timingInput = object(input.timingMs, `${name}.timingMs`, ['detect', 'initialize']);
    const timingMs = {
      detect: finiteNonNegative(timingInput.detect, `${name}.timingMs.detect`),
      ...(timingInput.initialize === undefined
        ? {}
        : { initialize: finiteNonNegative(timingInput.initialize, `${name}.timingMs.initialize`) }),
    };
    return {
      fixtureId,
      prediction: parsePrediction(input.prediction, fixture.image.dimensions, `${name}.prediction`),
      timingMs,
      memory: parseMemory(input.memory, `${name}.memory`),
    };
  });
  if (seen.size !== manifest.fixtures.length)
    fail('detections must contain exactly one result per fixture');
  return detections;
}

function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))] ?? null;
}

function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  // Samples are validated as finite and nonnegative, so the difference is bounded and the sum cannot overflow.
  return lower === undefined || upper === undefined ? null : lower + (upper - lower) / 2;
}

export function summarizeDistribution(values: readonly number[], emptyReason: string) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return {
      samples: 0,
      median: null,
      p75: null,
      p95: null,
      medianAbsoluteDeviation: null,
      emptyReason,
    };
  }
  // p75/p95 use nearest-rank; median and MAD average the middle pair for even sample counts.
  const medianValue = median(sorted);
  const deviations =
    medianValue === null
      ? []
      : sorted.map((value) => Math.abs(value - medianValue)).sort((a, b) => a - b);
  return {
    samples: sorted.length,
    median: medianValue,
    p75: percentile(sorted, 0.75),
    p95: percentile(sorted, 0.95),
    medianAbsoluteDeviation: median(deviations),
    emptyReason: null,
  };
}

function measurementSummary(detections: readonly TimedDetection[]) {
  const memoryMethods = [
    ...new Set(
      detections.flatMap((entry) =>
        entry.memory.status === 'measured' ? [entry.memory.method] : [],
      ),
    ),
  ];
  const memorySamples = detections.flatMap((entry) =>
    entry.memory.status === 'measured' ? [entry.memory] : [],
  );
  const unavailable = detections.find((entry) => entry.memory.status === 'unavailable');
  return {
    timingMs: {
      detection: summarizeDistribution(
        detections.map((entry) => entry.timingMs.detect),
        'no-detection-samples',
      ),
      initialization: summarizeDistribution(
        detections.flatMap((entry) =>
          entry.timingMs.initialize === undefined ? [] : [entry.timingMs.initialize],
        ),
        'initialization-not-reported',
      ),
    },
    memory: {
      method:
        memoryMethods.length === 1
          ? memoryMethods[0]
          : memoryMethods.length === 0
            ? 'unsupported'
            : 'mixed',
      samples: memorySamples.length,
      medianPeakBytes: median(memorySamples.map((entry) => entry.peakBytes).sort((a, b) => a - b)),
      maxPeakBytes:
        memorySamples.length === 0
          ? null
          : Math.max(...memorySamples.map((entry) => entry.peakBytes)),
      unavailableReason:
        unavailable?.memory.status === 'unavailable' ? unavailable.memory.reason : null,
    },
  };
}

interface OcrObservation {
  readonly fixtureId: string;
  readonly text: string;
}

function parseOcrObservations(value: unknown, manifest: FixtureManifest): OcrObservation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('ocrObservations must be an array when supplied');
  const references = new Set(
    manifest.fixtures
      .filter((fixture) => fixture.ocrReference !== undefined)
      .map((fixture) => fixture.id),
  );
  const fixtureIds = new Set(manifest.fixtures.map((fixture) => fixture.id));
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const name = `ocrObservations[${index}]`;
    const input = object(entry, name, ['fixtureId', 'text']);
    const fixtureId = nonEmptyString(input.fixtureId, `${name}.fixtureId`);
    if (!fixtureIds.has(fixtureId)) fail(`${name}.fixtureId is not in manifest`);
    if (!references.has(fixtureId)) fail(`${name}.fixtureId has no OCR reference in manifest`);
    if (seen.has(fixtureId)) fail(`${name}.fixtureId is duplicated`);
    seen.add(fixtureId);
    if (typeof input.text !== 'string') fail(`${name}.text must be a string`);
    if (Array.from(input.text).length > MAX_OCR_TEXT_CODE_POINTS) {
      fail(`${name}.text exceeds the ${MAX_OCR_TEXT_CODE_POINTS}-code-point limit`);
    }
    return { fixtureId, text: input.text };
  });
}

function ratioMetric(numerator: number, denominator: number, reason: string | null) {
  return {
    value: denominator === 0 ? null : numerator / denominator,
    numerator,
    denominator,
    reason: denominator === 0 ? reason : null,
  };
}

function scoreOcrObservations(
  manifest: FixtureManifest,
  references: ReadonlyMap<string, string>,
  observations: readonly OcrObservation[],
) {
  const observationById = new Map(observations.map((entry) => [entry.fixtureId, entry.text]));
  const referenceFixtures = manifest.fixtures.filter(
    (fixture) => fixture.ocrReference !== undefined,
  );
  let characterEdits = 0;
  let characterCount = 0;
  let wordEdits = 0;
  let wordCount = 0;
  let editDistanceCells = 0;
  const perFixture = referenceFixtures.map((fixture) => {
    const observation = observationById.get(fixture.id);
    if (observation === undefined) {
      const missing = {
        value: null,
        numerator: 0,
        denominator: 0,
        reason: 'observation-not-provided',
      };
      return { fixtureId: fixture.id, status: 'missing' as const, cer: missing, wer: missing };
    }
    const reference = references.get(fixture.id);
    if (reference === undefined) fail(`OCR reference was not loaded for fixture: ${fixture.id}`);
    const normalizedReference = normalizeOcrText(reference);
    const normalizedObservation = normalizeOcrText(observation);
    const referenceCodePoints = Array.from(normalizedReference);
    const observationCodePoints = Array.from(normalizedObservation);
    const referenceWords = normalizedReference === '' ? [] : normalizedReference.split(' ');
    const observationWords = normalizedObservation === '' ? [] : normalizedObservation.split(' ');
    editDistanceCells +=
      (referenceCodePoints.length + 1) * (observationCodePoints.length + 1) +
      (referenceWords.length + 1) * (observationWords.length + 1);
    if (editDistanceCells > MAX_OCR_EDIT_DISTANCE_CELLS) {
      fail(`OCR edit-distance work exceeds the ${MAX_OCR_EDIT_DISTANCE_CELLS}-cell limit`);
    }
    const metrics = calculateOcrTextMetrics(reference, observation);
    characterEdits += metrics.cer.numerator;
    characterCount += metrics.cer.denominator;
    wordEdits += metrics.wer.numerator;
    wordCount += metrics.wer.denominator;
    return { fixtureId: fixture.id, status: 'scored' as const, ...metrics };
  });
  const scoredCount = observations.length;
  const emptyReason =
    scoredCount > 0
      ? 'all-ocr-references-empty'
      : referenceFixtures.length > 0
        ? 'no-ocr-observations'
        : 'dataset-has-no-ocr-references';
  return {
    normalizationVersion: OCR_NORMALIZATION_VERSION,
    referenceFixtures: referenceFixtures.length,
    observationsProvided: observations.length,
    missingObservations: referenceFixtures.length - observations.length,
    cer: ratioMetric(characterEdits, characterCount, emptyReason),
    wer: ratioMetric(wordEdits, wordCount, emptyReason),
    perFixture,
    suppliedObservations: observations.map(({ fixtureId, text }) => ({ fixtureId, text })),
  };
}

function parseInput(
  value: unknown,
  manifest: FixtureManifest,
  ocrReferences: ReadonlyMap<string, string>,
) {
  const input = object(value, 'results', [
    'candidate',
    'environment',
    'network',
    'detections',
    'ocrObservations',
  ]);
  const network = object(input.network, 'network', ['policy', 'externalRequests']);
  let networkEvidence: { readonly policy: 'deny-external'; readonly externalRequests: 0 };
  try {
    networkEvidence = validateNetworkEvidence(network.policy, network.externalRequests);
  } catch (error) {
    fail(error instanceof Error ? error.message : 'invalid network evidence');
  }
  const detections = parseDetections(input.detections, manifest);
  const ocrObservations = parseOcrObservations(input.ocrObservations, manifest);
  const candidate = parseCandidate(input.candidate);
  const environment = parseEnvironment(input.environment);
  return {
    schemaVersion: 1,
    candidate,
    environment,
    network: networkEvidence,
    measurements: measurementSummary(detections),
    aggregate: aggregateBenchmarkResults(manifest, detections),
    ocr: scoreOcrObservations(manifest, ocrReferences, ocrObservations),
  } as const;
}

function parseArguments(argv: readonly string[]): {
  manifestPath: string;
  resultsPath: string;
  outputPath?: string;
} {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') {
      return { manifestPath: '', resultsPath: '' };
    }
    if (flag !== '--manifest' && flag !== '--results' && flag !== '--output') {
      fail(`unknown option: ${String(flag)}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`${flag} requires a path`);
    options.set(flag, value);
    index += 1;
  }
  const manifestPath = options.get('--manifest');
  const resultsPath = options.get('--results');
  if (manifestPath === undefined || resultsPath === undefined) {
    fail(
      'usage: node --experimental-strip-types scripts/benchmark-scanner.ts --manifest <manifest.json> --results <normalized-results.json> [--output <result.json>]',
    );
  }
  const outputPath = options.get('--output');
  return { manifestPath, resultsPath, ...(outputPath === undefined ? {} : { outputPath }) };
}

function insideDirectory(directory: string, filePath: string): boolean {
  const pathFromRoot = relative(directory, filePath);
  return (
    pathFromRoot !== '' &&
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

async function readBoundedRegularFile(
  path: string,
  maximumBytes: number,
  label: string,
): Promise<Buffer> {
  const pathInfo = await stat(path);
  if (!pathInfo.isFile()) fail(`${label} must be a regular file`);
  if (pathInfo.size < 1) fail(`${label} must not be empty`);
  if (pathInfo.size > maximumBytes) fail(`${label} exceeds the ${maximumBytes}-byte limit`);
  const file = await open(path, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile()) fail(`${label} must be a regular file`);
    if (before.size < 1) fail(`${label} must not be empty`);
    if (before.size > maximumBytes) fail(`${label} exceeds the ${maximumBytes}-byte limit`);
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.byteLength;
      if (totalBytes > maximumBytes) fail(`${label} exceeds the ${maximumBytes}-byte limit`);
      chunks.push(bytes);
    }
    const after = await file.stat();
    if (after.size !== before.size || totalBytes !== before.size) {
      fail(`${label} changed while being read`);
    }
    return Buffer.concat(chunks, totalBytes);
  } finally {
    await file.close();
  }
}

async function readJson(path: string, maximumBytes: number, label: string): Promise<unknown> {
  return JSON.parse(
    (await readBoundedRegularFile(path, maximumBytes, label)).toString('utf8'),
  ) as unknown;
}

async function hashRegularFixture(path: string, fixtureId: string): Promise<string> {
  const pathInfo = await stat(path);
  if (!pathInfo.isFile()) fail(`fixture is not a regular file: ${fixtureId}`);
  if (pathInfo.size < 1) fail(`fixture is empty: ${fixtureId}`);
  if (pathInfo.size > MAX_FIXTURE_IMAGE_BYTES) {
    fail(`fixture exceeds the ${MAX_FIXTURE_IMAGE_BYTES}-byte limit: ${fixtureId}`);
  }
  const file = await open(path, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile()) fail(`fixture is not a regular file: ${fixtureId}`);
    if (before.size < 1) fail(`fixture is empty: ${fixtureId}`);
    if (before.size > MAX_FIXTURE_IMAGE_BYTES) {
      fail(`fixture exceeds the ${MAX_FIXTURE_IMAGE_BYTES}-byte limit: ${fixtureId}`);
    }
    const hash = createHash('sha256');
    let totalBytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_FIXTURE_IMAGE_BYTES) {
        fail(`fixture exceeds the ${MAX_FIXTURE_IMAGE_BYTES}-byte limit: ${fixtureId}`);
      }
      hash.update(bytes);
    }
    const after = await file.stat();
    if (after.size !== before.size || totalBytes !== before.size) {
      fail(`fixture changed while being hashed: ${fixtureId}`);
    }
    return hash.digest('hex');
  } finally {
    await file.close();
  }
}

async function verifyFixtureFiles(
  manifest: FixtureManifest,
  manifestPath: string,
): Promise<ReadonlyMap<string, string>> {
  const root = await realpath(resolve(dirname(manifestPath)));
  const ocrReferences = new Map<string, string>();
  let totalOcrBytes = 0;
  for (const fixture of manifest.fixtures) {
    const filePath = resolve(root, ...fixture.image.path.split('/'));
    if (!insideDirectory(root, filePath))
      fail(`fixture path escapes manifest directory: ${fixture.id}`);
    const actualPath = await realpath(filePath);
    if (!insideDirectory(root, actualPath))
      fail(`fixture symlink escapes manifest directory: ${fixture.id}`);
    const digest = await hashRegularFixture(actualPath, fixture.id);
    if (digest.toLowerCase() !== fixture.image.sha256.toLowerCase()) {
      fail(`fixture SHA-256 mismatch: ${fixture.id}`);
    }
    if (fixture.ocrReference !== undefined) {
      const referencePath = resolve(root, ...fixture.ocrReference.textPath.split('/'));
      if (!insideDirectory(root, referencePath)) {
        fail(`OCR reference path escapes manifest directory: ${fixture.id}`);
      }
      const actualReferencePath = await realpath(referencePath);
      if (!insideDirectory(root, actualReferencePath)) {
        fail(`OCR reference symlink escapes manifest directory: ${fixture.id}`);
      }
      const bytes = await readBoundedRegularFile(
        actualReferencePath,
        MAX_OCR_REFERENCE_BYTES,
        `OCR reference ${fixture.id}`,
      );
      totalOcrBytes += bytes.byteLength;
      if (totalOcrBytes > MAX_OCR_REFERENCE_TOTAL_BYTES) {
        fail(`OCR references exceed the ${MAX_OCR_REFERENCE_TOTAL_BYTES}-byte total limit`);
      }
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest.toLowerCase() !== fixture.ocrReference.sha256.toLowerCase()) {
        fail(`OCR reference SHA-256 mismatch: ${fixture.id}`);
      }
      let referenceText: string;
      try {
        referenceText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        fail(`OCR reference is not valid UTF-8: ${fixture.id}`);
      }
      if (Array.from(referenceText).length > MAX_OCR_TEXT_CODE_POINTS) {
        fail(
          `OCR reference exceeds the ${MAX_OCR_TEXT_CODE_POINTS}-code-point limit: ${fixture.id}`,
        );
      }
      ocrReferences.set(fixture.id, referenceText);
    }
  }
  return ocrReferences;
}

export async function runBenchmarkCli(argv: readonly string[]): Promise<void> {
  const args = parseArguments(argv);
  if (args.manifestPath === '') {
    process.stdout.write(
      'Validate a local manifest and score normalized, precomputed engine results. This CLI never fetches or runs a scanner engine.\n',
    );
    return;
  }
  const manifestPath = resolve(args.manifestPath);
  const resultsPath = resolve(args.resultsPath);
  const manifest = parseFixtureManifest(
    await readJson(manifestPath, MAX_MANIFEST_JSON_BYTES, 'manifest JSON'),
  );
  const ocrReferences = await verifyFixtureFiles(manifest, manifestPath);
  const result = parseInput(
    await readJson(resultsPath, MAX_RESULTS_JSON_BYTES, 'results JSON'),
    manifest,
    ocrReferences,
  );
  const serialized = `${JSON.stringify({ dataset: manifest.dataset, ...result }, null, 2)}\n`;
  if (args.outputPath === undefined) process.stdout.write(serialized);
  else await writeFile(resolve(args.outputPath), serialized, 'utf8');
}

const currentScript = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (currentScript === fileURLToPath(import.meta.url)) {
  runBenchmarkCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown benchmark failure';
    process.stderr.write(`benchmark-scanner: ${message}\n`);
    process.exitCode = 1;
  });
}
