import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as benchmarkScanner from '../../scripts/benchmark-scanner';
import type { DocumentCorners, ImageDimensions } from '../../src/domain/document';
import exampleManifest from '../fixtures/manifest.example.json';
import {
  aggregateBenchmarkResults,
  calculateCornerError,
  calculateOcrTextMetrics,
  calculatePolygonIoU,
  DOCUMENT_IOU_GATE_THRESHOLD,
  validateNetworkEvidence,
  scoreFixtures,
} from './metrics';
import * as benchmarkMetrics from './metrics';
import { parseFixtureManifest } from './schema';

const dimensions: ImageDimensions = { width: 100, height: 80 };
const rectangle: DocumentCorners = [
  { x: 10, y: 10 },
  { x: 90, y: 10 },
  { x: 90, y: 70 },
  { x: 10, y: 70 },
];

function fixture(overrides: Record<string, unknown> = {}) {
  const id = typeof overrides.id === 'string' ? overrides.id : 'synthetic-rect';
  return {
    id,
    image: {
      path: `synthetic/${id}.png`,
      sha256: 'a'.repeat(64),
      mimeType: 'image/png',
      dimensions,
      exifOrientationApplied: true,
    },
    label: { kind: 'document', geometryEligible: true, corners: rectangle },
    contentRiskTags: ['table'],
    provenance: {
      kind: 'synthetic',
      generator: 'seeded-canvas-fixture-v1',
      licenseSpdx: 'CC0-1.0',
      repoRedistributable: true,
      approvalRef: 'generated-fixture-v1',
    },
    privacy: { containsPersonalData: false, repoApproved: true },
    ...overrides,
  };
}

function manifest(fixtures: unknown[]) {
  return {
    schemaVersion: 1,
    dataset: {
      id: 'synthetic-test',
      revision: '1',
      createdAt: '2026-10-08T00:00:00.000Z',
      split: 'synthetic',
      coordinateSpace: 'original-image-pixels',
    },
    fixtures,
  };
}

async function runOcrCli(
  observations: unknown,
  options: {
    readonly hasReference?: boolean;
    readonly referenceText?: string;
    readonly referenceHash?: string;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'scanner-ocr-benchmark-'));
  const imageDirectory = join(directory, 'synthetic');
  const ocrDirectory = join(directory, 'ocr');
  const imagePath = join(imageDirectory, 'synthetic-rect.png');
  const referencePath = join(ocrDirectory, 'reference.txt');
  const manifestPath = join(directory, 'manifest.json');
  const resultsPath = join(directory, 'results.json');
  const outputPath = join(directory, 'output.json');
  const imageBytes = Buffer.from('synthetic image bytes');
  const referenceBytes = Buffer.from(options.referenceText ?? 'xin chào', 'utf8');
  await mkdir(imageDirectory);
  await mkdir(ocrDirectory);
  await writeFile(imagePath, imageBytes);
  await writeFile(referencePath, referenceBytes);
  const sample = fixture({
    image: {
      ...fixture().image,
      sha256: createHash('sha256').update(imageBytes).digest('hex'),
    },
    ...(options.hasReference === false
      ? {}
      : {
          ocrReference: {
            textPath: 'ocr/reference.txt',
            sha256:
              options.referenceHash ?? createHash('sha256').update(referenceBytes).digest('hex'),
            language: 'vi',
            source: 'synthetic',
          },
        }),
  });
  await writeFile(manifestPath, JSON.stringify(manifest([sample])));
  await writeFile(
    resultsPath,
    JSON.stringify({
      candidate: { name: 'candidate', version: '1', sourceRevision: 'rev', licenseSpdx: 'MIT' },
      environment: { browser: 'test', os: 'test', device: 'test', runIndex: 1 },
      network: { policy: 'deny-external', externalRequests: 0 },
      detections: [
        {
          fixtureId: 'synthetic-rect',
          prediction: { kind: 'document', corners: rectangle },
          timingMs: { detect: 1 },
          memory: { status: 'unavailable', method: 'unsupported', reason: 'not-reported' },
        },
      ],
      ...(observations === undefined ? {} : { ocrObservations: observations }),
    }),
  );
  try {
    await benchmarkScanner.runBenchmarkCli([
      '--manifest',
      manifestPath,
      '--results',
      resultsPath,
      '--output',
      outputPath,
    ]);
    return JSON.parse(
      await (await import('node:fs/promises')).readFile(outputPath, 'utf8'),
    ) as unknown;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runLargeMeasurementCli(samples: readonly number[]) {
  const directory = await mkdtemp(join(tmpdir(), 'scanner-large-measurement-'));
  const imageDirectory = join(directory, 'synthetic');
  const manifestPath = join(directory, 'manifest.json');
  const resultsPath = join(directory, 'results.json');
  const outputPath = join(directory, 'output.json');
  await mkdir(imageDirectory);
  const fixtures = await Promise.all(
    samples.map(async (_, index) => {
      const id = `synthetic-${index}`;
      const imagePath = join(imageDirectory, `${id}.png`);
      const imageBytes = Buffer.from(`synthetic image ${index}`);
      await writeFile(imagePath, imageBytes);
      return fixture({
        id,
        image: {
          ...fixture({ id }).image,
          sha256: createHash('sha256').update(imageBytes).digest('hex'),
        },
      });
    }),
  );
  await writeFile(manifestPath, JSON.stringify(manifest(fixtures)));
  await writeFile(
    resultsPath,
    JSON.stringify({
      candidate: { name: 'candidate', version: '1', sourceRevision: 'rev', licenseSpdx: 'MIT' },
      environment: { browser: 'test', os: 'test', device: 'test', runIndex: 1 },
      network: { policy: 'deny-external', externalRequests: 0 },
      detections: samples.map((sample, index) => ({
        fixtureId: `synthetic-${index}`,
        prediction: { kind: 'document', corners: rectangle },
        timingMs: { detect: sample },
        memory: {
          status: 'measured',
          method: 'synthetic-counter',
          baselineBytes: 0,
          peakBytes: sample,
        },
      })),
    }),
  );
  try {
    await benchmarkScanner.runBenchmarkCli([
      '--manifest',
      manifestPath,
      '--results',
      resultsPath,
      '--output',
      outputPath,
    ]);
    return JSON.parse(
      await (await import('node:fs/promises')).readFile(outputPath, 'utf8'),
    ) as unknown;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('fixture manifest validation', () => {
  it('accepts the synthetic-only example manifest without bundling user imagery', () => {
    expect(parseFixtureManifest(exampleManifest).fixtures[0]?.provenance.kind).toBe('synthetic');
  });

  it('accepts a complete synthetic fixture with local path, provenance, privacy and corners', () => {
    expect(parseFixtureManifest(manifest([fixture()]))).toMatchObject({ schemaVersion: 1 });
  });

  it.each([
    ['absolute paths', 'C:/private/photo.png'],
    ['URLs', 'https://example.test/photo.png'],
    ['traversal paths', '../private/photo.png'],
    ['backslash traversal paths', '..\\private\\photo.png'],
  ])('rejects %s', (_description, path) => {
    expect(() =>
      parseFixtureManifest(manifest([fixture({ image: { ...fixture().image, path } })])),
    ).toThrow();
  });

  it('rejects duplicate fixture ids, malformed hashes and dimensions', () => {
    expect(() => parseFixtureManifest(manifest([fixture(), fixture()]))).toThrow();
    expect(() =>
      parseFixtureManifest(manifest([fixture({ image: { ...fixture().image, sha256: 'xyz' } })])),
    ).toThrow();
    expect(() =>
      parseFixtureManifest(
        manifest([
          fixture({ image: { ...fixture().image, dimensions: { width: 0, height: 80 } } }),
        ]),
      ),
    ).toThrow();
  });

  it('rejects manifests above the fixture-count limit before parsing every entry', () => {
    const fixtures = Array.from({ length: 2501 }, (_, index) =>
      fixture({ id: `synthetic-${index}` }),
    );
    expect(() => parseFixtureManifest(manifest(fixtures))).toThrow(/fixture count.*limit/i);
  });

  it('requires no-document labels to omit corners and document labels to have valid corners', () => {
    expect(() =>
      parseFixtureManifest(
        manifest([
          fixture({ label: { kind: 'no-document', geometryEligible: false, corners: rectangle } }),
        ]),
      ),
    ).toThrow();
    expect(() =>
      parseFixtureManifest(
        manifest([
          fixture({
            label: {
              kind: 'document',
              geometryEligible: true,
              corners: [rectangle[0], rectangle[2], rectangle[1], rectangle[3]],
            },
          }),
        ]),
      ),
    ).toThrow();
  });

  it('requires approved, non-personal provenance and rejects unknown tags', () => {
    expect(() =>
      parseFixtureManifest(
        manifest([fixture({ privacy: { containsPersonalData: true, repoApproved: true } })]),
      ),
    ).toThrow();
    expect(() =>
      parseFixtureManifest(
        manifest([fixture({ provenance: { kind: 'unknown', licenseSpdx: 'NOASSERTION' } })]),
      ),
    ).toThrow();
    expect(() =>
      parseFixtureManifest(manifest([fixture({ contentRiskTags: ['medical-id'] })])),
    ).toThrow();
  });
});

describe('polygon and corner metrics', () => {
  it('computes polygon IoU and accepts a cyclic corner shift', () => {
    const cyclic: DocumentCorners = [rectangle[2], rectangle[3], rectangle[0], rectangle[1]];
    expect(calculatePolygonIoU(rectangle, cyclic, dimensions)).toBe(1);
  });

  it('computes a known overlap using polygon intersection, not enclosing rectangles', () => {
    const shifted: DocumentCorners = [
      { x: 20, y: 10 },
      { x: 100, y: 10 },
      { x: 100, y: 70 },
      { x: 20, y: 70 },
    ];
    expect(calculatePolygonIoU(rectangle, shifted, dimensions)).toBeCloseTo(7 / 9, 10);
  });

  it('uses quad interiors rather than the overlap of their enclosing rectangles', () => {
    const diamond: DocumentCorners = [
      { x: 50, y: 10 },
      { x: 90, y: 50 },
      { x: 50, y: 90 },
      { x: 10, y: 50 },
    ];
    const innerSquare: DocumentCorners = [
      { x: 40, y: 40 },
      { x: 60, y: 40 },
      { x: 60, y: 60 },
      { x: 40, y: 60 },
    ];
    expect(calculatePolygonIoU(diamond, innerSquare, { width: 100, height: 100 })).toBeCloseTo(
      0.125,
      10,
    );
  });

  it('does not merge disjoint tiny quads through a fixed clipping epsilon', () => {
    const tinyA: DocumentCorners = [
      { x: 0, y: 0 },
      { x: 1e-6, y: 0 },
      { x: 1e-6, y: 1e-6 },
      { x: 0, y: 1e-6 },
    ];
    const tinyB: DocumentCorners = [
      { x: 3e-6, y: 0 },
      { x: 4e-6, y: 0 },
      { x: 4e-6, y: 1e-6 },
      { x: 3e-6, y: 1e-6 },
    ];
    expect(calculatePolygonIoU(tinyA, tinyB, { width: 1, height: 1 })).toBe(0);
  });

  it('keeps polygon area and IoU stable after a large coordinate translation', () => {
    const square = (x: number): DocumentCorners => [
      { x, y: 1e12 },
      { x: x + 4, y: 1e12 },
      { x: x + 4, y: 1e12 + 4 },
      { x, y: 1e12 + 4 },
    ];
    const bounds = { width: 1_000_000_000_100, height: 1_000_000_000_100 };
    expect(calculatePolygonIoU(square(1e12), square(1e12), bounds)).toBeCloseTo(1, 12);
    expect(calculatePolygonIoU(square(1e12), square(1e12 + 2), bounds)).toBeCloseTo(1 / 3, 12);
    expect(calculatePolygonIoU(square(1e12), square(1e12 + 8), bounds)).toBe(0);
  });

  it('rejects mirrored or self-crossing corner order rather than repairing it', () => {
    const mirrored: DocumentCorners = [rectangle[0], rectangle[3], rectangle[2], rectangle[1]];
    const crossing: DocumentCorners = [rectangle[0], rectangle[2], rectangle[1], rectangle[3]];
    expect(() => calculatePolygonIoU(rectangle, mirrored, dimensions)).toThrow();
    expect(() => calculatePolygonIoU(rectangle, crossing, dimensions)).toThrow();
  });

  it('reports average corner distance after cyclic alignment', () => {
    const shifted: DocumentCorners = [
      { x: 12, y: 10 },
      { x: 92, y: 10 },
      { x: 92, y: 70 },
      { x: 12, y: 70 },
    ];
    expect(calculateCornerError(rectangle, shifted, dimensions)).toEqual({
      meanPixels: 2,
      normalizedByDiagonal: 2 / Math.hypot(100, 80),
    });
  });

  it('rejects non-finite, out-of-bounds and degenerate detections', () => {
    expect(() =>
      calculatePolygonIoU(
        rectangle,
        [
          { x: 0, y: 0 },
          { x: 100, y: 80 },
          { x: 100, y: 0 },
          { x: 0, y: 80 },
        ],
        dimensions,
      ),
    ).toThrow();
    expect(() =>
      calculatePolygonIoU(
        rectangle,
        [
          { x: -1, y: 1 },
          { x: 90, y: 1 },
          { x: 90, y: 70 },
          { x: -1, y: 70 },
        ],
        dimensions,
      ),
    ).toThrow();
  });
});

describe('benchmark scoring and aggregation', () => {
  it('derives gate classifications from manifest and predictions, not mutable score fields', () => {
    const parsed = parseFixtureManifest(
      manifest([
        fixture({ id: 'document' }),
        fixture({
          id: 'negative',
          label: { kind: 'no-document', geometryEligible: false },
          contentRiskTags: [],
        }),
      ]),
    );
    const predictions = [
      {
        fixtureId: 'document',
        prediction: { kind: 'no-document' as const },
        labelKind: 'no-document',
        geometryEligible: false,
        missedDocument: false,
        falseCrop: false,
        iou: 1,
      },
      {
        fixtureId: 'negative',
        prediction: { kind: 'document' as const, corners: rectangle },
        labelKind: 'document',
        geometryEligible: true,
        missedDocument: false,
        falseCrop: false,
        iou: 1,
      },
    ];
    const result = aggregateBenchmarkResults(parsed, predictions);
    expect(result.counts).toMatchObject({
      documents: 1,
      noDocuments: 1,
      geometryEligible: 1,
      falseCrops: 1,
      misses: 1,
    });
    expect(result.geometryGate.passRate).toEqual({
      value: 0,
      numerator: 0,
      denominator: 1,
      reason: null,
    });
    expect(result.noDocumentGate.falseCropRate).toEqual({
      value: 1,
      numerator: 1,
      denominator: 1,
      reason: null,
    });
  });

  it('rejects non-null IoU values unless they are finite and within the unit interval', () => {
    const validate = Reflect.get(benchmarkMetrics, 'assertValidBenchmarkIoU') as
      ((value: number | null) => void) | undefined;
    expect(validate).toBeTypeOf('function');
    for (const invalid of [
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      -0.01,
      1.01,
    ]) {
      expect(() => validate?.(invalid)).toThrow(/IoU/i);
    }
    expect(() => validate?.(null)).not.toThrow();
    expect(() => validate?.(0)).not.toThrow();
    expect(() => validate?.(1)).not.toThrow();
  });

  it('gates every eligible document and every no-document fixture, including misses and errors', () => {
    const parsed = parseFixtureManifest(
      manifest([
        fixture({ id: 'detected' }),
        fixture({ id: 'missed' }),
        fixture({ id: 'error' }),
        fixture({ id: 'full-frame' }),
        fixture({
          id: 'false-crop',
          label: { kind: 'no-document', geometryEligible: false },
          contentRiskTags: [],
        }),
        fixture({
          id: 'correct-negative',
          label: { kind: 'no-document', geometryEligible: false },
          contentRiskTags: [],
        }),
      ]),
    );
    const detections = [
      { fixtureId: 'detected', prediction: { kind: 'document', corners: rectangle } },
      { fixtureId: 'missed', prediction: { kind: 'no-document' } },
      { fixtureId: 'error', prediction: { kind: 'error', code: 'engine-failure' } },
      {
        fixtureId: 'full-frame',
        prediction: {
          kind: 'document',
          corners: [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 80 },
            { x: 0, y: 80 },
          ],
        },
      },
      { fixtureId: 'false-crop', prediction: { kind: 'document', corners: rectangle } },
      { fixtureId: 'correct-negative', prediction: { kind: 'no-document' } },
    ] as const;
    const result = aggregateBenchmarkResults(parsed, detections);
    expect(result.geometryGate).toEqual({
      threshold: DOCUMENT_IOU_GATE_THRESHOLD,
      eligibleDocuments: 4,
      passedDocuments: 1,
      passRate: { value: 0.25, numerator: 1, denominator: 4, reason: null },
      failures: [
        { fixtureId: 'missed', reason: 'missed-detection', iou: null },
        { fixtureId: 'error', reason: 'engine-error', iou: null },
        { fixtureId: 'full-frame', reason: 'below-iou-threshold', iou: 0.6 },
      ],
    });
    expect(result.noDocumentGate).toEqual({
      fixtures: 2,
      falseCrops: 1,
      falseCropRate: { value: 0.5, numerator: 1, denominator: 2, reason: null },
    });
    expect(result.geometryGate.threshold).toBe(0.9);
  });

  it('validates every document prediction, including false crops and geometry-excluded fixtures', () => {
    const invalidQuads: DocumentCorners[] = [
      [rectangle[0], rectangle[0], rectangle[2], rectangle[3]],
      [rectangle[0], rectangle[2], rectangle[1], rectangle[3]],
    ];
    const parsed = parseFixtureManifest(
      manifest([
        fixture({ id: 'no-doc', label: { kind: 'no-document', geometryEligible: false } }),
        fixture({
          id: 'excluded',
          label: {
            kind: 'document',
            geometryEligible: false,
            exclusionReason: 'partially-out-of-frame',
          },
        }),
      ]),
    );
    for (const fixtureId of ['no-doc', 'excluded']) {
      for (const corners of invalidQuads) {
        expect(() =>
          scoreFixtures(parsed, [
            { fixtureId, prediction: { kind: 'document', corners } },
            {
              fixtureId: fixtureId === 'no-doc' ? 'excluded' : 'no-doc',
              prediction: { kind: 'no-document' },
            },
          ]),
        ).toThrow();
      }
    }
  });

  it('counts false crops, missed documents and reports null plus reason for empty denominators', () => {
    const input = manifest([
      fixture(),
      fixture({
        id: 'negative',
        label: { kind: 'no-document', geometryEligible: false },
        contentRiskTags: [],
      }),
      fixture({
        id: 'missed',
        label: {
          kind: 'document',
          geometryEligible: false,
          exclusionReason: 'partially-out-of-frame',
        },
        contentRiskTags: [],
      }),
    ]);
    const parsed = parseFixtureManifest(input);
    const detections = [
      { fixtureId: 'synthetic-rect', prediction: { kind: 'document', corners: rectangle } },
      { fixtureId: 'negative', prediction: { kind: 'document', corners: rectangle } },
      { fixtureId: 'missed', prediction: { kind: 'no-document' } },
    ] as const;
    const result = aggregateBenchmarkResults(parsed, detections);
    expect(result.counts).toMatchObject({
      documents: 2,
      noDocuments: 1,
      geometryEligible: 1,
      falseCrops: 1,
      misses: 1,
    });
    expect(result.metrics.falseCropRate).toEqual({
      value: 1,
      numerator: 1,
      denominator: 1,
      reason: null,
    });
    expect(result.metrics.missedDetectionRate).toEqual({
      value: 0.5,
      numerator: 1,
      denominator: 2,
      reason: null,
    });
    expect(result.metrics.meanIoU).toEqual({
      value: 1,
      numerator: 1,
      denominator: 1,
      reason: null,
    });
    expect(result).not.toHaveProperty('networkPolicy');
    expect(result).not.toHaveProperty('externalRequests');
    expect(result.byContentRiskTag.table).toMatchObject({
      fixtures: 1,
      falseCrops: 0,
      misses: 0,
      geometryEligible: 1,
      meanIoU: { value: 1, numerator: 1, denominator: 1, reason: null },
    });
  });

  it('uses null and an explicit reason when a metric has no denominator', () => {
    const parsed = parseFixtureManifest(
      manifest([
        fixture({
          label: {
            kind: 'document',
            geometryEligible: false,
            exclusionReason: 'ambiguous-boundary',
          },
        }),
      ]),
    );
    const detections = [
      { fixtureId: 'synthetic-rect', prediction: { kind: 'no-document' } },
    ] as const;
    const result = aggregateBenchmarkResults(parsed, detections);
    expect(result.metrics.falseCropRate).toEqual({
      value: null,
      numerator: 0,
      denominator: 0,
      reason: 'dataset-has-no-no-document-fixtures',
    });
    expect(result.metrics.meanIoU).toEqual({
      value: null,
      numerator: 0,
      denominator: 0,
      reason: 'no-document-and-valid-detection-pairs',
    });
  });

  it('fails closed when the declared network policy or external request count is unsafe', () => {
    expect(validateNetworkEvidence('deny-external', 0)).toEqual({
      policy: 'deny-external',
      externalRequests: 0,
    });
    expect(() => validateNetworkEvidence('allow', 0)).toThrow();
    expect(() => validateNetworkEvidence('deny-external', 1)).toThrow();
  });

  it('returns deterministic aggregates without a clock or runtime-specific values', () => {
    const parsed = parseFixtureManifest(manifest([fixture()]));
    const detections = [
      { fixtureId: 'synthetic-rect', prediction: { kind: 'document', corners: rectangle } },
    ] as const;
    expect(aggregateBenchmarkResults(parsed, detections)).toEqual(
      aggregateBenchmarkResults(parsed, detections),
    );
  });

  it('rejects per-fixture results with duplicate or unknown ids', () => {
    const parsed = parseFixtureManifest(manifest([fixture(), fixture({ id: 'other' })]));
    const detections = [
      { fixtureId: 'synthetic-rect', prediction: { kind: 'document', corners: rectangle } },
      { fixtureId: 'other', prediction: { kind: 'document', corners: rectangle } },
    ] as const;
    expect(() => aggregateBenchmarkResults(parsed, [detections[0]!, detections[0]!])).toThrow(
      /duplicate prediction/i,
    );
    expect(() =>
      aggregateBenchmarkResults(parsed, [
        { ...detections[0]!, fixtureId: 'unknown' },
        detections[1]!,
      ]),
    ).toThrow(/unknown fixture id/i);
  });
});

describe('benchmark CLI resource limits and measurement summaries', () => {
  it('rejects an oversized JSON input before parsing it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scanner-benchmark-'));
    const manifestPath = join(directory, 'manifest.json');
    const resultsPath = join(directory, 'results.json');
    try {
      await writeFile(manifestPath, ' '.repeat(5 * 1024 * 1024));
      await writeFile(resultsPath, '{}');
      await expect(
        benchmarkScanner.runBenchmarkCli(['--manifest', manifestPath, '--results', resultsPath]),
      ).rejects.toThrow(/manifest.*byte limit/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a directory where a regular JSON file is required', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scanner-benchmark-'));
    const resultsPath = join(directory, 'results.json');
    try {
      await writeFile(resultsPath, '{}');
      await expect(
        benchmarkScanner.runBenchmarkCli(['--manifest', directory, '--results', resultsPath]),
      ).rejects.toThrow(/manifest.*regular file/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects an oversized results JSON before parsing it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scanner-benchmark-'));
    const fixtureDirectory = join(directory, 'synthetic');
    const fixturePath = join(fixtureDirectory, 'synthetic-rect.png');
    const manifestPath = join(directory, 'manifest.json');
    const resultsPath = join(directory, 'results.json');
    const fixtureBytes = Buffer.from('synthetic placeholder bytes');
    try {
      await mkdir(fixtureDirectory);
      await writeFile(fixturePath, fixtureBytes);
      const fixtureManifest = manifest([
        fixture({
          image: {
            ...fixture().image,
            sha256: createHash('sha256').update(fixtureBytes).digest('hex'),
          },
        }),
      ]);
      await writeFile(manifestPath, JSON.stringify(fixtureManifest));
      await writeFile(resultsPath, ' '.repeat(8 * 1024 * 1024 + 1));
      await expect(
        benchmarkScanner.runBenchmarkCli(['--manifest', manifestPath, '--results', resultsPath]),
      ).rejects.toThrow(/results.*byte limit/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('requires fixture images to be nonempty regular files before hashing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scanner-benchmark-'));
    const fixtureDirectory = join(directory, 'synthetic');
    const fixturePath = join(fixtureDirectory, 'synthetic-rect.png');
    const manifestPath = join(directory, 'manifest.json');
    const resultsPath = join(directory, 'results.json');
    try {
      await mkdir(fixtureDirectory);
      await writeFile(fixturePath, '');
      await writeFile(manifestPath, JSON.stringify(manifest([fixture()])));
      await writeFile(resultsPath, '{}');
      await expect(
        benchmarkScanner.runBenchmarkCli(['--manifest', manifestPath, '--results', resultsPath]),
      ).rejects.toThrow(/fixture is empty/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('explains why an empty measurement distribution has no value', () => {
    const summarize = Reflect.get(benchmarkScanner, 'summarizeDistribution') as
      ((samples: readonly number[], reason: string) => unknown) | undefined;
    expect(summarize).toBeTypeOf('function');
    expect(summarize?.([], 'initialization-not-reported')).toEqual({
      samples: 0,
      median: null,
      p75: null,
      p95: null,
      medianAbsoluteDeviation: null,
      emptyReason: 'initialization-not-reported',
    });
  });

  it('uses the average of the middle pair for even-sample median and MAD', () => {
    const summarize = Reflect.get(benchmarkScanner, 'summarizeDistribution') as
      | ((
          samples: readonly number[],
          reason: string,
        ) => { median: number; medianAbsoluteDeviation: number })
      | undefined;
    expect(summarize?.([1, 9], 'unused')).toMatchObject({ median: 5, medianAbsoluteDeviation: 4 });
  });

  it('keeps large finite timing and memory medians finite in the JSON result', async () => {
    const report = (await runLargeMeasurementCli([1e308, 1e308])) as {
      measurements: {
        timingMs: { detection: { median: number | null; medianAbsoluteDeviation: number | null } };
        memory: { medianPeakBytes: number | null; maxPeakBytes: number | null };
      };
    };
    expect(report.measurements.timingMs.detection).toMatchObject({
      median: 1e308,
      medianAbsoluteDeviation: 0,
    });
    expect(report.measurements.memory).toMatchObject({
      medianPeakBytes: 1e308,
      maxPeakBytes: 1e308,
    });
  });

  it('computes deviations using the same overflow-safe midpoint for extreme pairs', () => {
    const summarize = Reflect.get(benchmarkScanner, 'summarizeDistribution') as
      | ((
          samples: readonly number[],
          reason: string,
        ) => { median: number | null; medianAbsoluteDeviation: number | null })
      | undefined;
    expect(summarize?.([0, 1e308], 'unused')).toMatchObject({
      median: 5e307,
      medianAbsoluteDeviation: 5e307,
    });
  });
});

describe('test-only OCR error metrics', () => {
  it('normalizes Unicode to NFC and collapses Unicode whitespace before scoring', () => {
    expect(calculateOcrTextMetrics('  Tiếng\tVie\u0302̣t\u00a0đẹp  ', 'Tiếng Việt đẹp')).toEqual({
      normalizationVersion: 'unicode-nfc-whitespace-v1',
      cer: { value: 0, numerator: 0, denominator: 14, reason: null },
      wer: { value: 0, numerator: 0, denominator: 3, reason: null },
    });
  });

  it('reports character and word substitutions, insertions and deletions as edit ratios', () => {
    expect(calculateOcrTextMetrics('kitten', 'sitting').cer).toEqual({
      value: 0.5,
      numerator: 3,
      denominator: 6,
      reason: null,
    });
    expect(calculateOcrTextMetrics('one two three', 'one four').wer).toEqual({
      value: 2 / 3,
      numerator: 2,
      denominator: 3,
      reason: null,
    });
  });

  it('uses an explicit empty-reference reason instead of NaN', () => {
    const score = calculateOcrTextMetrics('', 'recognized words');
    expect(score.cer).toEqual({
      value: null,
      numerator: 16,
      denominator: 0,
      reason: 'empty-reference',
    });
    expect(score.wer.value).toBeNull();
    expect(Number.isNaN(score.cer.value)).toBe(false);
  });

  it('scores only supplied observations, counts missing fixtures, and rejects invalid observation keys', async () => {
    const result = (await runOcrCli([{ fixtureId: 'synthetic-rect', text: 'xin chào' }])) as {
      ocr: { observationsProvided: number; missingObservations: number; cer: { value: number } };
    };
    expect(result.ocr).toMatchObject({
      observationsProvided: 1,
      missingObservations: 0,
      cer: { value: 0 },
    });
    await expect(runOcrCli([])).resolves.toMatchObject({
      ocr: {
        observationsProvided: 0,
        missingObservations: 1,
        cer: { value: null, reason: 'no-ocr-observations' },
      },
    });
    await expect(
      runOcrCli([
        { fixtureId: 'synthetic-rect', text: 'one' },
        { fixtureId: 'synthetic-rect', text: 'two' },
      ]),
    ).rejects.toThrow(/duplicated/i);
    await expect(runOcrCli([{ fixtureId: 'unknown', text: 'one' }])).rejects.toThrow(
      /not in manifest/i,
    );
    await expect(
      runOcrCli([{ fixtureId: 'synthetic-rect', text: 'one' }], { hasReference: false }),
    ).rejects.toThrow(/no OCR reference/i);
    await expect(
      runOcrCli([{ fixtureId: 'synthetic-rect', text: 'one' }], { referenceHash: '0'.repeat(64) }),
    ).rejects.toThrow(/OCR reference SHA-256 mismatch/i);
    await expect(
      runOcrCli([{ fixtureId: 'synthetic-rect', text: 'x'.repeat(4097) }]),
    ).rejects.toThrow(/code-point limit/i);
  });
});
