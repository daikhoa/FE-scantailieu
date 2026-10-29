import { useEffect, useRef, useState } from 'react';
import { apiBlob } from '../account/api-client';
import { PdfPreview } from '../export/PdfPreview';
import { documentApi, type EditableDocument, type StoredDocument } from './document-api';

type DocumentState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly document: StoredDocument };

export function SavedDocumentScreen({
  id,
  onBack,
  onEdit,
  onRenamed,
}: {
  readonly id: string;
  readonly onBack: () => void;
  readonly onEdit: (draft: EditableDocument) => void;
  readonly onRenamed?: () => void;
}) {
  const [state, setState] = useState<DocumentState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const operation = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    operation.current = controller;
    void documentApi
      .get(id, controller.signal)
      .then((document) => {
        if (!controller.signal.aborted) setState({ kind: 'ready', document });
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setState({
            kind: 'error',
            message: failure instanceof Error ? failure.message : 'Không mở được tài liệu.',
          });
      });
    return () => {
      controller.abort();
      operation.current?.abort();
    };
  }, [id, attempt]);
  useEffect(() => {
    heading.current?.focus();
  }, [state.kind]);

  const edit = () => {
    if (state.kind !== 'ready') return;
    onEdit(documentApi.draft(state.document));
  };
  if (state.kind === 'ready') {
    const document = state.document;
    return (
      <PdfPreview
        key={document.id}
        name={document.name}
        fileUrl={document.pdfUrl}
        loadPdf={(signal) => apiBlob(document.pdfUrl, signal)}
        saved
        onSave={async (name, signal) => {
          const renamed = await documentApi.rename(document, name, signal);
          if (!signal.aborted) {
            setState({ kind: 'ready', document: { ...document, ...renamed } });
            onRenamed?.();
          }
        }}
        pages={document.pages.map((page) => ({ id: page.id, image: page.renderedUrl }))}
        onBack={onBack}
        onEdit={() => {
          edit();
        }}
      />
    );
  }
  return (
    <main id="main-content" className="app-main pdf-workspace">
      <button type="button" className="back-button" onClick={onBack}>
        ← Kho tài liệu
      </button>
      <h1 ref={heading} tabIndex={-1}>
        {state.kind === 'error' ? 'Không mở được tài liệu' : 'Đang mở tài liệu'}
      </h1>
      {state.kind === 'error' ? (
        <>
          <p role="alert" className="editor__error">
            {state.message}
          </p>
          <button
            type="button"
            onClick={() => {
              setState({ kind: 'loading' });
              setAttempt((previous) => previous + 1);
            }}
          >
            Thử mở lại tài liệu
          </button>
        </>
      ) : (
        <p role="status">Đang lấy các trang tài liệu đã lưu…</p>
      )}
    </main>
  );
}
