import type { DocumentCorners, ImageDimensions, Point } from '../../domain/document';
import { isFinitePoint, isValidImageDimensions } from './coordinates';

export type QuadValidation =
  | { readonly valid: true; readonly area: number }
  | {
      readonly valid: false;
      readonly reason:
        | 'invalid-dimensions'
        | 'non-finite-point'
        | 'out-of-bounds'
        | 'self-intersection'
        | 'degenerate'
        | 'non-convex'
        | 'area-too-small';
    };

type QuadFailure = Extract<QuadValidation, { valid: false }>['reason'];

/** A local relative error bound preserves thin quads in very long images. */
function turnDirection(a: Point, b: Point, c: Point): -1 | 0 | 1 {
  const bx = b.x - a.x;
  const by = b.y - a.y;
  const cx = c.x - a.x;
  const cy = c.y - a.y;
  const scale = Math.max(Math.abs(bx), Math.abs(by), Math.abs(cx), Math.abs(cy));
  if (scale === 0 || !Number.isFinite(scale)) return 0;
  const first = (bx / scale) * (cy / scale);
  const second = (by / scale) * (cx / scale);
  const determinant = first - second;
  const errorBound = 8 * Number.EPSILON * (Math.abs(first) + Math.abs(second));
  if (Math.abs(determinant) <= errorBound) return 0;
  return determinant > 0 ? 1 : -1;
}

function samePoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

function onSegment(point: Point, a: Point, b: Point): boolean {
  return (
    point.x >= Math.min(a.x, b.x) &&
    point.x <= Math.max(a.x, b.x) &&
    point.y >= Math.min(a.y, b.y) &&
    point.y <= Math.max(a.y, b.y)
  );
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const abc = turnDirection(a, b, c);
  const abd = turnDirection(a, b, d);
  const cda = turnDirection(c, d, a);
  const cdb = turnDirection(c, d, b);
  return (
    (abc * abd < 0 && cda * cdb < 0) ||
    (abc === 0 && onSegment(c, a, b)) ||
    (abd === 0 && onSegment(d, a, b)) ||
    (cda === 0 && onSegment(a, c, d)) ||
    (cdb === 0 && onSegment(b, c, d))
  );
}

function quadArea([a, b, c, d]: DocumentCorners): number {
  // Translate before multiplication to avoid cancellation at large image offsets.
  const first = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const second = (c.x - a.x) * (d.y - a.y) - (c.y - a.y) * (d.x - a.x);
  return Math.abs(first + second) / 2;
}

function geometryFailure(corners: DocumentCorners): QuadFailure | null {
  if (!corners.every(isFinitePoint)) return 'non-finite-point';
  if (
    corners.some((point, index) => corners.slice(0, index).some((other) => samePoint(point, other)))
  ) {
    return 'degenerate';
  }
  const [a, b, c, d] = corners;
  const turns = [
    turnDirection(a, b, c),
    turnDirection(b, c, d),
    turnDirection(c, d, a),
    turnDirection(d, a, b),
  ];
  if (turns.includes(0)) return 'degenerate';
  if (segmentsIntersect(a, b, c, d) || segmentsIntersect(b, c, d, a)) return 'self-intersection';
  if (!turns.every((turn) => turn === turns[0])) return 'non-convex';
  const area = quadArea(corners);
  return area > 0 && Number.isFinite(area) ? null : 'degenerate';
}

function hullSide(points: readonly Point[]): Point[] {
  const hull: Point[] = [];
  for (const point of points) {
    while (hull.length >= 2) {
      const previous = hull.at(-2);
      const last = hull.at(-1);
      if (previous === undefined || last === undefined || turnDirection(previous, last, point) > 0)
        break;
      hull.pop();
    }
    hull.push(point);
  }
  return hull;
}

/** Detector input is unordered; sum ties resolve by y then x, including diamond shapes. */
export function orderCorners(
  points: readonly [Point, Point, Point, Point],
): DocumentCorners | null {
  if (!points.every(isFinitePoint)) return null;
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (
    sorted.some((point, index) => {
      const previous = sorted[index - 1];
      return previous !== undefined && samePoint(point, previous);
    })
  )
    return null;
  const hull = [...hullSide(sorted).slice(0, -1), ...hullSide([...sorted].reverse()).slice(0, -1)];
  if (hull.length !== 4) return null;
  const anchor = [...hull].sort((a, b) => a.x + a.y - (b.x + b.y) || a.y - b.y || a.x - b.x)[0];
  if (anchor === undefined) return null;
  const start = hull.indexOf(anchor);
  const [a, b, c, d] = [...hull.slice(start), ...hull.slice(0, start)];
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  const corners: DocumentCorners = [a, b, c, d];
  return geometryFailure(corners) === null ? corners : null;
}

/** Validates supplied perimeter edges without silently reordering an invalid edit. */
export function validateQuad(
  corners: DocumentCorners,
  image: ImageDimensions,
  minimumArea: number,
): QuadValidation {
  if (!Number.isFinite(minimumArea) || minimumArea < 0) {
    throw new RangeError('Minimum quad area must be finite and nonnegative.');
  }
  if (!isValidImageDimensions(image)) return { valid: false, reason: 'invalid-dimensions' };
  if (!corners.every(isFinitePoint)) return { valid: false, reason: 'non-finite-point' };
  if (
    corners.some(
      (point) => point.x < 0 || point.y < 0 || point.x > image.width || point.y > image.height,
    )
  ) {
    return { valid: false, reason: 'out-of-bounds' };
  }
  const failure = geometryFailure(corners);
  if (failure !== null) return { valid: false, reason: failure };
  const area = quadArea(corners);
  return area < minimumArea ? { valid: false, reason: 'area-too-small' } : { valid: true, area };
}

/** Sampling size from opposite document edges; this does not infer physical paper dimensions. */
export function getOutputDimensions(corners: DocumentCorners): ImageDimensions {
  if (geometryFailure(corners) !== null)
    throw new RangeError('Output requires a nondegenerate convex quad.');
  const [a, b, c, d] = corners;
  const dimensions = {
    width: Math.ceil(Math.max(Math.hypot(b.x - a.x, b.y - a.y), Math.hypot(c.x - d.x, c.y - d.y))),
    height: Math.ceil(Math.max(Math.hypot(d.x - a.x, d.y - a.y), Math.hypot(c.x - b.x, c.y - b.y))),
  };
  if (!isValidImageDimensions(dimensions))
    throw new RangeError('Output dimensions exceed numeric precision.');
  return dimensions;
}
