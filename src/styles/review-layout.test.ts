/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('batch review image layout', () => {
  it('contains the complete processed page inside the review frame', () => {
    const stylesheet = readFileSync(resolve('src/styles/global.css'), 'utf8');
    const imageRule = /\.batch-page__preview img\s*\{(?<body>[^}]*)\}/u.exec(stylesheet)?.groups
      ?.body;

    expect(imageRule).toBeDefined();
    expect(imageRule).toMatch(/width:\s*100%/u);
    expect(imageRule).toMatch(/height:\s*100%/u);
    expect(imageRule).toMatch(/object-fit:\s*contain/u);
    expect(imageRule).toMatch(/object-position:\s*center/u);
  });
});
