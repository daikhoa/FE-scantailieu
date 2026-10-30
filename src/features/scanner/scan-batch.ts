import type { RgbaBackendInput } from '../../imaging/engines/scanic-backend-contract';
import type { ProcessedScanPage, ScanPageSource } from './background-page-processor';

interface ScanPageIdentity {
  readonly modified?: boolean;
  readonly id: string;
  readonly source: ScanPageSource;
  readonly preview?: RgbaBackendInput;
}

export type ScanBatchPage =
  | (ScanPageIdentity &
      (
        | { readonly kind: 'queued' }
        | { readonly kind: 'processing' }
        | { readonly kind: 'ready'; readonly page: ProcessedScanPage }
        | { readonly kind: 'failed' }
      ))
  | ({
      readonly id: string;
      readonly previewUrl: string;
      readonly preview?: never;
      readonly source?: never;
    } & ({ readonly kind: 'loading-saved' } | { readonly kind: 'failed-saved' }));

export interface ScanBatchState {
  readonly pages: readonly ScanBatchPage[];
}

export type ScanBatchEvent =
  | {
      readonly type: 'captured';
      readonly id: string;
      readonly source: ScanPageSource;
    }
  | {
      readonly type: 'replaced';
      readonly id: string;
      readonly replacementId: string;
      readonly source: ScanPageSource;
    }
  | { readonly type: 'started'; readonly id: string }
  | { readonly type: 'source-saved'; readonly id: string; readonly source: Blob }
  | { readonly type: 'ready'; readonly id: string; readonly page: ProcessedScanPage }
  | { readonly type: 'updated'; readonly id: string; readonly page: ProcessedScanPage }
  | { readonly type: 'failed'; readonly id: string }
  | { readonly type: 'retry'; readonly id: string }
  | { readonly type: 'removed'; readonly id: string }
  | { readonly type: 'reordered'; readonly ids: readonly string[] }
  | { readonly type: 'rebased'; readonly pages: readonly ScanBatchPage[] }
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
    case 'rebased':
      return {
        pages: event.pages.map((page) => {
          const current = state.pages.find(
            (current) => current.id === page.id && current.kind === 'ready',
          );
          return current ? { ...current, modified: false } : page;
        }),
      };
    case 'reordered': {
      if (event.ids.length !== state.pages.length || new Set(event.ids).size !== event.ids.length)
        return state;
      const byId = new Map(state.pages.map((page) => [page.id, page]));
      if (event.ids.some((id) => !byId.has(id))) return state;
      if (event.ids.every((id, index) => state.pages[index]?.id === id)) return state;
      return {
        pages: event.ids.flatMap((id) => {
          const page = byId.get(id);
          return page ? [page] : [];
        }),
      };
    }
    case 'source-saved':
      return updatePage(state, event.id, (page) =>
        page.kind === 'loading-saved' || page.kind === 'failed-saved'
          ? page
          : { ...page, source: event.source },
      );
    case 'captured':
      if (event.id.length === 0 || state.pages.some((page) => page.id === event.id)) return state;
      return {
        pages: [
          ...state.pages,
          {
            id: event.id,
            source: event.source,
            ...(!(event.source instanceof Blob) && event.source.preview !== undefined
              ? { preview: event.source.preview }
              : {}),
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
        ...(!(event.source instanceof Blob) && event.source.preview !== undefined
          ? { preview: event.source.preview }
          : {}),
        kind: 'queued',
      }));
    case 'started':
      return updatePage(state, event.id, (page) =>
        page.kind === 'queued'
          ? {
              id: page.id,
              source: page.source,
              kind: 'processing',
              ...(page.preview === undefined ? {} : { preview: page.preview }),
            }
          : page,
      );
    case 'ready':
      return updatePage(state, event.id, (page) =>
        page.kind === 'queued' || page.kind === 'processing' || page.kind === 'loading-saved'
          ? {
              id: page.id,
              // The durable JPEG replaces the much larger captured RGBA buffer once processing
              // succeeds. Failed pages retain their original source so retry remains possible.
              source: event.page.original.blob,
              kind: 'ready',
              page: event.page,
            }
          : page,
      );
    case 'updated':
      return updatePage(state, event.id, (page) =>
        page.kind === 'ready' ? { ...page, modified: true, page: event.page } : page,
      );
    case 'failed':
      return updatePage(state, event.id, (page) =>
        page.kind === 'loading-saved'
          ? { ...page, kind: 'failed-saved' }
          : page.kind === 'queued' || page.kind === 'processing'
            ? {
                id: page.id,
                source: page.source,
                kind: 'failed',
              }
            : page,
      );
    case 'retry':
      return updatePage(state, event.id, (page) =>
        page.kind === 'failed-saved'
          ? { ...page, kind: 'loading-saved' }
          : page.kind === 'failed'
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
    if (page.kind === 'queued' || page.kind === 'processing' || page.kind === 'loading-saved')
      processing++;
    if (page.kind === 'failed' || page.kind === 'failed-saved') failed++;
  }
  return { total: state.pages.length, processing, failed };
}
