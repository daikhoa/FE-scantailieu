import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateSyntheticFixtureSet } from '../../scripts/generate-synthetic-fixtures.ts';
import { parseFixtureManifest } from './schema.ts';

const generatedRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'clonecamscanner-fixtures-'));
  generatedRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    generatedRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('synthetic scanner fixtures', () => {
  it('generates a deterministic, privacy-safe document/no-document smoke set', async () => {
    const firstRoot = await temporaryRoot();
    const secondRoot = await temporaryRoot();

    const firstManifestPath = await generateSyntheticFixtureSet(firstRoot);
    const secondManifestPath = await generateSyntheticFixtureSet(secondRoot);
    const firstManifestBytes = await readFile(firstManifestPath);
    const secondManifestBytes = await readFile(secondManifestPath);
    const manifest = parseFixtureManifest(JSON.parse(firstManifestBytes.toString('utf8')));

    expect(firstManifestBytes).toEqual(secondManifestBytes);
    expect(manifest.fixtures).toHaveLength(4);
    expect(manifest.fixtures.map((fixture) => fixture.label.kind)).toEqual([
      'document',
      'document',
      'no-document',
      'no-document',
    ]);

    for (const fixture of manifest.fixtures) {
      expect(fixture.provenance).toMatchObject({
        kind: 'synthetic',
        licenseSpdx: 'CC0-1.0',
        repoRedistributable: true,
      });
      expect(fixture.privacy).toMatchObject({
        containsPersonalData: false,
        repoApproved: true,
      });

      const firstImage = await readFile(join(firstRoot, ...fixture.image.path.split('/')));
      const secondImage = await readFile(join(secondRoot, ...fixture.image.path.split('/')));
      expect(firstImage.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(firstImage).toEqual(secondImage);
      expect(createHash('sha256').update(firstImage).digest('hex')).toBe(fixture.image.sha256);
    }
  });
});
