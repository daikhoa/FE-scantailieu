import { describe, expect, expectTypeOf, it } from 'vitest';

import type { EditRecipe, PageAsset, QuarterTurn } from './document';
import {
  createScanSession,
  transitionScanSession,
  type ScanSession,
  type ScanSessionEvent,
} from './scan-session';
import type { RenderPageRequest, ScannerEngine } from '../imaging/contracts/scanner-engine';

const documentId = 'document-1';
const idle: ScanSession = { kind: 'idle', documentId };
const initializing: ScanSession = { kind: 'initializing', documentId, operationId: 'init-1' };
const ready: ScanSession = { kind: 'ready', documentId };
const processing: ScanSession = {
  kind: 'processing',
  documentId,
  pageId: 'page-1',
  operationId: 'render-1',
};
const reviewing: ScanSession = { kind: 'reviewing', documentId, pageId: 'page-1' };
const cancelled: ScanSession = { kind: 'cancelled', documentId };
const failed: ScanSession = {
  kind: 'failed',
  documentId,
  operation: { kind: 'render', pageId: 'page-1' },
  error: { code: 'unavailable' },
};
const completed: ScanSession = { kind: 'completed', documentId };

describe('scan session transitions', () => {
  it('starts without requesting camera or engine resources', () => {
    expect(createScanSession(documentId)).toEqual(idle);
  });

  it.each<{ from: ScanSession; event: ScanSessionEvent; to: ScanSession }>([
    { from: idle, event: { type: 'start', operationId: 'init-1' }, to: initializing },
    { from: initializing, event: { type: 'initialized', operationId: 'init-1' }, to: ready },
    {
      from: ready,
      event: { type: 'process', pageId: 'page-1', operationId: 'render-1' },
      to: processing,
    },
    { from: processing, event: { type: 'processed', operationId: 'render-1' }, to: reviewing },
    { from: reviewing, event: { type: 'continue' }, to: ready },
    {
      from: reviewing,
      event: { type: 'process', pageId: 'page-1', operationId: 'render-1' },
      to: processing,
    },
    { from: reviewing, event: { type: 'finish', pageCount: 1 }, to: completed },
    { from: cancelled, event: { type: 'start', operationId: 'init-1' }, to: initializing },
    { from: failed, event: { type: 'start', operationId: 'init-1' }, to: initializing },
  ])('accepts $from.kind → $event.type → $to.kind', ({ from, event, to }) => {
    const before = structuredClone(from);
    expect(transitionScanSession(from, event)).toEqual({ kind: 'accepted', state: to });
    expect(from).toEqual(before);
  });

  it.each([idle, initializing, ready, processing, reviewing])('cancels $kind', (state) => {
    expect(transitionScanSession(state, { type: 'cancel' })).toEqual({
      kind: 'accepted',
      state: cancelled,
    });
  });

  it.each<{ state: ScanSession; event: ScanSessionEvent }>([
    { state: idle, event: { type: 'process', pageId: 'page-1', operationId: 'render-1' } },
    { state: initializing, event: { type: 'finish', pageCount: 1 } },
    { state: processing, event: { type: 'continue' } },
    { state: completed, event: { type: 'start', operationId: 'init-2' } },
    { state: cancelled, event: { type: 'processed', operationId: 'render-1' } },
    { state: completed, event: { type: 'cancel' } },
    { state: ready, event: { type: 'initialized', operationId: 'init-1' } },
  ])('rejects $event.type while $state.kind without changing state', ({ state, event }) => {
    expect(transitionScanSession(state, event)).toEqual({
      kind: 'rejected',
      reason: 'invalid-transition',
      state,
    });
  });

  it('finishes an existing document after processing a page and continuing capture', () => {
    const started = transitionScanSession(ready, {
      type: 'process',
      pageId: 'page-1',
      operationId: 'render-1',
    });
    const rendered = transitionScanSession(started.state, {
      type: 'processed',
      operationId: 'render-1',
    });
    const continued = transitionScanSession(rendered.state, { type: 'continue' });

    expect(continued).toEqual({ kind: 'accepted', state: ready });
    expect(transitionScanSession(continued.state, { type: 'finish', pageCount: 1 })).toEqual({
      kind: 'accepted',
      state: completed,
    });
  });

  it.each([ready, reviewing])('refuses to finish an empty document while $kind', (state) => {
    expect(transitionScanSession(state, { type: 'finish', pageCount: 0 })).toEqual({
      kind: 'rejected',
      reason: 'invalid-transition',
      state,
    });
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'refuses to finish with invalid authoritative page count %s',
    (pageCount) => {
      expect(transitionScanSession(reviewing, { type: 'finish', pageCount })).toEqual({
        kind: 'rejected',
        reason: 'invalid-transition',
        state: reviewing,
      });
    },
  );

  it.each([
    { state: initializing, event: { type: 'initialized', operationId: 'old-init' } },
    { state: processing, event: { type: 'processed', operationId: 'old-render' } },
    {
      state: processing,
      event: { type: 'engine-failed', operationId: 'old-render', error: { code: 'unavailable' } },
    },
  ] satisfies { state: ScanSession; event: ScanSessionEvent }[])(
    'rejects a stale $event.type result',
    ({ state, event }) => {
      expect(transitionScanSession(state, event)).toEqual({
        kind: 'rejected',
        reason: 'stale-operation',
        state,
      });
    },
  );

  it('preserves page identity when rendering fails instead of reporting success', () => {
    expect(
      transitionScanSession(processing, {
        type: 'engine-failed',
        operationId: 'render-1',
        error: { code: 'unavailable' },
      }),
    ).toEqual({ kind: 'accepted', state: failed });
  });

  it('reports initialization failure without inventing a page or ready state', () => {
    expect(
      transitionScanSession(initializing, {
        type: 'engine-failed',
        operationId: 'init-1',
        error: { code: 'timeout' },
      }),
    ).toEqual({
      kind: 'accepted',
      state: {
        kind: 'failed',
        documentId,
        operation: { kind: 'initialize' },
        error: { code: 'timeout' },
      },
    });
  });
});

describe('domain and engine type contracts', () => {
  it('requires cancellation signals for every long engine operation', () => {
    expectTypeOf<Parameters<ScannerEngine['initialize']>>().toEqualTypeOf<[signal: AbortSignal]>();
    expectTypeOf<Parameters<ScannerEngine['detect']>[1]>().toEqualTypeOf<AbortSignal>();
    expectTypeOf<Parameters<ScannerEngine['render']>[1]>().toEqualTypeOf<AbortSignal>();
    expectTypeOf<Extract<ScanSession, { kind: 'processing' }>['pageId']>().toEqualTypeOf<string>();
    expectTypeOf<EditRecipe['rotation']>().toEqualTypeOf<0 | 90 | 180 | 270>();
    expectTypeOf<PageAsset['original']['blob']>().toEqualTypeOf<Blob>();
    expectTypeOf<{ kind: 'processing'; documentId: string }>().not.toExtend<ScanSession>();
    expectTypeOf<{ kind: 'failed'; documentId: string }>().not.toExtend<ScanSession>();
    expectTypeOf<45>().not.toExtend<EditRecipe['rotation']>();
  });

  it('requires the original clockwise orientation for rendering', () => {
    expectTypeOf<RenderPageRequest['orientation']>().toEqualTypeOf<QuarterTurn>();
    expectTypeOf<Omit<RenderPageRequest, 'orientation'>>().not.toExtend<RenderPageRequest>();
    expectTypeOf<45>().not.toExtend<RenderPageRequest['orientation']>();
  });
});
