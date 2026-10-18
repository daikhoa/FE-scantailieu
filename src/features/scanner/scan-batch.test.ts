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
