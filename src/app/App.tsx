import { useEffect, useRef, useState } from 'react';

import { CameraScreen } from '../features/camera/CameraScreen';
import { createCameraService, type CameraService } from '../features/camera/camera-service';
import type { ImageImporter, ImportedImage } from '../features/camera/image-import';
import { DocumentEditor } from '../features/editor/DocumentEditor';
import type { ImageAssetFrameSource } from '../features/scanner/image-asset-frame-source';
import type { ScannerEngine } from '../imaging/contracts/scanner-engine';

export type LibraryState =
  | { readonly kind: 'empty' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string };

interface AppProps {
  readonly libraryState?: LibraryState;
  readonly onRetryLibrary?: () => void;
  readonly cameraService?: CameraService;
  readonly imageImporter?: ImageImporter;
  readonly editorEngineFactory?: () => ScannerEngine;
  readonly editorFrameSource?: ImageAssetFrameSource;
}

type AppView = 'library' | 'scan-intro' | 'editor';

const EMPTY_LIBRARY: LibraryState = { kind: 'empty' };

function PrivacyNotice() {
  return (
    <aside className="privacy-notice" aria-label="Quyền riêng tư">
      <span className="privacy-notice__icon" aria-hidden="true">
        ✓
      </span>
      <div>
        <strong>Xử lý ngay trên thiết bị</strong>
        <span>Ảnh không được tải lên máy chủ.</span>
      </div>
    </aside>
  );
}

function LibraryContent({
  state,
  onRetry,
}: {
  readonly state: LibraryState;
  readonly onRetry: (() => void) | undefined;
}) {
  if (state.kind === 'loading') {
    return (
      <div className="library-state library-state--loading" role="status" aria-live="polite">
        <div className="document-placeholder" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <p>Đang mở thư viện tài liệu…</p>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="library-state library-state--error" role="alert">
        <span className="library-state__symbol" aria-hidden="true">
          !
        </span>
        <div>
          <h3>Không thể mở thư viện</h3>
          <p>{state.message}</p>
          {onRetry === undefined ? null : (
            <button className="text-button" type="button" onClick={onRetry}>
              Thử mở lại thư viện
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="library-state library-state--empty">
      <div className="empty-document" aria-hidden="true">
        <span className="empty-document__corner empty-document__corner--top" />
        <span className="empty-document__line" />
        <span className="empty-document__line empty-document__line--short" />
        <span className="empty-document__corner empty-document__corner--bottom" />
      </div>
      <div>
        <h3>Chưa có tài liệu nào</h3>
        <p>Bản scan và ảnh gốc sẽ xuất hiện tại đây để bạn có thể tiếp tục chỉnh sửa.</p>
      </div>
    </div>
  );
}

export function App({
  libraryState = EMPTY_LIBRARY,
  onRetryLibrary,
  cameraService,
  imageImporter,
  editorEngineFactory,
  editorFrameSource,
}: AppProps) {
  const [view, setView] = useState<AppView>('library');
  const [editorImage, setEditorImage] = useState<ImportedImage | null>(null);
  const [resolvedCameraService] = useState(() => cameraService ?? createCameraService());
  const viewHeadingRef = useRef<HTMLHeadingElement>(null);
  const shouldMoveFocus = useRef(false);

  useEffect(() => {
    if (shouldMoveFocus.current) {
      shouldMoveFocus.current = false;
      viewHeadingRef.current?.focus();
    }
  }, [view]);

  const navigateTo = (nextView: AppView) => {
    shouldMoveFocus.current = true;
    setView(nextView);
  };

  const isLibrary = view === 'library';

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Chuyển đến nội dung chính
      </a>

      <header className="top-bar">
        <div className="brand" aria-label="clonecamscanner, bản dùng nội bộ">
          <span className="brand__mark" aria-hidden="true">
            <i />
          </span>
          <span className="brand__name">clonecamscanner</span>
          <span className="brand__badge">Nội bộ</span>
        </div>
        <span className="local-status">
          <span aria-hidden="true" />
          Cục bộ
        </span>
      </header>

      {isLibrary ? (
        <main id="main-content" className="app-main" aria-label="clonecamscanner">
          <section className="hero" aria-labelledby="library-page-title">
            <p className="eyebrow">Tài liệu rõ hơn · OCR chính xác hơn</p>
            <h1 id="library-page-title" ref={viewHeadingRef} tabIndex={-1}>
              Scan rõ từng nét. <span>PDF sẵn sàng cho OCR.</span>
            </h1>
            <p className="hero__description">
              Căn thẳng tài liệu, giữ nguyên tỷ lệ và tăng độ rõ mà không làm thay đổi nội dung gốc.
            </p>
            <button
              className="primary-action"
              type="button"
              onClick={() => {
                navigateTo('scan-intro');
              }}
              aria-label="Bắt đầu quét"
            >
              <span className="primary-action__icon" aria-hidden="true">
                <i />
              </span>
              <span>
                <strong>Bắt đầu quét</strong>
                <small>Bạn tự bấm chụp từng trang</small>
              </span>
              <span className="primary-action__arrow" aria-hidden="true">
                →
              </span>
            </button>
          </section>

          <PrivacyNotice />

          <section className="library" aria-labelledby="library-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Thư viện của bạn</p>
                <h2 id="library-title">Tài liệu gần đây</h2>
              </div>
              <span className="document-count" aria-label="Không có tài liệu">
                0 tài liệu
              </span>
            </div>
            <LibraryContent state={libraryState} onRetry={onRetryLibrary} />
          </section>
        </main>
      ) : view === 'scan-intro' ? (
        <CameraScreen
          service={resolvedCameraService}
          headingRef={viewHeadingRef}
          {...(imageImporter === undefined ? {} : { importer: imageImporter })}
          onImageImported={(image) => {
            setEditorImage(image);
            navigateTo('editor');
          }}
          onBack={() => {
            navigateTo('library');
          }}
        />
      ) : editorImage === null ? null : (
        <DocumentEditor
          image={editorImage}
          headingRef={viewHeadingRef}
          {...(editorEngineFactory === undefined ? {} : { engineFactory: editorEngineFactory })}
          {...(editorFrameSource === undefined ? {} : { frameSource: editorFrameSource })}
          onBack={() => {
            setEditorImage(null);
            navigateTo('scan-intro');
          }}
        />
      )}

      <footer className="app-footer">
        <span>Không tài khoản</span>
        <span aria-hidden="true">·</span>
        <span>Không cloud</span>
        <span aria-hidden="true">·</span>
        <span>PDF giữ đúng tỷ lệ</span>
      </footer>
    </div>
  );
}
