import { describe, expect, it, vi } from 'vitest';

import type { ProcessedScanPage } from '../../features/scanner/background-page-processor';
import type { LocalRestorationClient } from './local-restoration-client';
import { canReuseRestorationAnalysis, restoreProcessedPage } from './local-page-restoration';

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
  it('reuses analysis for filter and rotation edits but not a changed crop', () => {
    const previous = page().recipe;
    expect(
      canReuseRestorationAnalysis(previous, {
        ...previous,
        rotation: 90,
        filter: { mode: 'grayscale', presetVersion: 'gray-test', parameters: {} },
      }),
    ).toBe(true);
    expect(
      canReuseRestorationAnalysis(previous, {
        ...previous,
        crop: {
          kind: 'document',
          corners: [
            { x: 1, y: 1 },
            { x: 99, y: 1 },
            { x: 99, y: 139 },
            { x: 1, y: 139 },
          ],
        },
      }),
    ).toBe(false);
  });

  it('keeps local pixels when the classifier selects no heavy stage', async () => {
    const original = page();
    const restore = vi.fn<LocalRestorationClient['restore']>(() =>
      Promise.resolve({
        route: 'local',
        stages: [],
        classifierModel: 'defects@1',
        provider: null,
        warnings: ['retake-finger'],
      }),
    );
    const client: LocalRestorationClient = {
      restore,
    };
    const signal = new AbortController().signal;

    const result = await restoreProcessedPage(original, client, signal, {
      analysisKey: 'page-1',
      reuseAnalysis: true,
    });

    expect(result.variant).toBe(original.variant);
    expect(result.restoration).toEqual({
      kind: 'classified-local',
      classifierModel: 'defects@1',
      warnings: ['retake-finger'],
    });
    expect(restore).toHaveBeenCalledWith(original.variant.image.blob, signal, {
      analysisKey: 'page-1',
      reuseAnalysis: true,
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
