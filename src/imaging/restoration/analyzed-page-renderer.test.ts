import { describe, expect, it, vi } from 'vitest';
import type { ScannerEngine } from '../contracts/scanner-engine';
import { renderAnalyzedPage } from './analyzed-page-renderer';
import { createDefaultPageRecipe } from '../../features/scanner/background-page-processor';
import type { LocalRestorationAnalysis } from './local-restoration-client';
import { createDocumentRecipe } from '../../features/editor/document-filters';

const analysis: LocalRestorationAnalysis = {
  kind: 'analysis',
  stages: [],
  warnings: [],
  classifierModel: 'test',
  protectColor: false,
};
const original = {
  blob: new Blob(['original'], { type: 'image/jpeg' }),
  dimensions: { width: 20, height: 30 },
};
const recipe = createDocumentRecipe({ kind: 'full-frame' }, 'ocr-color');
function setup() {
  const renderPixels = vi.fn<NonNullable<ScannerEngine['renderPixels']>>(() =>
    Promise.resolve({ dimensions: { width: 20, height: 30 }, pixels: new Uint8ClampedArray(2400) }),
  );
  const render = vi.fn<ScannerEngine['render']>(() =>
    Promise.resolve({
      image: original,
      recipeKey: 'key',
      engineVersion: 'test',
      dewarp: { kind: 'not-requested' },
    }),
  );
  const engine: ScannerEngine = {
    lifecycle: { kind: 'ready' },
    initialize: vi.fn(),
    detect: vi.fn(),
    render,
    renderPixels,
    dispose: vi.fn(),
  };
  const analyze = vi.fn(() => Promise.resolve(analysis));
  return { engine, renderPixels, render, analyze };
}
describe('single final render', () => {
  it.each(['enhanced-color', 'original'] as const)(
    'renders %s without an unused classifier or rough warp',
    async (mode) => {
      const { engine, renderPixels, render, analyze } = setup();
      const fastRecipe = createDefaultPageRecipe({ kind: 'full-frame' });
      const result = await renderAnalyzedPage(
        engine,
        original,
        { ...fastRecipe, filter: { ...fastRecipe.filter, mode } },
        new AbortController().signal,
        { analyzer: { analyze } },
      );
      expect(renderPixels).not.toHaveBeenCalled();
      expect(analyze).not.toHaveBeenCalled();
      expect(render).toHaveBeenCalledOnce();
      expect(result.restoration).toEqual({ kind: 'local' });
    },
  );
  it('analyzes raw 720 crop, then encodes exactly one final render with the plan', async () => {
    const { engine, renderPixels, render, analyze } = setup();
    await renderAnalyzedPage(engine, original, recipe, new AbortController().signal, {
      analyzer: { analyze },
    });
    expect(renderPixels).toHaveBeenCalledOnce();
    expect(renderPixels.mock.calls[0]?.[0]).toMatchObject({
      maximumOutputLongSide: 720,
      recipe: { filter: { mode: 'original' } },
    });
    expect(analyze).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledOnce();
    expect(render.mock.calls[0]?.[0]).toMatchObject({
      maximumOutputLongSide: 3000,
      analysis,
      preserveOutputPixels: false,
    });
  });
  it('reuses analysis for filter/rotation changes without detecting or classifying', async () => {
    const { engine, renderPixels, analyze } = setup();
    await renderAnalyzedPage(
      engine,
      original,
      { ...recipe, rotation: 90 },
      new AbortController().signal,
      { analyzer: { analyze }, analysis },
    );
    expect(renderPixels).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
    expect(vi.mocked(engine).detect.mock.calls).toHaveLength(0);
  });
});
