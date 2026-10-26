import { describe, expect, it, vi } from 'vitest';
import { createDocscan } from '@docscan/browser';

describe('portable library process API', () => {
  it('owns import, document detection and default final rendering behind process()', async () => {
    const original = {
      blob: new Blob(['original'], { type: 'image/jpeg' }),
      dimensions: { width: 400, height: 600 },
    };
    const variant = {
      image: original,
      recipeKey: 'result',
      engineVersion: 'test',
      dewarp: { kind: 'not-requested' as const },
    };
    const frame = { dimensions: { width: 40, height: 60 }, close: vi.fn() };
    const engine = {
      lifecycle: { kind: 'ready' as const },
      initialize: vi.fn().mockResolvedValue(undefined),
      detect: vi.fn().mockResolvedValue({
        kind: 'document',
        dimensions: frame.dimensions,
        confidence: 1,
        corners: [
          { x: 1, y: 1 },
          { x: 39, y: 1 },
          { x: 39, y: 59 },
          { x: 1, y: 59 },
        ],
      }),
      render: vi.fn().mockResolvedValue(variant),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    const sdk = createDocscan({
      engineFactory: () => engine,
      importer: vi.fn().mockResolvedValue({ original }),
      frameSource: { create: vi.fn().mockResolvedValue(frame) },
    });
    const result = await sdk.process(original.blob);
    expect(result.original).toBe(original);
    expect(result.crop.kind).toBe('document');
    expect(result.variant).toBe(variant);
    expect(engine.render).toHaveBeenCalledWith(
      expect.objectContaining({
        recipe: expect.objectContaining({
          filter: expect.objectContaining({ mode: 'enhanced-color' }),
          crop: {
            kind: 'document',
            corners: [
              { x: 10, y: 10 },
              { x: 390, y: 10 },
              { x: 390, y: 590 },
              { x: 10, y: 590 },
            ],
          },
        }),
      }),
      expect.any(AbortSignal),
    );
    expect(frame.close).toHaveBeenCalledOnce();
    await sdk.dispose();
    expect(engine.dispose).toHaveBeenCalledOnce();
    await expect(sdk.process(original.blob)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
