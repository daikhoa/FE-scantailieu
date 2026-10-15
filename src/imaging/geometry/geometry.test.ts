import { describe, expect, it } from 'vitest';

import type { DocumentCorners, ImageDimensions, Point, QuarterTurn } from '../../domain/document';
import {
  rotateCorners,
  rotateDimensions,
  rotatePoint,
  scaleCorners,
  scalePoint,
} from './coordinates';
import { getOutputDimensions, orderCorners, validateQuad } from './quad';

const image: ImageDimensions = { width: 100, height: 80 };
const rectangle: DocumentCorners = [
  { x: 10, y: 10 },
  { x: 90, y: 10 },
  { x: 90, y: 70 },
  { x: 10, y: 70 },
];
const rotations: readonly QuarterTurn[] = [0, 90, 180, 270];

function expectMappingError(actual: Point, expected: Point) {
  expect(Math.hypot(actual.x - expected.x, actual.y - expected.y)).toBeLessThanOrEqual(1);
}

describe('geometry corner ordering', () => {
  it('orders all 24 rectangle permutations identically', () => {
    let permutations = 0;
    for (const a of rectangle) {
      for (const b of rectangle) {
        for (const c of rectangle) {
          for (const d of rectangle) {
            if (new Set([a, b, c, d]).size !== 4) continue;
            expect(orderCorners([a, b, c, d])).toEqual(rectangle);
            permutations += 1;
          }
        }
      }
    }
    expect(permutations).toBe(24);
  });

  it('orders a skewed quad clockwise from the minimum-sum anchor', () => {
    const corners: DocumentCorners = [
      { x: 20, y: 5 },
      { x: 95, y: 20 },
      { x: 75, y: 75 },
      { x: 5, y: 55 },
    ];
    expect(orderCorners([corners[2], corners[0], corners[3], corners[1]])).toEqual(corners);
  });

  it('breaks diamond anchor ties by y without duplicating a corner', () => {
    const diamond: DocumentCorners = [
      { x: 50, y: 0 },
      { x: 100, y: 40 },
      { x: 50, y: 80 },
      { x: 0, y: 40 },
    ];
    // Use equal x+y at the top and left vertices.
    const tied: DocumentCorners = [
      { x: 40, y: 0 },
      { x: 80, y: 40 },
      { x: 40, y: 80 },
      { x: 0, y: 40 },
    ];
    expect(orderCorners([diamond[3], diamond[1], diamond[0], diamond[2]])).toEqual([
      diamond[3],
      diamond[0],
      diamond[1],
      diamond[2],
    ]);
    expect(orderCorners([tied[3], tied[2], tied[1], tied[0]])).toEqual(tied);
  });

  it.each([
    [
      'duplicate',
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 10, y: 10 },
      ],
    ],
    [
      'collinear',
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 20, y: 0 },
        { x: 30, y: 0 },
      ],
    ],
    [
      'three collinear',
      [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 10, y: 0 },
        { x: 0, y: 10 },
      ],
    ],
    [
      'interior',
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 8, y: 2 },
      ],
    ],
  ] as const)('rejects a %s point set', (_name, corners) => {
    expect(orderCorners(corners)).toBeNull();
  });

  it.each([NaN, Infinity, -Infinity])('rejects the non-finite coordinate %s', (x) => {
    expect(orderCorners([{ x, y: 10 }, rectangle[1], rectangle[2], rectangle[3]])).toBeNull();
  });
});

describe('geometry quad validation', () => {
  it('accepts either winding and reports area in square pixels', () => {
    expect(validateQuad(rectangle, image, 4800)).toEqual({ valid: true, area: 4800 });
    expect(
      validateQuad([rectangle[0], rectangle[3], rectangle[2], rectangle[1]], image, 1),
    ).toEqual({
      valid: true,
      area: 4800,
    });
  });

  it('rejects a bow-tie instead of repairing its vertex order', () => {
    expect(
      validateQuad([rectangle[0], rectangle[2], rectangle[1], rectangle[3]], image, 1),
    ).toEqual({
      valid: false,
      reason: 'self-intersection',
    });
  });

  it('rejects a concave quad', () => {
    expect(
      validateQuad(
        [
          { x: 0, y: 0 },
          { x: 90, y: 0 },
          { x: 30, y: 20 },
          { x: 0, y: 70 },
        ],
        image,
        1,
      ),
    ).toEqual({ valid: false, reason: 'non-convex' });
  });

  it('rejects duplicate and collinear corners as degenerate', () => {
    expect(
      validateQuad([rectangle[0], rectangle[1], rectangle[1], rectangle[3]], image, 0),
    ).toEqual({
      valid: false,
      reason: 'degenerate',
    });
    expect(
      validateQuad(
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 20, y: 0 },
          { x: 0, y: 10 },
        ],
        image,
        0,
      ),
    ).toEqual({ valid: false, reason: 'degenerate' });
  });

  it('accepts inclusive image edges', () => {
    const fullFrame: DocumentCorners = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 80 },
      { x: 0, y: 80 },
    ];
    expect(validateQuad(fullFrame, image, 8000)).toEqual({ valid: true, area: 8000 });
    expect(getOutputDimensions(fullFrame)).toEqual(image);
  });

  it.each([
    { x: -0.01, y: 10 },
    { x: 100.01, y: 10 },
    { x: 10, y: -0.01 },
    { x: 10, y: 80.01 },
  ])('rejects a point outside the image: %j', (point) => {
    expect(validateQuad([point, rectangle[1], rectangle[2], rectangle[3]], image, 1)).toEqual({
      valid: false,
      reason: 'out-of-bounds',
    });
  });

  it('rejects area below the threshold and accepts equality', () => {
    expect(validateQuad(rectangle, image, 4800.01)).toEqual({
      valid: false,
      reason: 'area-too-small',
    });
    expect(validateQuad(rectangle, image, 4800)).toEqual({ valid: true, area: 4800 });
    expect(validateQuad(rectangle, image, 4799.99)).toEqual({ valid: true, area: 4800 });
  });

  it.each([NaN, Infinity, -Infinity])('reports non-finite coordinates: %s', (y) => {
    expect(
      validateQuad([{ x: 10, y }, rectangle[1], rectangle[2], rectangle[3]], image, 1),
    ).toEqual({
      valid: false,
      reason: 'non-finite-point',
    });
  });

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid dimensions: %s',
    (width) => {
      expect(validateQuad(rectangle, { width, height: 80 }, 1)).toEqual({
        valid: false,
        reason: 'invalid-dimensions',
      });
    },
  );

  it.each([-1, NaN, Infinity])('throws for invalid minimum area: %s', (minimumArea) => {
    expect(() => validateQuad(rectangle, image, minimumArea)).toThrow(RangeError);
  });
});

describe('geometry coordinate scaling', () => {
  it('maps exact image boundaries without a floating-point overshoot', () => {
    expect(scalePoint({ x: 7, y: 7 }, { width: 7, height: 7 }, { width: 29, height: 29 })).toEqual({
      x: 29,
      y: 29,
    });
  });

  it('preserves identity and maps anisotropic image-edge coordinates', () => {
    expect(scaleCorners(rectangle, image, image)).toEqual(rectangle);
    expect(scalePoint({ x: 25, y: 40 }, image, { width: 400, height: 160 })).toEqual({
      x: 100,
      y: 80,
    });
    expect(scalePoint({ x: 100, y: 80 }, image, { width: 400, height: 160 })).toEqual({
      x: 400,
      y: 160,
    });
  });

  it.each([
    [
      { width: 8000, height: 6000 },
      { width: 853, height: 640 },
    ],
    [
      { width: 64, height: 1_000_000 },
      { width: 1, height: 15_625 },
    ],
    [
      { width: 1_000_000, height: 64 },
      { width: 15_625, height: 1 },
    ],
  ])('round-trips fractional points within one pixel for %j', (original, preview) => {
    const points = [
      { x: 0, y: 0 },
      { x: original.width, y: original.height },
      { x: original.width * 0.123456789, y: original.height * 0.987654321 },
    ];
    for (const point of points) {
      expectMappingError(
        scalePoint(scalePoint(point, original, preview), preview, original),
        point,
      );
    }
  });

  it('preserves outside coordinates for subsequent validation', () => {
    expect(scalePoint({ x: -1, y: 81 }, image, { width: 200, height: 160 })).toEqual({
      x: -2,
      y: 162,
    });
  });

  it.each([0, -1, NaN, Infinity])('throws for invalid source or target dimensions: %s', (width) => {
    expect(() => scalePoint(rectangle[0], { width, height: 80 }, image)).toThrow(RangeError);
    expect(() => scalePoint(rectangle[0], image, { width, height: 80 })).toThrow(RangeError);
  });

  it('throws for non-finite input and overflowed output', () => {
    expect(() => scalePoint({ x: Infinity, y: 0 }, image, image)).toThrow(RangeError);
    expect(() =>
      scalePoint({ x: Number.MAX_VALUE, y: 0 }, image, { width: 1000, height: 80 }),
    ).toThrow(RangeError);
  });
});

describe('geometry clockwise rotation', () => {
  it.each([
    [0, { x: 10, y: 20 }, { width: 100, height: 80 }],
    [90, { x: 60, y: 10 }, { width: 80, height: 100 }],
    [180, { x: 90, y: 60 }, { width: 100, height: 80 }],
    [270, { x: 20, y: 90 }, { width: 80, height: 100 }],
  ] as const)('rotates a point and dimensions by %s degrees', (rotation, point, dimensions) => {
    expect(rotatePoint({ x: 10, y: 20 }, image, rotation)).toEqual(point);
    expect(rotateDimensions(image, rotation)).toEqual(dimensions);
  });

  it.each(rotations)('relabels full-frame corners after %s degrees', (rotation) => {
    const fullFrame: DocumentCorners = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 80 },
      { x: 0, y: 80 },
    ];
    const dimensions = rotateDimensions(image, rotation);
    expect(rotateCorners(fullFrame, image, rotation)).toEqual([
      { x: 0, y: 0 },
      { x: dimensions.width, y: 0 },
      { x: dimensions.width, y: dimensions.height },
      { x: 0, y: dimensions.height },
    ]);
  });

  it.each(rotations)('restores fractional corners with the inverse of %s degrees', (rotation) => {
    const corners: DocumentCorners = [
      { x: 20.25, y: 5.125 },
      { x: 95.5, y: 20.875 },
      { x: 75.125, y: 75.25 },
      { x: 5.75, y: 55.5 },
    ];
    const inverse = rotations.find((angle) => (angle + rotation) % 360 === 0);
    if (inverse === undefined) throw new Error('Missing inverse rotation');
    const restored = rotateCorners(
      rotateCorners(corners, image, rotation),
      rotateDimensions(image, rotation),
      inverse,
    );
    restored.forEach((point, index) => {
      const original = corners[index];
      if (original === undefined) throw new Error('Missing original corner');
      expectMappingError(point, original);
    });
  });

  it('composes four quarter turns without changing corner identities', () => {
    let corners = rectangle;
    let dimensions = image;
    for (let turn = 0; turn < 4; turn += 1) {
      corners = rotateCorners(corners, dimensions, 90);
      dimensions = rotateDimensions(dimensions, 90);
    }
    expect(corners).toEqual(rectangle);
    expect(dimensions).toEqual(image);
  });

  it('rejects invalid rotation and dimensions at runtime', () => {
    // Runtime boundaries may receive values that have not been schema-validated.
    // @ts-expect-error Invalid rotation deliberately exercises runtime validation.
    expect(() => rotatePoint(rectangle[0], image, 45)).toThrow(RangeError);
    expect(() => rotateDimensions({ width: 0, height: 80 }, 0)).toThrow(RangeError);
    expect(() => rotatePoint({ x: NaN, y: 0 }, image, 0)).toThrow(RangeError);
  });
});

describe('geometry output dimensions and numeric stability', () => {
  it.each([
    [
      'two-axis perspective',
      [
        { x: 454.51188840589055, y: 616.188712342546 },
        { x: 820.3308854530028, y: 696.7431982945684 },
        { x: 766.9729117295013, y: 1010.9554215298283 },
        { x: 447.7622384255749, y: 871.3453510008347 },
      ],
    ],
    [
      'one-axis perspective',
      [
        { x: 361.94494241422393, y: 679.7640389181026 },
        { x: 838.055057585776, y: 679.7640389181026 },
        { x: 787.8604353719704, y: 894.883848405841 },
        { x: 412.1395646280296, y: 894.883848405841 },
      ],
    ],
  ] as const)('recovers a 1.4 document ratio under %s', (_name, corners) => {
    const dimensions = getOutputDimensions(corners, { width: 1200, height: 1600 });

    expect(dimensions.width / dimensions.height).toBeCloseTo(1.4, 2);
  });

  it('keeps the recovered physical ratio when the source rotates', () => {
    const corners: DocumentCorners = [
      { x: 454.51188840589055, y: 616.188712342546 },
      { x: 820.3308854530028, y: 696.7431982945684 },
      { x: 766.9729117295013, y: 1010.9554215298283 },
      { x: 447.7622384255749, y: 871.3453510008347 },
    ];
    const source = { width: 1200, height: 1600 };

    const dimensions = getOutputDimensions(
      rotateCorners(corners, source, 90),
      rotateDimensions(source, 90),
    );

    expect(dimensions.height / dimensions.width).toBeCloseTo(1.4, 2);
  });

  it('keeps the focal-bound estimate stable across source rotation', () => {
    const source = { width: 1200, height: 1600 };
    const corners: DocumentCorners = [
      { x: 500.73640943268913, y: 766.6457768778296 },
      { x: 549.8976492729107, y: 674.6221773955273 },
      { x: 734.1023535746443, y: 845.0606289453515 },
      { x: 635.5454911156584, y: 888.9502431485373 },
    ];

    const original = getOutputDimensions(corners, source);
    const rotated = getOutputDimensions(
      rotateCorners(corners, source, 90),
      rotateDimensions(source, 90),
    );

    expect(rotated).toEqual({ width: original.height, height: original.width });
  });

  it('does not jump between focal inference and the camera prior under subpixel noise', () => {
    const source = { width: 1200, height: 1600 };
    const almostOneAxis: readonly [DocumentCorners, DocumentCorners] = [
      [
        { x: 520.701668852238, y: 725.9433393820376 },
        { x: 702.0097904766981, y: 704.7330991495138 },
        { x: 702.0098100705087, y: 895.2668962227923 },
        { x: 520.701690930074, y: 874.0566578215012 },
      ],
      [
        { x: 520.7016522938598, y: 725.9433372846993 },
        { x: 702.0097757813388, y: 704.7330956787531 },
        { x: 702.0098247658655, y: 895.266892752012 },
        { x: 520.70170748845, y: 874.0566557241475 },
      ],
    ];

    const [first, second] = almostOneAxis.map((quad) => getOutputDimensions(quad, source));
    if (first === undefined || second === undefined) throw new Error('Missing output dimensions');

    expect(Math.abs(first.width - second.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(first.height - second.height)).toBeLessThanOrEqual(1);
  });

  it('uses a rotation-stable camera prior when one-axis perspective cannot reveal focal length', () => {
    const source = { width: 1200, height: 1600 };
    const corners: DocumentCorners = [
      { x: 528.6315119020405, y: 733.3490067022401 },
      { x: 691.8088202462433, y: 714.259791317023 },
      { x: 691.8088202462433, y: 885.740208682977 },
      { x: 528.6315119020405, y: 866.6509932977599 },
    ];

    const original = getOutputDimensions(corners, source);
    const rotated = getOutputDimensions(
      rotateCorners(corners, source, 90),
      rotateDimensions(source, 90),
    );

    expect(original).toEqual({ width: 229, height: 124 });
    expect(rotated).toEqual({ width: original.height, height: original.width });
  });

  it('uses the longest opposite edges and rounds up fractional edge lengths', () => {
    const trapezoid: DocumentCorners = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 80, y: 60 },
      { x: 10, y: 60 },
    ];
    expect(getOutputDimensions(rectangle)).toEqual({ width: 80, height: 60 });
    expect(getOutputDimensions(trapezoid)).toEqual({ width: 100, height: 64 });
    expect(getOutputDimensions(rotateCorners(trapezoid, image, 90))).toEqual({
      width: 64,
      height: 100,
    });
  });

  it('rejects invalid output quads', () => {
    expect(() =>
      getOutputDimensions([rectangle[0], rectangle[2], rectangle[1], rectangle[3]]),
    ).toThrow(RangeError);
    expect(() =>
      getOutputDimensions([{ x: NaN, y: 0 }, rectangle[1], rectangle[2], rectangle[3]]),
    ).toThrow(RangeError);
  });

  it.each([
    [{ width: 8000, height: 6000 }, 8000, 6000],
    [{ width: 64, height: 1_000_000 }, 64, 1_000_000],
    [{ width: 1_000_000, height: 64 }, 1_000_000, 64],
    [{ width: 1, height: 1_000_000 }, 1, 1_000_000],
  ] as const)('preserves area and edge lengths for %j', (dimensions, width, height) => {
    const corners: DocumentCorners = [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ];
    expect(validateQuad(corners, dimensions, width * height)).toEqual({
      valid: true,
      area: width * height,
    });
    expect(getOutputDimensions(corners)).toEqual(dimensions);
    expect(orderCorners([corners[2], corners[0], corners[3], corners[1]])).toEqual(corners);
  });

  it('retains a small area at a large coordinate offset', () => {
    const corners: DocumentCorners = [
      { x: 999_999_990, y: 999_999_990 },
      { x: 1_000_000_000, y: 999_999_990 },
      { x: 1_000_000_000, y: 1_000_000_000 },
      { x: 999_999_990, y: 1_000_000_000 },
    ];
    expect(validateQuad(corners, { width: 1_000_000_000, height: 1_000_000_000 }, 100)).toEqual({
      valid: true,
      area: 100,
    });
  });

  it('rejects nearly collinear corners without a scale-based global area cutoff', () => {
    const corners: DocumentCorners = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 20, y: 20 + 1e-14 },
      { x: 0, y: 40 },
    ];
    expect(validateQuad(corners, image, 0)).toEqual({ valid: false, reason: 'degenerate' });
  });

  it('preserves generated convex rectangles under scale and rotation', () => {
    for (let sample = 1; sample <= 40; sample += 1) {
      const x = sample / 10;
      const y = sample / 20;
      const corners: DocumentCorners = [
        { x, y },
        { x: x + 50, y },
        { x: x + 50, y: y + 30 },
        { x, y: y + 30 },
      ];
      const scaled = scaleCorners(corners, image, { width: 400, height: 160 });
      const validation = validateQuad(scaled, { width: 400, height: 160 }, 0);
      expect(validation.valid).toBe(true);
      if (validation.valid) expect(validation.area).toBeCloseTo(1500 * 8, 6);
      for (const rotation of rotations) {
        expect(
          validateQuad(
            rotateCorners(corners, image, rotation),
            rotateDimensions(image, rotation),
            0,
          ).valid,
        ).toBe(true);
      }
    }
  });

  it('never mutates frozen inputs', () => {
    const corners: DocumentCorners = Object.freeze([
      Object.freeze({ x: 10, y: 10 }),
      Object.freeze({ x: 90, y: 10 }),
      Object.freeze({ x: 90, y: 70 }),
      Object.freeze({ x: 10, y: 70 }),
    ]);
    const dimensions = Object.freeze({ width: 100, height: 80 });
    orderCorners(corners);
    validateQuad(corners, dimensions, 1);
    getOutputDimensions(corners);
    scaleCorners(corners, dimensions, { width: 200, height: 160 });
    rotateCorners(corners, dimensions, 90);
    expect(corners).toEqual(rectangle);
    expect(dimensions).toEqual(image);
  });
});
