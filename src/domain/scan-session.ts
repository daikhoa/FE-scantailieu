import type { ProcessingFailure } from './document';

/** IDs reference durable data; this pure state machine never owns image or engine resources. */
export type ScanSession = { readonly documentId: string } & (
  | { readonly kind: 'idle' }
  | { readonly kind: 'initializing'; readonly operationId: string }
  | { readonly kind: 'ready' }
  | { readonly kind: 'processing'; readonly operationId: string; readonly pageId: string }
  | { readonly kind: 'reviewing'; readonly pageId: string }
  | {
      readonly kind: 'failed';
      readonly operation:
        { readonly kind: 'initialize' } | { readonly kind: 'render'; readonly pageId: string };
      readonly error: ProcessingFailure;
    }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'completed' }
);

/** Operation IDs must be unique per invocation, including retries within one session. */
export type ScanSessionEvent =
  | { readonly type: 'start'; readonly operationId: string }
  | { readonly type: 'initialized'; readonly operationId: string }
  | { readonly type: 'process'; readonly operationId: string; readonly pageId: string }
  | { readonly type: 'processed'; readonly operationId: string }
  | {
      readonly type: 'engine-failed';
      readonly operationId: string;
      readonly error: ProcessingFailure;
    }
  | { readonly type: 'continue' }
  | {
      readonly type: 'finish';
      /** Current authoritative persisted-page count supplied by the coordinator. */
      readonly pageCount: number;
    }
  | { readonly type: 'cancel' };

export type ScanSessionTransition =
  | { readonly kind: 'accepted'; readonly state: ScanSession }
  | {
      readonly kind: 'rejected';
      readonly reason: 'invalid-transition' | 'stale-operation';
      readonly state: ScanSession;
    };

export function createScanSession(documentId: string): ScanSession {
  return { kind: 'idle', documentId };
}

/**
 * The coordinator must abort the current operation and dispose its resources on cancel.
 * Rejecting late completions prevents resurrection; it does not itself cancel async work.
 */
export function transitionScanSession(
  state: ScanSession,
  event: ScanSessionEvent,
): ScanSessionTransition {
  const { documentId } = state;
  const accept = (next: ScanSession): ScanSessionTransition => ({ kind: 'accepted', state: next });

  if (
    (event.type === 'initialized' ||
      event.type === 'processed' ||
      event.type === 'engine-failed') &&
    (state.kind === 'initializing' || state.kind === 'processing') &&
    state.operationId !== event.operationId
  ) {
    return { kind: 'rejected', reason: 'stale-operation', state };
  }

  switch (event.type) {
    case 'start':
      if (state.kind === 'idle' || state.kind === 'failed' || state.kind === 'cancelled') {
        return accept({ kind: 'initializing', documentId, operationId: event.operationId });
      }
      break;
    case 'initialized':
      if (state.kind === 'initializing') return accept({ kind: 'ready', documentId });
      break;
    case 'process':
      if (state.kind === 'ready' || state.kind === 'reviewing') {
        return accept({
          kind: 'processing',
          documentId,
          pageId: event.pageId,
          operationId: event.operationId,
        });
      }
      break;
    case 'processed':
      if (state.kind === 'processing') {
        return accept({ kind: 'reviewing', documentId, pageId: state.pageId });
      }
      break;
    case 'engine-failed':
      if (state.kind === 'initializing' || state.kind === 'processing') {
        return accept({
          kind: 'failed',
          documentId,
          operation:
            state.kind === 'initializing'
              ? { kind: 'initialize' }
              : { kind: 'render', pageId: state.pageId },
          error: event.error,
        });
      }
      break;
    case 'continue':
      if (state.kind === 'reviewing') return accept({ kind: 'ready', documentId });
      break;
    case 'finish':
      if (
        (state.kind === 'ready' || state.kind === 'reviewing') &&
        Number.isSafeInteger(event.pageCount) &&
        event.pageCount > 0
      ) {
        return accept({ kind: 'completed', documentId });
      }
      break;
    case 'cancel':
      if (state.kind !== 'cancelled' && state.kind !== 'completed' && state.kind !== 'failed') {
        return accept({ kind: 'cancelled', documentId });
      }
      break;
  }

  return { kind: 'rejected', reason: 'invalid-transition', state };
}
