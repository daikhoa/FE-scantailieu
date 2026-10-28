import { useEffect, useRef, useState } from 'react';
import { apiBlob } from '../account/api-client';
import { PdfPreview } from '../export/PdfPreview';
import { documentApi, type EditableDocument, type StoredDocument } from './document-api';

type DocumentState =
  | { readonly kind: 'loading' | 'editing' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly document: StoredDocument };

export function SavedDocumentScreen({
  id,
  onBack,
  onEdit,
}: {
  readonly id: string;
  readonly onBack: () => void;
  readonly onEdit: (draft: EditableDocument) => void;
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

  const edit = async () => {
    if (state.kind !== 'ready') return;
    const document = state.document;
    const controller = new AbortController();
    operation.current?.abort();
    operation.current = controller;
    setState({ kind: 'editing' });
    try {
      const draft = await documentApi.edit(document, controller.signal);
      if (!controller.signal.aborted) onEdit(draft);
    } catch (failure) {
      if (!controller.signal.aborted)
        setState({
          kind: 'error',
          message: failure instanceof Error ? failure.message : 'Không mở được bản chỉnh sửa.',
        });
    }
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
        pages={document.pages.map((page) => ({ id: page.id, image: page.renderedUrl }))}
        onBack={onBack}
        onEdit={() => {
          void edit();
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
        {state.kind === 'error'
          ? 'Không mở được tài liệu'
          : state.kind === 'editing'
            ? 'Đang mở bản chỉnh sửa'
            : 'Đang mở tài liệu'}
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
        <p role="status">
          {state.kind === 'editing'
            ? 'Đang lấy ảnh gốc và các thay đổi đã lưu…'
            : 'Đang lấy các trang tài liệu đã lưu…'}
        </p>
      )}
    </main>
  );
}
