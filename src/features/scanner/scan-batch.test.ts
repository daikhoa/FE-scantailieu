import { describe, expect, it } from 'vitest';

import type { ProcessedScanPage } from './background-page-processor';
import { scanBatchReducer, scanBatchStatus, type ScanBatchState } from './scan-batch';

const firstSource = new Blob(['first'], { type: 'image/jpeg' });
const secondSource = new Blob(['second'], { type: 'image/jpeg' });
const replacementSource = new Blob(['replacement'], { type: 'image/jpeg' });

function processed(source: Blob, key: string): ProcessedScanPage {
  const original = { blob: source, dimensions: { width: 1200, height: 1600 } };
  const crop = { kind: 'full-frame' as const };
  const recipe = {
    version: 1,
    crop,
    rotation: 0 as const,
    dewarp: { mode: 'perspective-only' as const },
    filter: {
      mode: 'ocr-color' as const,
      presetVersion: 'ocr-color-v3',
      parameters: {},
    },
  };
  return {
    original,
    crop,
    recipe,
    variant: {
      recipeKey: key,
      engineVersion: 'test',
      image: {
        blob: new Blob([key], { type: 'image/png' }),
        dimensions: original.dimensions,
      },
      dewarp: { kind: 'not-requested' },
    },
  };
}

describe('scan batch reducer', () => {
  it('rebases unloaded assets after save without discarding ready edits or resending them', () => {
    const ready = {
      id: 'one',
      kind: 'ready' as const,
      modified: true,
      source: firstSource,
      page: processed(firstSource, 'edited'),
    };
    const result = scanBatchReducer(
      { pages: [ready, { id: 'two', kind: 'loading-saved', previewUrl: '/old' }] },
      {
        type: 'rebased',
        pages: [
          { id: 'two', kind: 'loading-saved', previewUrl: '/new' },
          { id: 'one', kind: 'loading-saved', previewUrl: '/one' },
        ],
      },
    );
    expect(result.pages[0]).toMatchObject({ id: 'two', previewUrl: '/new' });
    expect(result.pages[1]).toMatchObject({ id: 'one', kind: 'ready', modified: false });
    if (result.pages[1]?.kind !== 'ready') throw new Error('Ready page was lost');
    expect(result.pages[1].page).toBe(ready.page);
  });
  it('reorders page identities without losing edits or late background results', () => {
    const first = {
      id: 'first',
      kind: 'ready' as const,
      source: firstSource,
      page: processed(firstSource, 'edited'),
    };
    const second = { id: 'second', kind: 'loading-saved' as const, previewUrl: '/preview' };
    const state = { pages: [first, second] };
    const reordered = scanBatchReducer(state, { type: 'reordered', ids: ['second', 'first'] });
    expect(reordered.pages).toEqual([second, first]);
    expect(reordered.pages[1]).toBe(first);
    const completed = scanBatchReducer(reordered, {
      type: 'ready',
      id: 'second',
      page: processed(secondSource, 'loaded'),
    });
    expect(completed.pages.map((page) => page.id)).toEqual(['second', 'first']);
    expect(completed.pages[0]?.kind).toBe('ready');
    expect(completed.pages[1]).toBe(first);
  });

  it('rejects incomplete, duplicate or unknown orderings and preserves no-op identity', () => {
    const state: ScanBatchState = {
      pages: [
        { id: 'first', kind: 'queued', source: firstSource },
        { id: 'second', kind: 'queued', source: secondSource },
      ],
    };
    for (const ids of [['first'], ['first', 'first'], ['first', 'unknown'], ['first', 'second']]) {
      expect(scanBatchReducer(state, { type: 'reordered', ids })).toBe(state);
    }
  });

  it('releases the large captured RGBA buffer after durable processing succeeds', () => {
    const capturedSource = {
      kind: 'rgba-frame' as const,
      dimensions: { width: 2, height: 2 },
      pixels: new Uint8ClampedArray(16),
    };
    const durableSource = new Blob(['durable'], { type: 'image/jpeg' });
    let state: ScanBatchState = {
      pages: [{ id: 'page-1', source: capturedSource, kind: 'processing' }],
    };

    state = scanBatchReducer(state, {
      type: 'ready',
      id: 'page-1',
      page: processed(durableSource, 'ready'),
    });

    expect(state.pages[0]?.source).toBe(durableSource);
  });

  it('keeps capture order while pages finish independently', () => {
    let state: ScanBatchState = { pages: [] };
    state = scanBatchReducer(state, {
      type: 'captured',
      id: 'page-1',
      source: firstSource,
    });
    state = scanBatchReducer(state, {
      type: 'captured',
      id: 'page-2',
      source: secondSource,
    });
    state = scanBatchReducer(state, { type: 'started', id: 'page-1' });
    state = scanBatchReducer(state, {
      type: 'ready',
      id: 'page-2',
      page: processed(secondSource, 'second'),
    });
    state = scanBatchReducer(state, {
      type: 'ready',
      id: 'page-1',
      page: processed(firstSource, 'first'),
    });

    expect(state.pages.map((page) => page.id)).toEqual(['page-1', 'page-2']);
    expect(state.pages.map((page) => page.kind)).toEqual(['ready', 'ready']);
    expect(scanBatchStatus(state)).toEqual({ total: 2, processing: 0, failed: 0 });
  });

  it('marks failures honestly and permits retry or removal without touching other pages', () => {
    let state: ScanBatchState = { pages: [] };
    state = scanBatchReducer(state, {
      type: 'captured',
      id: 'page-1',
      source: firstSource,
    });
    state = scanBatchReducer(state, {
      type: 'captured',
      id: 'page-2',
      source: secondSource,
    });
    state = scanBatchReducer(state, { type: 'failed', id: 'page-1' });

    expect(scanBatchStatus(state)).toEqual({ total: 2, processing: 1, failed: 1 });
    state = scanBatchReducer(state, { type: 'retry', id: 'page-1' });
    expect(state.pages[0]?.kind).toBe('queued');
    state = scanBatchReducer(state, { type: 'removed', id: 'page-1' });
    expect(state.pages).toEqual([expect.objectContaining({ id: 'page-2', source: secondSource })]);
  });

  it('ignores stale completion after a page was removed', () => {
    let state: ScanBatchState = { pages: [] };
    state = scanBatchReducer(state, {
      type: 'captured',
      id: 'page-1',
      source: firstSource,
    });
    state = scanBatchReducer(state, { type: 'removed', id: 'page-1' });
    state = scanBatchReducer(state, {
      type: 'ready',
      id: 'page-1',
      page: processed(firstSource, 'late'),
    });

    expect(state.pages).toEqual([]);
  });

  it('replaces one page in place with a new identity and ignores the old completion', () => {
    let state: ScanBatchState = { pages: [] };
    state = scanBatchReducer(state, {
      type: 'captured',
      id: 'page-1',
      source: firstSource,
    });
    state = scanBatchReducer(state, {
      type: 'captured',
      id: 'page-2',
      source: secondSource,
    });
    state = scanBatchReducer(state, {
      type: 'replaced',
      id: 'page-1',
      replacementId: 'page-3',
      source: replacementSource,
    });

    expect(state.pages).toEqual([
      { id: 'page-3', source: replacementSource, kind: 'queued' },
      { id: 'page-2', source: secondSource, kind: 'queued' },
    ]);

    state = scanBatchReducer(state, {
      type: 'ready',
      id: 'page-1',
      page: processed(firstSource, 'stale-original'),
    });
    expect(state.pages[0]).toEqual({
      id: 'page-3',
      source: replacementSource,
      kind: 'queued',
    });
  });
});
