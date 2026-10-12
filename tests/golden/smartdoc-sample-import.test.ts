import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  parseSmartDocGroundTruth,
  selectRepresentativeFrames,
} from '../../scripts/prepare-smartdoc-sample.ts';
import { parseFixtureManifest } from './schema.ts';

const XML = `<?xml version="1.0"?>
<ground_truth>
  <segmentation_results>
    <frame index="1" rejected="false">
      <point name="bl" x="10" y="90"/>
      <point name="tl" x="12" y="10"/>
      <point name="tr" x="88" y="11"/>
      <point name="br" x="90" y="91"/>
    </frame>
    <frame index="2" rejected="true"></frame>
    <frame index="3" rejected="false">
      <point name="tl" x="20.5" y="20.25"/>
      <point name="tr" x="80.5" y="21.25"/>
      <point name="br" x="81.5" y="79.75"/>
      <point name="bl" x="19.5" y="78.75"/>
    </frame>
  </segmentation_results>
</ground_truth>`;

describe('SmartDoc sample importer', () => {
  it('parses accepted frames and normalizes corners to TL, TR, BR, BL order', () => {
    const frames = parseSmartDocGroundTruth(XML);

    expect(frames).toEqual([
      {
        index: 1,
        corners: [
          { x: 12, y: 10 },
          { x: 88, y: 11 },
          { x: 90, y: 91 },
          { x: 10, y: 90 },
        ],
      },
      {
        index: 3,
        corners: [
          { x: 20.5, y: 20.25 },
          { x: 80.5, y: 21.25 },
          { x: 81.5, y: 79.75 },
          { x: 19.5, y: 78.75 },
        ],
      },
    ]);
  });

  it('selects deterministic frames across the complete accepted sequence', () => {
    const frames = Array.from({ length: 11 }, (_, offset) => ({
      index: offset + 1,
      corners: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ] as const,
    }));

    expect(selectRepresentativeFrames(frames, 5).map(({ index }) => index)).toEqual([
      1, 4, 6, 9, 11,
    ]);
    expect(selectRepresentativeFrames(frames, 20)).toHaveLength(11);
  });

  it.each([
    ['external entities', '<!DOCTYPE x [<!ENTITY leak SYSTEM "file:///private">]><ground_truth/>'],
    ['duplicate indexes', XML.replace('<frame index="3"', '<frame index="1"')],
    ['missing corners', XML.replace('<point name="br" x="90" y="91"/>', '')],
    ['non-finite coordinates', XML.replace('x="12"', 'x="Infinity"')],
  ])('rejects malformed %s', (_name, xml) => {
    expect(() => parseSmartDocGroundTruth(xml)).toThrow('Invalid SmartDoc ground truth');
  });

  it('rejects unsafe selection counts', () => {
    expect(() => selectRepresentativeFrames(parseSmartDocGroundTruth(XML), 0)).toThrow(RangeError);
  });

  it('keeps checked-in development and holdout fixtures schema-valid and hash-pinned', async () => {
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    for (const split of ['development', 'holdout'] as const) {
      const manifestPath = resolve(
        repositoryRoot,
        'tests',
        'fixtures',
        'smartdoc15',
        split,
        'manifest.json',
      );
      const manifest = parseFixtureManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
      expect(manifest.dataset.split).toBe(split);
      expect(manifest.fixtures).toHaveLength(split === 'development' ? 10 : 5);
      for (const fixture of manifest.fixtures) {
        const bytes = await readFile(resolve(dirname(manifestPath), fixture.image.path));
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(fixture.image.sha256);
      }
    }
  });
});
