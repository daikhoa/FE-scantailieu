// @vitest-environment node

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
  it('reproduces the committed privacy-safe document/no-document smoke set', async () => {
    const generatedRoot = await temporaryRoot();
    const committedRoot = join(process.cwd(), 'tests', 'fixtures');

    const generatedManifestPath = await generateSyntheticFixtureSet(generatedRoot);
    const generatedManifestBytes = await readFile(generatedManifestPath);
    const committedManifestBytes = await readFile(join(committedRoot, 'manifest.example.json'));
    const manifest = parseFixtureManifest(JSON.parse(generatedManifestBytes.toString('utf8')));
    const committedManifest = parseFixtureManifest(
      JSON.parse(committedManifestBytes.toString('utf8')),
    );

    expect(manifest).toEqual(committedManifest);
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

      const generatedImage = await readFile(join(generatedRoot, ...fixture.image.path.split('/')));
      const committedImage = await readFile(join(committedRoot, ...fixture.image.path.split('/')));
      expect(generatedImage.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(generatedImage).toEqual(committedImage);
      expect(createHash('sha256').update(generatedImage).digest('hex')).toBe(fixture.image.sha256);
    }
  }, 10_000);
});
