import { describe, expect, it } from 'vitest';

import type { ImageDimensions, Point } from '../../domain/document';
import { selectOpenCvDocumentCandidate } from './opencv-classical-candidate';

const dimensions: ImageDimensions = { width: 640, height: 480 };

function candidate(points: readonly [Point, Point, Point, Point], edgeSupport = 0.9) {
  return { points, edgeSupport };
}

describe('selectOpenCvDocumentCandidate', () => {
  it('orders a strong document candidate and assigns bounded confidence', () => {
    const result = selectOpenCvDocumentCandidate(dimensions, [
      candidate([
        { x: 500, y: 420 },
        { x: 120, y: 50 },
        { x: 75, y: 360 },
        { x: 560, y: 110 },
      ]),
    ]);

    expect(result).not.toBeNull();
    expect(result?.corners).toEqual([
      { x: 120, y: 50 },
      { x: 560, y: 110 },
      { x: 500, y: 420 },
      { x: 75, y: 360 },
    ]);
    expect(result?.confidence).toBeGreaterThanOrEqual(0);
    expect(result?.confidence).toBeLessThanOrEqual(1);
  });

  it('rejects tiny, almost-full-frame, weak-edge, and degenerate contours', () => {
    const result = selectOpenCvDocumentCandidate(dimensions, [
      candidate(
        [
          { x: 10, y: 10 },
          { x: 40, y: 10 },
          { x: 40, y: 40 },
          { x: 10, y: 40 },
        ],
        1,
      ),
      candidate(
        [
          { x: 1, y: 1 },
          { x: 639, y: 1 },
          { x: 639, y: 479 },
          { x: 1, y: 479 },
        ],
        1,
      ),
      candidate(
        [
          { x: 100, y: 80 },
          { x: 540, y: 80 },
          { x: 540, y: 400 },
          { x: 100, y: 400 },
        ],
        0.05,
      ),
      candidate(
        [
          { x: 100, y: 100 },
          { x: 300, y: 100 },
          { x: 500, y: 100 },
          { x: 200, y: 100 },
        ],
        1,
      ),
    ]);

    expect(result).toBeNull();
  });

  it('prefers supported page geometry over a larger weak room boundary', () => {
    const document = candidate(
      [
        { x: 120, y: 50 },
        { x: 560, y: 110 },
        { x: 500, y: 420 },
        { x: 75, y: 360 },
      ],
      0.92,
    );
    const roomBoundary = candidate(
      [
        { x: 20, y: 70 },
        { x: 620, y: 80 },
        { x: 570, y: 450 },
        { x: 40, y: 420 },
      ],
      0.24,
    );

    expect(selectOpenCvDocumentCandidate(dimensions, [roomBoundary, document])?.corners).toEqual(
      selectOpenCvDocumentCandidate(dimensions, [document])?.corners,
    );
  });

  it('ignores malformed support values instead of producing NaN confidence', () => {
    const result = selectOpenCvDocumentCandidate(dimensions, [
      candidate(
        [
          { x: 100, y: 80 },
          { x: 540, y: 80 },
          { x: 540, y: 400 },
          { x: 100, y: 400 },
        ],
        Number.NaN,
      ),
    ]);

    expect(result).toBeNull();
  });
});
