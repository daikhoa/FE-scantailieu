import { describe, expect, it } from 'vitest';

import type { ProcessedScanPage } from '../../features/scanner/background-page-processor';
import type { LocalRestorationClient } from './local-restoration-client';
import { restoreProcessedPage } from './local-page-restoration';

function page(): ProcessedScanPage {
  const blob = new Blob([new Uint8Array([1])], { type: 'image/png' });
  return {
    original: { blob, dimensions: { width: 100, height: 140 } },
    crop: { kind: 'full-frame' },
    recipe: {
      version: 1,
      crop: { kind: 'full-frame' },
      rotation: 0,
      dewarp: { mode: 'perspective-only' },
      filter: { mode: 'ocr-color', presetVersion: 'test', parameters: {} },
    },
    variant: {
      recipeKey: 'recipe:test',
      image: { blob, dimensions: { width: 100, height: 140 } },
      engineVersion: 'local-test',
      dewarp: { kind: 'not-requested' },
    },
    restoration: { kind: 'processing' },
  };
}

describe('restoreProcessedPage', () => {
  it('keeps local pixels when the classifier selects no heavy stage', async () => {
    const original = page();
    const client: LocalRestorationClient = {
      restore: () =>
        Promise.resolve({
          route: 'local',
          stages: [],
          classifierModel: 'defects@1',
          provider: null,
          warnings: ['retake-finger'],
        }),
    };

    const result = await restoreProcessedPage(original, client, new AbortController().signal);

    expect(result.variant).toBe(original.variant);
    expect(result.restoration).toEqual({
      kind: 'classified-local',
      classifierModel: 'defects@1',
      warnings: ['retake-finger'],
    });
  });

  it('replaces only the rendered variant after local model restoration', async () => {
    const original = page();
    const restoredBlob = new Blob([new Uint8Array([2])], { type: 'image/png' });
    const client: LocalRestorationClient = {
      restore: () =>
        Promise.resolve({
          route: 'enhanced',
          stages: ['dewarp', 'deshadow'],
          classifierModel: 'defects@1',
          provider: 'browser-ort-webgpu@1.27.0',
          warnings: ['unsupported-moire'],
          image: { blob: restoredBlob, dimensions: { width: 120, height: 160 } },
        }),
    };

    const result = await restoreProcessedPage(original, client, new AbortController().signal);

    expect(result.original).toBe(original.original);
    expect(result.crop).toBe(original.crop);
    expect(result.variant.image.blob).toBe(restoredBlob);
    expect(result.variant.engineVersion).toContain('browser-ort-webgpu@1.27.0');
    expect(result.variant.dewarp).toEqual({
      kind: 'applied',
      modelVersion: 'browser-ort-webgpu@1.27.0',
    });
    expect(result.restoration).toMatchObject({
      kind: 'applied',
      warnings: ['unsupported-moire'],
    });
  });
});
