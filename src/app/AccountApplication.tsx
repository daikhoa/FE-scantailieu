import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { accountApi, ApiError, apiBlob, type Account } from '../features/account/api-client';
import { AuthScreen, type AuthMode } from '../features/account/AuthScreen';
import {
  documentApi,
  type EditableDocument,
  type StoredDocument,
} from '../features/library/document-api';
import { PdfPreview } from '../features/export/PdfPreview';
import { App, type LibraryState } from './App';

interface SelectedDocument {
  readonly document: StoredDocument;
  readonly pdf: Blob;
}

export function AccountApplication({ comparison }: { readonly comparison?: ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [checking, setChecking] = useState(true);
  const [connectionError, setConnectionError] = useState('');
  const [library, setLibrary] = useState<LibraryState>({ kind: 'loading' });
  const [selected, setSelected] = useState<SelectedDocument | null>(null);
  const [editing, setEditing] = useState<EditableDocument | undefined>(undefined);
  const [opening, setOpening] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const activeOperation = useRef<AbortController | null>(null);
  const listingOperation = useRef<AbortController | null>(null);

  const refreshLibrary = useCallback(async (offset = 0) => {
    listingOperation.current?.abort();
    const controller = new AbortController();
    listingOperation.current = controller;
    if (offset === 0) setLibrary({ kind: 'loading' });
    else
      setLibrary((previous) =>
        previous.kind === 'ready' ? { ...previous, loadingMore: true } : previous,
      );
    try {
      const listing = await documentApi.list(offset, controller.signal);
      if (controller.signal.aborted) return;
      setLibrary((previous) =>
        listing.total === 0
          ? { kind: 'empty' }
          : {
              kind: 'ready',
              total: listing.total,
              items:
                offset > 0 && previous.kind === 'ready'
                  ? [...previous.items, ...listing.items]
                  : listing.items,
            },
      );
    } catch (failure) {
      if (!controller.signal.aborted)
        setLibrary({
          kind: 'error',
          message: failure instanceof Error ? failure.message : 'Không mở được kho tài liệu.',
        });
    }
  }, []);

  const checkSession = useCallback(
    (signal?: AbortSignal) =>
      accountApi
        .me(signal)
        .then((current) => {
          if (signal?.aborted) return;
          setAccount(current);
          void refreshLibrary();
        })
        .catch((failure: unknown) => {
          if (signal?.aborted) return;
          if (!(failure instanceof ApiError && failure.status === 401))
            setConnectionError(
              failure instanceof Error ? failure.message : 'Không kết nối được máy chủ.',
            );
        })
        .finally(() => {
          if (!signal?.aborted) setChecking(false);
        }),
    [refreshLibrary],
  );

  useEffect(() => {
    const controller = new AbortController();
    void checkSession(controller.signal);
    return () => {
      controller.abort();
      activeOperation.current?.abort();
      listingOperation.current?.abort();
    };
  }, [checkSession]);
  const authenticate = async (mode: AuthMode, email: string, password: string) => {
    if (mode === 'register') await accountApi.register(email, password);
    setAccount(await accountApi.login(email, password));
    void refreshLibrary();
  };

  const openDocument = async (id: string) => {
    activeOperation.current?.abort();
    const controller = new AbortController();
    activeOperation.current = controller;
    setOpening(true);
    setError('');
    try {
      const document = await documentApi.get(id, controller.signal);
      const pdf = await apiBlob(document.pdfUrl, controller.signal);
      if (!controller.signal.aborted) {
        setSelected({ document, pdf });
        setEditing(undefined);
      }
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : 'Không mở được tài liệu.');
    } finally {
      if (!controller.signal.aborted) setOpening(false);
    }
  };

  const editSelected = async () => {
    if (!selected || opening) return;
    const controller = new AbortController();
    activeOperation.current?.abort();
    activeOperation.current = controller;
    setOpening(true);
    setError('');
    try {
      const draft = await documentApi.edit(selected.document, controller.signal);
      if (!controller.signal.aborted) {
        setEditing(draft);
        setSelected(null);
      }
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : 'Không mở được bản chỉnh sửa.');
    } finally {
      if (!controller.signal.aborted) setOpening(false);
    }
  };

  const logout = async () => {
    if (dirty && !window.confirm('Tài liệu có thay đổi chưa lưu. Bạn vẫn muốn đăng xuất?')) return;
    try {
      await accountApi.logout();
      activeOperation.current?.abort();
      listingOperation.current?.abort();
      setAccount(null);
      setSelected(null);
      setEditing(undefined);
      setDirty(false);
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Chưa đăng xuất được.');
    }
  };

  if (checking)
    return (
      <main id="main-content" className="account-screen">
        <p role="status">Đang kiểm tra phiên đăng nhập…</p>
      </main>
    );
  if (connectionError)
    return (
      <main id="main-content" className="account-screen">
        <div>
          <p role="alert">{connectionError}</p>
          <button
            className="primary-button"
            type="button"
            onClick={() => {
              setChecking(true);
              setConnectionError('');
              void checkSession();
            }}
          >
            Kết nối lại
          </button>
        </div>
      </main>
    );
  if (!account) return <AuthScreen onAuthenticate={authenticate} />;

  return (
    <>
      <div className="account-toolbar">
        <span>{account.email}</span>
        <button
          className="text-button"
          type="button"
          disabled={opening}
          onClick={() => void logout()}
        >
          Đăng xuất
        </button>
      </div>
      {error && (
        <p className="editor__error" role="alert">
          {error}
        </p>
      )}
      {opening && (
        <p className="editor__status" role="status">
          Đang mở tài liệu…
        </p>
      )}
      {comparison ??
        (selected ? (
          <PdfPreview
            pdf={selected.pdf}
            name={selected.document.name}
            fileUrl={selected.document.pdfUrl}
            saved
            pages={selected.document.pages.map((page) => ({
              id: page.id,
              image: page.renderedUrl,
            }))}
            onBack={() => {
              activeOperation.current?.abort();
              setOpening(false);
              setSelected(null);
              setError('');
            }}
            onEdit={() => void editSelected()}
          />
        ) : (
          <App
            key={editing?.document.id ?? 'new'}
            {...(editing ? { initialDocument: editing } : {})}
            libraryState={library}
            onRetryLibrary={() => void refreshLibrary()}
            onOpenDocument={(id) => {
              if (!opening) void openDocument(id);
            }}
            onLoadMoreLibrary={() => {
              if (library.kind === 'ready' && !library.loadingMore)
                void refreshLibrary(library.items.length);
            }}
            onDirtyChange={setDirty}
            onSaveDocument={async (pages, pdf, name, existing, signal) => {
              const document = await documentApi.save(pages, pdf, name, existing, signal);
              void refreshLibrary();
              return document;
            }}
          />
        ))}
    </>
  );
}
