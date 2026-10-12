import type { DocumentCorners, ImageDimensions, Point } from '../../src/domain/document';
import type { Fixture, FixtureManifest } from './schema.ts';

export const BENCHMARK_NETWORK_POLICY = 'deny-external' as const;
export const OCR_NORMALIZATION_VERSION = 'unicode-nfc-whitespace-v1' as const;
export const DOCUMENT_IOU_GATE_THRESHOLD = 0.9;

export function validateNetworkEvidence(
  policy: unknown,
  externalRequests: unknown,
): { readonly policy: typeof BENCHMARK_NETWORK_POLICY; readonly externalRequests: 0 } {
  if (policy !== BENCHMARK_NETWORK_POLICY || externalRequests !== 0) {
    throw new RangeError(
      'Benchmark results require deny-external policy and zero external requests.',
    );
  }
  return { policy: BENCHMARK_NETWORK_POLICY, externalRequests: 0 };
}

export type NormalizedPrediction =
  | { readonly kind: 'document'; readonly corners: DocumentCorners }
  | { readonly kind: 'no-document' }
  | { readonly kind: 'error'; readonly code: string };

export interface CandidateDetection {
  readonly fixtureId: string;
  readonly prediction: NormalizedPrediction;
}

export interface CornerError {
  readonly meanPixels: number;
  readonly normalizedByDiagonal: number;
}

export interface ScoredFixture {
  readonly fixtureId: string;
  readonly contentRiskTags: readonly string[];
  readonly labelKind: 'document' | 'no-document';
  readonly geometryEligible: boolean;
  readonly predictionKind: 'document' | 'no-document' | 'error';
  readonly falseCrop: boolean;
  readonly missedDocument: boolean;
  readonly iou: number | null;
  readonly cornerError: CornerError | null;
}

export interface RatioMetric {
  readonly value: number | null;
  readonly numerator: number;
  readonly denominator: number;
  readonly reason: string | null;
}

export interface OcrTextMetrics {
  readonly normalizationVersion: typeof OCR_NORMALIZATION_VERSION;
  readonly cer: RatioMetric;
  readonly wer: RatioMetric;
}

/** Versioned test-only OCR normalization: NFC, Unicode White_Space collapse, then trim. */
export function normalizeOcrText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\p{White_Space}+/gu, ' ')
    .trim();
}

function editDistance(reference: readonly string[], hypothesis: readonly string[]): number {
  let previous = Array.from({ length: hypothesis.length + 1 }, (_, index) => index);
  for (let referenceIndex = 1; referenceIndex <= reference.length; referenceIndex += 1) {
    const current = [referenceIndex];
    for (let hypothesisIndex = 1; hypothesisIndex <= hypothesis.length; hypothesisIndex += 1) {
      const substitutionCost =
        reference[referenceIndex - 1] === hypothesis[hypothesisIndex - 1] ? 0 : 1;
      current[hypothesisIndex] = Math.min(
        (previous[hypothesisIndex] ?? Number.POSITIVE_INFINITY) + 1,
        (current[hypothesisIndex - 1] ?? Number.POSITIVE_INFINITY) + 1,
        (previous[hypothesisIndex - 1] ?? Number.POSITIVE_INFINITY) + substitutionCost,
      );
    }
    previous = current;
  }
  return previous[hypothesis.length] ?? 0;
}

function editRatio(reference: readonly string[], hypothesis: readonly string[]): RatioMetric {
  const numerator = editDistance(reference, hypothesis);
  const denominator = reference.length;
  return {
    value: denominator === 0 ? null : numerator / denominator,
    numerator,
    denominator,
    reason: denominator === 0 ? 'empty-reference' : null,
  };
}

/** Test-only OCR CER (code points) and WER (space-separated tokens); never imports production OCR. */
export function calculateOcrTextMetrics(reference: string, hypothesis: string): OcrTextMetrics {
  const normalizedReference = normalizeOcrText(reference);
  const normalizedHypothesis = normalizeOcrText(hypothesis);
  const referenceWords = normalizedReference.length === 0 ? [] : normalizedReference.split(' ');
  const hypothesisWords = normalizedHypothesis.length === 0 ? [] : normalizedHypothesis.split(' ');
  return {
    normalizationVersion: OCR_NORMALIZATION_VERSION,
    cer: editRatio(Array.from(normalizedReference), Array.from(normalizedHypothesis)),
    wer: editRatio(referenceWords, hypothesisWords),
  };
}

export interface BenchmarkAggregate {
  readonly schemaVersion: 1;
  readonly dataset: { readonly id: string; readonly revision: string };
  readonly geometryGate: {
    readonly threshold: typeof DOCUMENT_IOU_GATE_THRESHOLD;
    readonly eligibleDocuments: number;
    readonly passedDocuments: number;
    readonly passRate: RatioMetric;
    readonly failures: readonly {
      readonly fixtureId: string;
      readonly reason:
        'missed-detection' | 'engine-error' | 'below-iou-threshold' | 'no-valid-detection';
      readonly iou: number | null;
    }[];
  };
  readonly noDocumentGate: {
    readonly fixtures: number;
    readonly falseCrops: number;
    readonly falseCropRate: RatioMetric;
  };
  readonly counts: {
    readonly fixtures: number;
    readonly documents: number;
    readonly noDocuments: number;
    readonly geometryEligible: number;
    readonly falseCrops: number;
    readonly misses: number;
    readonly errors: number;
  };
  readonly metrics: {
    readonly falseCropRate: RatioMetric;
    readonly missedDetectionRate: RatioMetric;
    readonly meanIoU: RatioMetric;
    readonly meanCornerErrorPixels: RatioMetric;
    readonly meanCornerErrorNormalized: RatioMetric;
  };
  readonly byContentRiskTag: Readonly<
    Record<
      string,
      {
        readonly fixtures: number;
        readonly falseCrops: number;
        readonly misses: number;
        readonly geometryEligible: number;
        readonly meanIoU: RatioMetric;
      }
    >
  >;
  readonly perFixture: readonly ScoredFixture[];
}

function signedArea(corners: DocumentCorners): number {
  const origin = corners[0];
  if (origin === undefined) return 0;
  let twiceArea = 0;
  for (let index = 0; index < corners.length; index += 1) {
    const current = corners[index];
    const next = corners[(index + 1) % corners.length];
    if (current === undefined || next === undefined) return 0;
    const currentX = current.x - origin.x;
    const currentY = current.y - origin.y;
    const nextX = next.x - origin.x;
    const nextY = next.y - origin.y;
    twiceArea += currentX * nextY - nextX * currentY;
  }
  return twiceArea / 2;
}

/** Independent evaluator guard; intentionally separate from the production geometry implementation. */
export function assertValidBenchmarkQuad(
  corners: DocumentCorners,
  dimensions: ImageDimensions,
): void {
  if (
    !Number.isSafeInteger(dimensions.width) ||
    !Number.isSafeInteger(dimensions.height) ||
    dimensions.width <= 0 ||
    dimensions.height <= 0
  ) {
    throw new RangeError('Benchmark image dimensions must be positive safe integers.');
  }
  if (
    corners.length !== 4 ||
    corners.some(
      (point) =>
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        point.x < 0 ||
        point.y < 0 ||
        point.x > dimensions.width ||
        point.y > dimensions.height,
    )
  ) {
    throw new RangeError('Benchmark quad points must be finite and inside the original image.');
  }
  if (
    corners.some((point, index) =>
      corners.slice(0, index).some((other) => other.x === point.x && other.y === point.y),
    )
  ) {
    throw new RangeError('Benchmark quad points must be distinct.');
  }
  for (let index = 0; index < 4; index += 1) {
    const first = corners[index];
    const second = corners[(index + 1) % 4];
    const third = corners[(index + 2) % 4];
    if (first === undefined || second === undefined || third === undefined) {
      throw new RangeError('Benchmark quad requires four ordered points.');
    }
    const turn =
      (second.x - first.x) * (third.y - second.y) - (second.y - first.y) * (third.x - second.x);
    if (!Number.isFinite(turn) || turn <= 0) {
      throw new RangeError('Benchmark quad must be strictly convex and use TL/TR/BR/BL winding.');
    }
  }
  if (signedArea(corners) <= 0)
    throw new RangeError('Benchmark quad must use TL/TR/BR/BL winding.');
}

function cross(a: Point, b: Point, point: Point): number {
  return (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
}

function lineIntersection(start: Point, end: Point, edgeStart: Point, edgeEnd: Point): Point {
  const startDistance = cross(edgeStart, edgeEnd, start);
  const endDistance = cross(edgeStart, edgeEnd, end);
  const denominator = startDistance - endDistance;
  if (denominator === 0) return end;
  const ratio = startDistance / denominator;
  return {
    x: start.x + ratio * (end.x - start.x),
    y: start.y + ratio * (end.y - start.y),
  };
}

function clipPolygon(subject: readonly Point[], clip: DocumentCorners): Point[] {
  let output = [...subject];
  for (let edgeIndex = 0; edgeIndex < clip.length; edgeIndex += 1) {
    const edgeStart = clip[edgeIndex];
    const edgeEnd = clip[(edgeIndex + 1) % clip.length];
    if (edgeStart === undefined || edgeEnd === undefined || output.length === 0) return [];
    const input = output;
    output = [];
    let start = input[input.length - 1];
    if (start === undefined) return [];
    for (const end of input) {
      const startInside = cross(edgeStart, edgeEnd, start) >= 0;
      const endInside = cross(edgeStart, edgeEnd, end) >= 0;
      if (endInside) {
        if (!startInside) output.push(lineIntersection(start, end, edgeStart, edgeEnd));
        output.push(end);
      } else if (startInside) {
        output.push(lineIntersection(start, end, edgeStart, edgeEnd));
      }
      start = end;
    }
  }
  return output;
}

function polygonArea(points: readonly Point[]): number {
  if (points.length < 3) return 0;
  const origin = points[0];
  if (origin === undefined) return 0;
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    if (current === undefined || next === undefined) return 0;
    const currentX = current.x - origin.x;
    const currentY = current.y - origin.y;
    const nextX = next.x - origin.x;
    const nextY = next.y - origin.y;
    twiceArea += currentX * nextY - nextX * currentY;
  }
  return Math.abs(twiceArea) / 2;
}

/** Polygon intersection over union, in original image coordinates. */
export function calculatePolygonIoU(
  expected: DocumentCorners,
  actual: DocumentCorners,
  dimensions: ImageDimensions,
): number {
  assertValidBenchmarkQuad(expected, dimensions);
  assertValidBenchmarkQuad(actual, dimensions);
  const intersection = polygonArea(clipPolygon(actual, expected));
  const union = polygonArea(expected) + polygonArea(actual) - intersection;
  if (!(union > 0) || !Number.isFinite(union)) throw new RangeError('Quad union area is invalid.');
  return Math.max(0, Math.min(1, intersection / union));
}

export function assertValidBenchmarkIoU(value: number | null): void {
  if (value !== null && (!Number.isFinite(value) || value < 0 || value > 1)) {
    throw new RangeError('Benchmark IoU must be finite and within [0, 1].');
  }
}

function bestCyclicAlignment(expected: DocumentCorners, actual: DocumentCorners): DocumentCorners {
  let best: DocumentCorners | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset < 4; offset += 1) {
    const shifted: DocumentCorners = [
      actual[offset]!,
      actual[(offset + 1) % 4]!,
      actual[(offset + 2) % 4]!,
      actual[(offset + 3) % 4]!,
    ];
    const distance = expected.reduce((sum, point, index) => {
      const other = shifted[index];
      return other === undefined
        ? Number.POSITIVE_INFINITY
        : sum + Math.hypot(point.x - other.x, point.y - other.y);
    }, 0);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = shifted;
    }
  }
  if (best === null) throw new RangeError('Could not align quad corners.');
  return best;
}

export function calculateCornerError(
  expected: DocumentCorners,
  actual: DocumentCorners,
  dimensions: ImageDimensions,
): CornerError {
  assertValidBenchmarkQuad(expected, dimensions);
  assertValidBenchmarkQuad(actual, dimensions);
  const aligned = bestCyclicAlignment(expected, actual);
  const meanPixels = expected.reduce((sum, point, index) => {
    const other = aligned[index];
    return other === undefined
      ? Number.POSITIVE_INFINITY
      : sum + Math.hypot(point.x - other.x, point.y - other.y) / 4;
  }, 0);
  return {
    meanPixels,
    normalizedByDiagonal: meanPixels / Math.hypot(dimensions.width, dimensions.height),
  };
}

export function scoreFixtures(
  manifest: FixtureManifest,
  detections: readonly CandidateDetection[],
): ScoredFixture[] {
  const fixturesById = new Map(manifest.fixtures.map((fixture) => [fixture.id, fixture]));
  const detectionIds = new Set<string>();
  for (const detection of detections) {
    if (!fixturesById.has(detection.fixtureId))
      throw new RangeError(`Unknown fixture id: ${detection.fixtureId}`);
    if (detectionIds.has(detection.fixtureId))
      throw new RangeError(`Duplicate prediction: ${detection.fixtureId}`);
    detectionIds.add(detection.fixtureId);
  }
  if (detectionIds.size !== fixturesById.size)
    throw new RangeError('Every manifest fixture needs exactly one prediction.');
  const detectionsById = new Map(detections.map((detection) => [detection.fixtureId, detection]));
  return manifest.fixtures.map((fixture) => {
    const detection = detectionsById.get(fixture.id);
    if (detection === undefined) throw new RangeError(`Missing prediction: ${fixture.id}`);
    return scoreOne(fixture, detection.prediction);
  });
}

function scoreOne(fixture: Fixture, prediction: NormalizedPrediction): ScoredFixture {
  if (prediction.kind === 'document') {
    assertValidBenchmarkQuad(prediction.corners, fixture.image.dimensions);
  }
  const labelKind = fixture.label.kind;
  const predictedDocument = prediction.kind === 'document';
  let iou: number | null = null;
  let cornerError: CornerError | null = null;
  if (fixture.label.kind === 'document' && fixture.label.geometryEligible && predictedDocument) {
    iou = calculatePolygonIoU(fixture.label.corners, prediction.corners, fixture.image.dimensions);
    assertValidBenchmarkIoU(iou);
    cornerError = calculateCornerError(
      fixture.label.corners,
      prediction.corners,
      fixture.image.dimensions,
    );
  }
  return {
    fixtureId: fixture.id,
    contentRiskTags: [...fixture.contentRiskTags],
    labelKind,
    geometryEligible: fixture.label.kind === 'document' && fixture.label.geometryEligible,
    predictionKind: prediction.kind,
    falseCrop: fixture.label.kind === 'no-document' && predictedDocument,
    missedDocument: fixture.label.kind === 'document' && !predictedDocument,
    iou,
    cornerError,
  };
}

function ratio(numerator: number, denominator: number, reason: string): RatioMetric {
  return {
    value: denominator === 0 ? null : numerator / denominator,
    numerator,
    denominator,
    reason: denominator === 0 ? reason : null,
  };
}

function meanMetric(values: readonly number[], reason: string): RatioMetric {
  const sum = values.reduce((total, value) => total + value, 0);
  return ratio(sum, values.length, reason);
}

export function aggregateBenchmarkResults(
  manifest: FixtureManifest,
  detections: readonly CandidateDetection[],
): BenchmarkAggregate {
  const perFixture = scoreFixtures(manifest, detections);
  for (const entry of perFixture) assertValidBenchmarkIoU(entry.iou);
  if (perFixture.length !== manifest.fixtures.length) {
    throw new RangeError('Scored fixture count does not match manifest.');
  }
  const expectedIds = new Set(manifest.fixtures.map((fixture) => fixture.id));
  const seenIds = new Set<string>();
  for (const result of perFixture) {
    if (!expectedIds.has(result.fixtureId) || seenIds.has(result.fixtureId)) {
      throw new RangeError('Scored fixture IDs must match the manifest exactly once.');
    }
    seenIds.add(result.fixtureId);
  }
  if (seenIds.size !== expectedIds.size) {
    throw new RangeError('Scored fixture IDs must match the manifest exactly once.');
  }
  const documents = perFixture.filter((entry) => entry.labelKind === 'document').length;
  const noDocuments = perFixture.length - documents;
  const eligibleDocuments = perFixture.filter((entry) => entry.geometryEligible);
  const geometryFailures: BenchmarkAggregate['geometryGate']['failures'][number][] = [];
  for (const entry of eligibleDocuments) {
    if (entry.predictionKind === 'error') {
      geometryFailures.push({ fixtureId: entry.fixtureId, reason: 'engine-error', iou: entry.iou });
      continue;
    }
    if (entry.predictionKind === 'no-document') {
      geometryFailures.push({
        fixtureId: entry.fixtureId,
        reason: 'missed-detection',
        iou: entry.iou,
      });
      continue;
    }
    if (entry.iou === null) {
      geometryFailures.push({
        fixtureId: entry.fixtureId,
        reason: 'no-valid-detection',
        iou: null,
      });
      continue;
    }
    if (entry.iou < DOCUMENT_IOU_GATE_THRESHOLD) {
      geometryFailures.push({
        fixtureId: entry.fixtureId,
        reason: 'below-iou-threshold',
        iou: entry.iou,
      });
    }
  }
  const falseCrops = perFixture.filter((entry) => entry.falseCrop).length;
  const ious = perFixture.flatMap((entry) => (entry.iou === null ? [] : [entry.iou]));
  const errors = perFixture.flatMap((entry) =>
    entry.cornerError === null ? [] : [entry.cornerError],
  );
  const riskTags = [...new Set(perFixture.flatMap((entry) => entry.contentRiskTags))].sort();
  const byContentRiskTag = Object.fromEntries(
    riskTags.map((tag) => {
      const tagged = perFixture.filter((entry) => entry.contentRiskTags.includes(tag));
      const taggedIous = tagged.flatMap((entry) => (entry.iou === null ? [] : [entry.iou]));
      return [
        tag,
        {
          fixtures: tagged.length,
          falseCrops: tagged.filter((entry) => entry.falseCrop).length,
          misses: tagged.filter((entry) => entry.missedDocument).length,
          geometryEligible: tagged.filter((entry) => entry.geometryEligible).length,
          meanIoU: meanMetric(taggedIous, 'no-document-and-valid-detection-pairs'),
        },
      ];
    }),
  );
  return {
    schemaVersion: 1,
    dataset: { id: manifest.dataset.id, revision: manifest.dataset.revision },
    geometryGate: {
      threshold: DOCUMENT_IOU_GATE_THRESHOLD,
      eligibleDocuments: eligibleDocuments.length,
      passedDocuments: eligibleDocuments.length - geometryFailures.length,
      passRate: ratio(
        eligibleDocuments.length - geometryFailures.length,
        eligibleDocuments.length,
        'dataset-has-no-geometry-eligible-documents',
      ),
      failures: geometryFailures,
    },
    noDocumentGate: {
      fixtures: noDocuments,
      falseCrops,
      falseCropRate: ratio(falseCrops, noDocuments, 'dataset-has-no-no-document-fixtures'),
    },
    counts: {
      fixtures: perFixture.length,
      documents,
      noDocuments,
      geometryEligible: perFixture.filter((entry) => entry.geometryEligible).length,
      falseCrops: perFixture.filter((entry) => entry.falseCrop).length,
      misses: perFixture.filter((entry) => entry.missedDocument).length,
      errors: perFixture.filter((entry) => entry.predictionKind === 'error').length,
    },
    metrics: {
      falseCropRate: ratio(
        perFixture.filter((entry) => entry.falseCrop).length,
        noDocuments,
        'dataset-has-no-no-document-fixtures',
      ),
      missedDetectionRate: ratio(
        perFixture.filter((entry) => entry.missedDocument).length,
        documents,
        'dataset-has-no-document-fixtures',
      ),
      meanIoU: meanMetric(ious, 'no-document-and-valid-detection-pairs'),
      meanCornerErrorPixels: meanMetric(
        errors.map((entry) => entry.meanPixels),
        'no-valid-corner-pairs',
      ),
      meanCornerErrorNormalized: meanMetric(
        errors.map((entry) => entry.normalizedByDiagonal),
        'no-valid-corner-pairs',
      ),
    },
    byContentRiskTag,
    perFixture: [...perFixture],
  };
}
