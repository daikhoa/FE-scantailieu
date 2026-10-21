/// <reference types="node" />

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const HOSTING_FILE_LIMIT = 25 * 1024 * 1024;
const EXPECTED_UVDOC_SHA256 = '3f5ec09f1c6c5947ae7cc8db93ed7dd6dd2d164d3d99a6a70387c98848cfb00c';

describe('browser restoration model assets', () => {
  it('keeps each UVDoc part deployable and reconstructs the licensed model exactly', () => {
    const parts = [0, 1].map((index) =>
      readFileSync(resolve(`public/models/local-restoration/uvdoc.onnx.part-${String(index)}`)),
    );

    for (const part of parts) expect(part.byteLength).toBeLessThanOrEqual(HOSTING_FILE_LIMIT);
    const hash = createHash('sha256');
    for (const part of parts) hash.update(part);
    const digest = hash.digest('hex');
    expect(digest).toBe(EXPECTED_UVDOC_SHA256);
  });
});
