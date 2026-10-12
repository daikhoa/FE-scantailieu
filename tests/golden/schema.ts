import type { DocumentCorners, ImageDimensions } from '../../src/domain/document.ts';
import { assertValidBenchmarkQuad } from './metrics.ts';

export const CONTENT_RISK_TAGS = [
  'handwriting',
  'signature',
  'seal',
  'table',
  'small-text',
  'colored-mark',
  'illustration',
] as const;

export const MAX_FIXTURE_COUNT = 2500;

export type ContentRiskTag = (typeof CONTENT_RISK_TAGS)[number];

export type FixtureLabel =
  | { readonly kind: 'no-document'; readonly geometryEligible: false }
  | {
      readonly kind: 'document';
      readonly geometryEligible: true;
      readonly corners: DocumentCorners;
    }
  | {
      readonly kind: 'document';
      readonly geometryEligible: false;
      readonly exclusionReason: 'partially-out-of-frame' | 'ambiguous-boundary';
    };

export interface FixtureManifest {
  readonly schemaVersion: 1;
  readonly dataset: {
    readonly id: string;
    readonly revision: string;
    readonly createdAt: string;
    readonly split: 'synthetic' | 'development' | 'holdout';
    readonly coordinateSpace: 'original-image-pixels';
  };
  readonly fixtures: readonly Fixture[];
}

export interface Fixture {
  readonly id: string;
  readonly image: {
    readonly path: string;
    readonly sha256: string;
    readonly mimeType: 'image/png' | 'image/jpeg';
    readonly dimensions: ImageDimensions;
    readonly exifOrientationApplied: boolean;
  };
  readonly label: FixtureLabel;
  readonly contentRiskTags: readonly ContentRiskTag[];
  readonly provenance: {
    readonly kind: 'synthetic' | 'captured' | 'public-domain' | 'licensed';
    readonly licenseSpdx: string;
    readonly repoRedistributable: boolean;
    readonly sourceUri?: string;
    readonly sourceRevision?: string;
    readonly acquiredAt?: string;
    readonly attribution?: string;
    readonly licenseUrl?: string;
    readonly approvalRef?: string;
    readonly generator?: string;
  };
  readonly privacy: {
    readonly containsPersonalData: false;
    readonly repoApproved: true;
    readonly sanitization?: string;
  };
  readonly ocrReference?: {
    readonly textPath: string;
    readonly sha256: string;
    readonly language: 'vi' | 'en' | 'mixed';
    readonly source: 'synthetic';
  };
}

export class ManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestValidationError';
  }
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(path: string, reason: string): never {
  throw new ManifestValidationError(`${path}: ${reason}`);
}

function record(value: unknown, path: string, keys: readonly string[]): RecordValue {
  if (!isRecord(value)) fail(path, 'expected object');
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail(`${path}.${key}`, 'unknown property');
  }
  return value;
}

function string(value: unknown, path: string, maxLength = 500): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    fail(path, 'expected non-empty string');
  }
  return value;
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  path: string,
): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) fail(path, 'unknown value');
  return value as Values[number];
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'expected boolean');
  return value;
}

function parseDimensions(value: unknown, path: string): ImageDimensions {
  const input = record(value, path, ['width', 'height']);
  for (const dimension of ['width', 'height'] as const) {
    if (!Number.isSafeInteger(input[dimension]) || Number(input[dimension]) <= 0) {
      fail(`${path}.${dimension}`, 'expected positive safe integer');
    }
  }
  return { width: input.width as number, height: input.height as number };
}

function parseCorners(value: unknown, image: ImageDimensions, path: string): DocumentCorners {
  if (!Array.isArray(value) || value.length !== 4) fail(path, 'expected four ordered corners');
  const corners = value.map((point, index) => {
    const input = record(point, `${path}[${index}]`, ['x', 'y']);
    if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) {
      fail(`${path}[${index}]`, 'coordinates must be finite numbers');
    }
    return { x: input.x as number, y: input.y as number };
  }) as unknown as DocumentCorners;
  try {
    assertValidBenchmarkQuad(corners, image);
  } catch (error) {
    fail(path, error instanceof Error ? error.message : 'invalid quad');
  }
  return corners;
}

function isSafeRelativePath(value: string): boolean {
  if (value.includes('\0') || value.includes('\\') || value.startsWith('/')) return false;
  if (/^[a-z][a-z\d+.-]*:/i.test(value) || /^[a-z]:/i.test(value)) return false;
  const parts = value.split('/');
  return parts.every(
    (part) =>
      part.length > 0 && part !== '.' && part !== '..' && !/[<>:"|?*\u0000-\u001f]/.test(part),
  );
}

function parseLabel(value: unknown, image: ImageDimensions): FixtureLabel {
  if (!isRecord(value)) fail('fixture.label', 'expected object');
  if (value.kind === 'no-document') {
    record(value, 'fixture.label', ['kind', 'geometryEligible']);
    if (value.geometryEligible !== false) fail('fixture.label.geometryEligible', 'must be false');
    return { kind: 'no-document', geometryEligible: false };
  }
  if (value.kind !== 'document') fail('fixture.label.kind', 'unknown value');
  if (value.geometryEligible === true) {
    record(value, 'fixture.label', ['kind', 'geometryEligible', 'corners']);
    return {
      kind: 'document',
      geometryEligible: true,
      corners: parseCorners(value.corners, image, 'fixture.label.corners'),
    };
  }
  if (value.geometryEligible === false) {
    record(value, 'fixture.label', ['kind', 'geometryEligible', 'exclusionReason']);
    return {
      kind: 'document',
      geometryEligible: false,
      exclusionReason: enumValue(
        value.exclusionReason,
        ['partially-out-of-frame', 'ambiguous-boundary'],
        'fixture.label.exclusionReason',
      ),
    };
  }
  return fail('fixture.label.geometryEligible', 'expected boolean');
}

function parseProvenance(value: unknown, path: string): Fixture['provenance'] {
  if (!isRecord(value)) fail(path, 'expected object');
  const kind = enumValue(
    value.kind,
    ['synthetic', 'captured', 'public-domain', 'licensed'],
    `${path}.kind`,
  );
  const allowedKeys = [
    'kind',
    'licenseSpdx',
    'repoRedistributable',
    'sourceUri',
    'sourceRevision',
    'acquiredAt',
    'attribution',
    'licenseUrl',
    'approvalRef',
    'generator',
  ];
  record(value, path, allowedKeys);
  const licenseSpdx = string(value.licenseSpdx, `${path}.licenseSpdx`, 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(licenseSpdx) || licenseSpdx === 'NOASSERTION') {
    fail(`${path}.licenseSpdx`, 'expected an identified SPDX license');
  }
  const repoRedistributable = boolean(value.repoRedistributable, `${path}.repoRedistributable`);
  const sourceUri =
    value.sourceUri === undefined ? undefined : string(value.sourceUri, `${path}.sourceUri`);
  if (sourceUri !== undefined && !/^https?:\/\//i.test(sourceUri)) {
    fail(`${path}.sourceUri`, 'expected http(s) provenance URL');
  }
  const approvalRef =
    value.approvalRef === undefined ? undefined : string(value.approvalRef, `${path}.approvalRef`);
  const generator =
    value.generator === undefined ? undefined : string(value.generator, `${path}.generator`);
  if (kind === 'synthetic') {
    if (generator === undefined || approvalRef === undefined || !repoRedistributable) {
      fail(path, 'synthetic provenance requires generator, approvalRef and redistributable asset');
    }
  } else if (
    sourceUri === undefined ||
    approvalRef === undefined ||
    value.licenseUrl === undefined
  ) {
    fail(path, 'non-synthetic provenance requires sourceUri, licenseUrl and approvalRef');
  }
  if (
    value.acquiredAt !== undefined &&
    !validIsoDate(string(value.acquiredAt, `${path}.acquiredAt`))
  ) {
    fail(`${path}.acquiredAt`, 'expected ISO 8601 instant');
  }
  return {
    kind,
    licenseSpdx,
    repoRedistributable,
    ...(sourceUri === undefined ? {} : { sourceUri }),
    ...(value.sourceRevision === undefined
      ? {}
      : { sourceRevision: string(value.sourceRevision, `${path}.sourceRevision`) }),
    ...(value.acquiredAt === undefined
      ? {}
      : { acquiredAt: string(value.acquiredAt, `${path}.acquiredAt`) }),
    ...(value.attribution === undefined
      ? {}
      : { attribution: string(value.attribution, `${path}.attribution`) }),
    ...(value.licenseUrl === undefined
      ? {}
      : { licenseUrl: string(value.licenseUrl, `${path}.licenseUrl`) }),
    ...(approvalRef === undefined ? {} : { approvalRef }),
    ...(generator === undefined ? {} : { generator }),
  };
}

function validIsoDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function parseFixture(value: unknown, index: number): Fixture {
  const path = `fixtures[${index}]`;
  const input = record(value, path, [
    'id',
    'image',
    'label',
    'contentRiskTags',
    'provenance',
    'privacy',
    'ocrReference',
  ]);
  const id = string(input.id, `${path}.id`, 120);
  const imageInput = record(input.image, `${path}.image`, [
    'path',
    'sha256',
    'mimeType',
    'dimensions',
    'exifOrientationApplied',
  ]);
  const imagePath = string(imageInput.path, `${path}.image.path`, 260);
  if (!isSafeRelativePath(imagePath))
    fail(`${path}.image.path`, 'expected safe local relative path');
  const sha256 = string(imageInput.sha256, `${path}.image.sha256`, 64);
  if (!/^[a-f\d]{64}$/i.test(sha256)) fail(`${path}.image.sha256`, 'expected SHA-256 hex digest');
  const mimeType = enumValue(
    imageInput.mimeType,
    ['image/png', 'image/jpeg'],
    `${path}.image.mimeType`,
  );
  if (
    (mimeType === 'image/png' && !imagePath.toLowerCase().endsWith('.png')) ||
    (mimeType === 'image/jpeg' && !/\.(jpe?g)$/i.test(imagePath))
  ) {
    fail(`${path}.image.mimeType`, 'must match image file extension');
  }
  const dimensions = parseDimensions(imageInput.dimensions, `${path}.image.dimensions`);
  const exifOrientationApplied = boolean(
    imageInput.exifOrientationApplied,
    `${path}.image.exifOrientationApplied`,
  );
  if (!Array.isArray(input.contentRiskTags)) fail(`${path}.contentRiskTags`, 'expected array');
  const tags = input.contentRiskTags.map((tag, tagIndex) =>
    enumValue(tag, CONTENT_RISK_TAGS, `${path}.contentRiskTags[${tagIndex}]`),
  );
  if (new Set(tags).size !== tags.length) fail(`${path}.contentRiskTags`, 'duplicate tag');
  const privacyInput = record(input.privacy, `${path}.privacy`, [
    'containsPersonalData',
    'repoApproved',
    'sanitization',
  ]);
  if (privacyInput.containsPersonalData !== false) {
    fail(`${path}.privacy.containsPersonalData`, 'fixtures with personal data are not allowed');
  }
  if (privacyInput.repoApproved !== true)
    fail(`${path}.privacy.repoApproved`, 'must be approved for repository use');
  const privacy: Fixture['privacy'] = {
    containsPersonalData: false,
    repoApproved: true,
    ...(privacyInput.sanitization === undefined
      ? {}
      : { sanitization: string(privacyInput.sanitization, `${path}.privacy.sanitization`) }),
  };
  const provenance = parseProvenance(input.provenance, `${path}.provenance`);
  if (!provenance.repoRedistributable)
    fail(`${path}.provenance.repoRedistributable`, 'repository fixtures must be redistributable');
  const ocrReference =
    input.ocrReference === undefined
      ? undefined
      : parseOcrReference(input.ocrReference, `${path}.ocrReference`);
  return {
    id,
    image: { path: imagePath, sha256, mimeType, dimensions, exifOrientationApplied },
    label: parseLabel(input.label, dimensions),
    contentRiskTags: tags,
    provenance,
    privacy,
    ...(ocrReference === undefined ? {} : { ocrReference }),
  };
}

function parseOcrReference(value: unknown, path: string): Fixture['ocrReference'] {
  const input = record(value, path, ['textPath', 'sha256', 'language', 'source']);
  const textPath = string(input.textPath, `${path}.textPath`, 260);
  if (!isSafeRelativePath(textPath)) fail(`${path}.textPath`, 'expected safe local relative path');
  const sha256 = string(input.sha256, `${path}.sha256`, 64);
  if (!/^[a-f\d]{64}$/i.test(sha256)) fail(`${path}.sha256`, 'expected SHA-256 hex digest');
  if (input.source !== 'synthetic') fail(`${path}.source`, 'OCR references must be synthetic');
  return {
    textPath,
    sha256,
    language: enumValue(input.language, ['vi', 'en', 'mixed'], `${path}.language`),
    source: 'synthetic',
  };
}

export function parseFixtureManifest(value: unknown): FixtureManifest {
  const input = record(value, 'manifest', ['schemaVersion', 'dataset', 'fixtures']);
  if (input.schemaVersion !== 1) fail('manifest.schemaVersion', 'unsupported schema version');
  const dataset = record(input.dataset, 'dataset', [
    'id',
    'revision',
    'createdAt',
    'split',
    'coordinateSpace',
  ]);
  const createdAt = string(dataset.createdAt, 'dataset.createdAt');
  if (!validIsoDate(createdAt)) fail('dataset.createdAt', 'expected ISO 8601 instant');
  if (dataset.coordinateSpace !== 'original-image-pixels') {
    fail('dataset.coordinateSpace', 'unsupported coordinate space');
  }
  if (!Array.isArray(input.fixtures) || input.fixtures.length === 0) {
    fail('manifest.fixtures', 'expected at least one fixture');
  }
  if (input.fixtures.length > MAX_FIXTURE_COUNT) {
    fail('manifest.fixtures', `fixture count exceeds configured limit (${MAX_FIXTURE_COUNT})`);
  }
  const fixtures = input.fixtures.map(parseFixture);
  const split = enumValue(dataset.split, ['synthetic', 'development', 'holdout'], 'dataset.split');
  if (
    split === 'synthetic' &&
    fixtures.some((fixture) => fixture.provenance.kind !== 'synthetic')
  ) {
    fail('manifest.fixtures', 'synthetic datasets may contain only synthetic fixtures');
  }
  const fixtureIds = new Set<string>();
  const imagePaths = new Set<string>();
  for (const fixture of fixtures) {
    if (fixtureIds.has(fixture.id)) fail('manifest.fixtures', `duplicate fixture id ${fixture.id}`);
    if (imagePaths.has(fixture.image.path))
      fail('manifest.fixtures', `duplicate image path ${fixture.image.path}`);
    fixtureIds.add(fixture.id);
    imagePaths.add(fixture.image.path);
  }
  return {
    schemaVersion: 1,
    dataset: {
      id: string(dataset.id, 'dataset.id', 120),
      revision: string(dataset.revision, 'dataset.revision', 120),
      createdAt,
      split,
      coordinateSpace: 'original-image-pixels',
    },
    fixtures,
  };
}
