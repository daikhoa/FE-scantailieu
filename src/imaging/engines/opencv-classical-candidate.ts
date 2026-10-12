import type { DocumentCorners, ImageDimensions, Point } from '../../domain/document';
import { isValidImageDimensions } from '../geometry/coordinates';
import { orderCorners, validateQuad } from '../geometry/quad';

export interface OpenCvQuadCandidate {
  /** Four vertices emitted by approxPolyDP; ordering is not trusted. */
  readonly points: readonly [Point, Point, Point, Point];
  /** Fraction of perimeter samples backed by a nearby edge pixel. */
  readonly edgeSupport: number;
}

export interface SelectedOpenCvCandidate {
  readonly corners: DocumentCorners;
  readonly confidence: number;
  readonly diagnostics: {
    readonly areaRatio: number;
    readonly edgeSupport: number;
    readonly shapeQuality: number;
  };
}

const MINIMUM_AREA_RATIO = 0.08;
const MAXIMUM_AREA_RATIO = 0.96;
const MINIMUM_EDGE_SUPPORT = 0.18;
const DEFAULT_MINIMUM_CONFIDENCE = 0.58;

function boundedRatio(a: number, b: number): number {
  const largest = Math.max(a, b);
  return largest === 0 ? 0 : Math.min(a, b) / largest;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function shapeQuality([topLeft, topRight, bottomRight, bottomLeft]: DocumentCorners): number {
  const top = distance(topLeft, topRight);
  const right = distance(topRight, bottomRight);
  const bottom = distance(bottomRight, bottomLeft);
  const left = distance(bottomLeft, topLeft);
  const firstDiagonal = distance(topLeft, bottomRight);
  const secondDiagonal = distance(topRight, bottomLeft);
  const oppositeEdgeBalance = (boundedRatio(top, bottom) + boundedRatio(left, right)) / 2;
  const diagonalBalance = boundedRatio(firstDiagonal, secondDiagonal);
  const shortestSide = Math.min(top, right, bottom, left);
  const longestSide = Math.max(top, right, bottom, left);
  const sideBalance = longestSide === 0 ? 0 : Math.min(1, (shortestSide / longestSide) * 2);
  return (oppositeEdgeBalance + diagonalBalance + sideBalance) / 3;
}

function areaQuality(areaRatio: number): number {
  // A broad peak avoids assuming A4: notebooks, receipts, cards and whiteboards remain valid.
  return Math.max(0, 1 - Math.abs(areaRatio - 0.5) / 0.5);
}

function scoreCandidate(
  dimensions: ImageDimensions,
  candidate: OpenCvQuadCandidate,
): SelectedOpenCvCandidate | null {
  if (
    !Number.isFinite(candidate.edgeSupport) ||
    candidate.edgeSupport < MINIMUM_EDGE_SUPPORT ||
    candidate.edgeSupport > 1
  ) {
    return null;
  }
  const corners = orderCorners(candidate.points);
  if (corners === null) return null;
  const validation = validateQuad(corners, dimensions, 1);
  if (!validation.valid) return null;
  const areaRatio = validation.area / (dimensions.width * dimensions.height);
  if (areaRatio < MINIMUM_AREA_RATIO || areaRatio > MAXIMUM_AREA_RATIO) return null;
  const geometryQuality = shapeQuality(corners);
  const confidence =
    candidate.edgeSupport * 0.5 + areaQuality(areaRatio) * 0.3 + geometryQuality * 0.2;
  return {
    corners,
    confidence: Math.max(0, Math.min(1, confidence)),
    diagnostics: { areaRatio, edgeSupport: candidate.edgeSupport, shapeQuality: geometryQuality },
  };
}

/**
 * Ranks OpenCV quadrilaterals without trusting contour order or raw contour size alone.
 * The thresholds are spike policy and must be qualified on a representative mobile dataset.
 */
export function selectOpenCvDocumentCandidate(
  dimensions: ImageDimensions,
  candidates: readonly OpenCvQuadCandidate[],
  minimumConfidence = DEFAULT_MINIMUM_CONFIDENCE,
): SelectedOpenCvCandidate | null {
  if (
    !isValidImageDimensions(dimensions) ||
    !Number.isFinite(minimumConfidence) ||
    minimumConfidence < 0 ||
    minimumConfidence > 1
  ) {
    throw new RangeError('OpenCV candidate selection parameters are invalid.');
  }
  let best: SelectedOpenCvCandidate | null = null;
  for (const candidate of candidates) {
    const scored = scoreCandidate(dimensions, candidate);
    if (scored !== null && (best === null || scored.confidence > best.confidence)) best = scored;
  }
  return best !== null && best.confidence >= minimumConfidence ? best : null;
}
