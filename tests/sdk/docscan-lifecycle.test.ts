import { describe, expect, it, vi } from 'vitest';
import { createDocscan, createDocumentRecipe } from '@docscan/browser';

function fixture() {
  const original = {
    blob: new Blob(['image'], { type: 'image/jpeg' }),
    dimensions: { width: 400, height: 600 },
  };
  const engine = {
    lifecycle: { kind: 'ready' as const },
    initialize: vi.fn().mockResolvedValue(undefined),
    detect: vi.fn().mockRejectedValue(new Error('Manual crop must skip detection')),
    render: vi.fn().mockResolvedValue({
      image: original,
      recipeKey: 'test',
      engineVersion: 'test',
      dewarp: { kind: 'not-requested' as const },
    }),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
  const importer = vi.fn().mockResolvedValue({ original });
  const scanner = createDocscan({ engineFactory: () => engine, importer });
  return { scanner, engine, importer, original };
}

describe('SDK lifecycle and editing contract', () => {
  it('retires a failed edit runtime and allows a new edit without reimporting the page', async () => {
    const first = fixture(),
      next = fixture();
    const engines = vi.fn().mockReturnValueOnce(first.engine).mockReturnValue(next.engine);
    first.engine.render.mockRejectedValueOnce(new Error('runtime failed'));
    const scanner = createDocscan({ engineFactory: engines });
    const recipe = createDocumentRecipe({ kind: 'full-frame' }, 'original');
    await expect(scanner.render(first.original, recipe)).rejects.toThrow('runtime failed');
    expect(first.engine.dispose).toHaveBeenCalledOnce();
    await expect(scanner.render(first.original, recipe)).resolves.toHaveProperty('variant');
    expect(engines).toHaveBeenCalledTimes(2);
    await scanner.dispose();
    await first.scanner.dispose();
    await next.scanner.dispose();
  });
  it('honors explicit crop and rotation, then renders edits through the same owned engine', async () => {
    const { scanner, engine, original } = fixture();
    const crop = { kind: 'full-frame' as const };
    const page = await scanner.process(original.blob, { crop, rotation: 90 });
    expect(page.image).toBe(original);
    expect(engine.detect).not.toHaveBeenCalled();
    expect(page.recipe.rotation).toBe(90);
    const recipe = createDocumentRecipe(crop, 'original');
    const edited = await scanner.render(original, recipe);
    expect(edited.recipe).toEqual(recipe);
    expect(engine.initialize).toHaveBeenCalledOnce();
    expect(engine.render).toHaveBeenLastCalledWith(
      expect.objectContaining({ original, recipe }),
      expect.any(AbortSignal),
    );
    await scanner.dispose();
  });

  it('rejects cancellation before import and rejects all work after idempotent disposal', async () => {
    const { scanner, importer, engine, original } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      scanner.process(original.blob, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(importer).not.toHaveBeenCalled();
    await scanner.process(original.blob, { crop: { kind: 'full-frame' } });
    await Promise.all([scanner.dispose(), scanner.dispose()]);
    expect(engine.dispose).toHaveBeenCalledOnce();
    await expect(
      scanner.render(original, createDocumentRecipe({ kind: 'full-frame' })),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(scanner.createPdf([original])).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('bounds batch input before importing any page', async () => {
    const { scanner, importer, original } = fixture();
    await expect(scanner.processPdf([])).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(
      scanner.processPdf(Array.from({ length: 65 }, () => original.blob)),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect(importer).not.toHaveBeenCalled();
    await scanner.dispose();
  });
});
