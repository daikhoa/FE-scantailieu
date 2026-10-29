import { useCallback, useEffect, useRef, type Dispatch } from 'react';
import type { ScanBatchEvent } from '../scanner/scan-batch';
import { documentApi, type StoredDocument, type StoredPage } from './document-api';

/** The editor owns page transfers, so leaving it cancels work without losing ready edits. */
export function useStoredPages(
  document: StoredDocument | undefined,
  dispatch: Dispatch<ScanBatchEvent>,
) {
  const controllers = useRef(new Map<string, AbortController>());
  const queue = useRef<StoredPage[]>([]);
  const running = useRef(false);

  const pump = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      while (queue.current.length) {
        const page = queue.current.shift();
        if (!page) break;
        const controller = controllers.current.get(page.id);
        if (!controller || controller.signal.aborted) continue;
        try {
          const ready = await documentApi.loadPage(page, controller.signal);
          if (controllers.current.get(page.id) === controller)
            dispatch({ type: 'ready', id: page.id, page: ready.page });
        } catch {
          if (controllers.current.get(page.id) === controller)
            dispatch({ type: 'failed', id: page.id });
        } finally {
          controller.abort();
          if (controllers.current.get(page.id) === controller) controllers.current.delete(page.id);
        }
      }
    } finally {
      running.current = false;
    }
  }, [dispatch]);

  const cancelPage = (id: string) => {
    controllers.current.get(id)?.abort();
    controllers.current.delete(id);
    queue.current = queue.current.filter((page) => page.id !== id);
  };
  const cancelAll = useCallback(() => {
    for (const controller of controllers.current.values()) controller.abort();
    controllers.current.clear();
    queue.current = [];
  }, []);

  useEffect(() => {
    if (!document) return;
    for (const page of document.pages) controllers.current.set(page.id, new AbortController());
    queue.current = [...document.pages];
    void pump();
    return cancelAll;
  }, [document, pump, cancelAll]);

  const retry = (id: string) => {
    const page = document?.pages.find((page) => page.id === id);
    if (!page || controllers.current.has(id)) return;
    dispatch({ type: 'retry', id });
    controllers.current.set(id, new AbortController());
    queue.current.unshift(page);
    void pump();
  };
  return { cancelPage, cancelAll, retry };
}
