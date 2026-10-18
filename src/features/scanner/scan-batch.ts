import type { ProcessedScanPage } from './background-page-processor';

interface ScanPageIdentity {
  readonly id: string;
  readonly source: Blob;
}

export type ScanBatchPage = ScanPageIdentity &
  (
    | { readonly kind: 'queued' }
    | { readonly kind: 'processing' }
    | { readonly kind: 'ready'; readonly page: ProcessedScanPage }
    | { readonly kind: 'failed' }
  );

export interface ScanBatchState {
  readonly pages: readonly ScanBatchPage[];
}

export type ScanBatchEvent =
  | {
      readonly type: 'captured';
      readonly id: string;
      readonly source: Blob;
    }
  | {
      readonly type: 'replaced';
      readonly id: string;
      readonly replacementId: string;
      readonly source: Blob;
    }
  | { readonly type: 'started'; readonly id: string }
  | { readonly type: 'ready'; readonly id: string; readonly page: ProcessedScanPage }
  | { readonly type: 'updated'; readonly id: string; readonly page: ProcessedScanPage }
  | { readonly type: 'failed'; readonly id: string }
  | { readonly type: 'retry'; readonly id: string }
  | { readonly type: 'removed'; readonly id: string }
  | { readonly type: 'reset' };

function updatePage(
  state: ScanBatchState,
  id: string,
  update: (page: ScanBatchPage) => ScanBatchPage,
): ScanBatchState {
  if (!state.pages.some((page) => page.id === id)) return state;
  return {
    pages: state.pages.map((page) => (page.id === id ? update(page) : page)),
  };
}

export function scanBatchReducer(state: ScanBatchState, event: ScanBatchEvent): ScanBatchState {
  switch (event.type) {
    case 'captured':
      if (event.id.length === 0 || state.pages.some((page) => page.id === event.id)) return state;
      return {
        pages: [
          ...state.pages,
          {
            id: event.id,
            source: event.source,
            kind: 'queued',
          },
        ],
      };
    case 'replaced':
      if (
        event.replacementId.length === 0 ||
        state.pages.some((page) => page.id === event.replacementId)
      ) {
        return state;
      }
      return updatePage(state, event.id, () => ({
        id: event.replacementId,
        source: event.source,
        kind: 'queued',
      }));
    case 'started':
      return updatePage(state, event.id, (page) =>
        page.kind === 'queued'
          ? {
              id: page.id,
              source: page.source,
              kind: 'processing',
            }
          : page,
      );
    case 'ready':
      return updatePage(state, event.id, (page) =>
        page.kind === 'queued' || page.kind === 'processing'
          ? {
              id: page.id,
              source: page.source,
              kind: 'ready',
              page: event.page,
            }
          : page,
      );
    case 'updated':
      return updatePage(state, event.id, (page) =>
        page.kind === 'ready' ? { ...page, page: event.page } : page,
      );
    case 'failed':
      return updatePage(state, event.id, (page) =>
        page.kind === 'queued' || page.kind === 'processing'
          ? {
              id: page.id,
              source: page.source,
              kind: 'failed',
            }
          : page,
      );
    case 'retry':
      return updatePage(state, event.id, (page) =>
        page.kind === 'failed'
          ? {
              id: page.id,
              source: page.source,
              kind: 'queued',
            }
          : page,
      );
    case 'removed':
      return { pages: state.pages.filter((page) => page.id !== event.id) };
    case 'reset':
      return state.pages.length === 0 ? state : { pages: [] };
  }
}

export function scanBatchStatus(state: ScanBatchState): {
  readonly total: number;
  readonly processing: number;
  readonly failed: number;
} {
  let processing = 0;
  let failed = 0;
  for (const page of state.pages) {
    if (page.kind === 'queued' || page.kind === 'processing') processing++;
    if (page.kind === 'failed') failed++;
  }
  return { total: state.pages.length, processing, failed };
}
