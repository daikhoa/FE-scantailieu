/// <reference types="node" />

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const CLASSIFIER_BYTE_LIMIT = 10 * 1024 * 1024;
const EXPECTED_CLASSIFIER_SHA256 =
  '9d42dd1121652dbc68c21b0cac13e40f3e7e57a04761ed380c7c99f2e5a6e4f7';

describe('browser restoration model assets', () => {
  it('verifies the bounded classifier shipped by the library SDK', () => {
    const require = createRequire(import.meta.url);
    const entry = require.resolve('@docscan/browser');
    const model = readFileSync(resolve(dirname(entry), '../assets/models/document-defects.onnx'));
    expect(model.byteLength).toBeLessThanOrEqual(CLASSIFIER_BYTE_LIMIT);
    expect(createHash('sha256').update(model).digest('hex')).toBe(EXPECTED_CLASSIFIER_SHA256);
  });
});
