import { describe, expect, it } from 'vitest';

import type { RenderPageRequest } from '../contracts/scanner-engine';
import { createRenderRecipeKey } from './render-recipe-key';

function request(blob: Blob, parameters: Readonly<Record<string, number>>): RenderPageRequest {
  return {
    original: { blob, dimensions: { width: 20, height: 10 } },
    orientation: 0,
    recipe: {
      version: 1,
      crop: { kind: 'full-frame' },
      rotation: 0,
      dewarp: { mode: 'perspective-only' },
      filter: { mode: 'original', presetVersion: 'original-v1', parameters },
    },
  };
}

describe('createRenderRecipeKey', () => {
  it('is stable across parameter insertion order', async () => {
    const blob = new Blob(['same image'], { type: 'image/png' });
    const first = await createRenderRecipeKey(
      request(blob, { contrast: 1, brightness: 2 }),
      'engine-v1',
      new AbortController().signal,
    );
    const second = await createRenderRecipeKey(
      request(blob, { brightness: 2, contrast: 1 }),
      'engine-v1',
      new AbortController().signal,
    );

    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('changes with source bytes, recipe, orientation, or engine version', async () => {
    const base = request(new Blob(['image-a'], { type: 'image/png' }), {});
    const variants: RenderPageRequest[] = [
      request(new Blob(['image-b'], { type: 'image/png' }), {}),
      { ...base, orientation: 90 },
      { ...base, recipe: { ...base.recipe, rotation: 90 } },
    ];
    const baseKey = await createRenderRecipeKey(base, 'engine-v1', new AbortController().signal);
    const keys = await Promise.all(
      variants.map((variant) =>
        createRenderRecipeKey(variant, 'engine-v1', new AbortController().signal),
      ),
    );
    keys.push(await createRenderRecipeKey(base, 'engine-v2', new AbortController().signal));

    expect(new Set([baseKey, ...keys])).toHaveLength(5);
  });

  it('returns a sanitized AbortError without exposing signal.reason', async () => {
    const controller = new AbortController();
    controller.abort('private document metadata');

    await expect(
      createRenderRecipeKey(
        request(new Blob(['image'], { type: 'image/png' }), {}),
        'engine-v1',
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError', message: 'Scanner operation cancelled.' });
  });
});
