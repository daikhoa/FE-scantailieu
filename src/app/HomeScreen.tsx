import type { Ref } from 'react';
import { RASTER_MIME_TYPES } from '../imaging/codecs/raster-metadata';
import './HomeScreen.css';
import type { DocumentSummary } from '../features/library/document-api';

export type LibraryState =
  | { readonly kind: 'empty' }
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'ready';
      readonly items: readonly DocumentSummary[];
      readonly total: number;
      readonly loadingMore?: boolean;
    }
  | { readonly kind: 'error'; readonly message: string };

type HomeIconName = 'scan' | 'image' | 'home' | 'documents' | 'shield';

function HomeIcon({ name }: { readonly name: HomeIconName }) {
  const paths: Record<HomeIconName, string> = {
    scan: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M7 8h10v9H7zM1 12h22',
    image: 'M3 3h18v18H3zM3 17l6-6 4 4 3-3 5 5M16 7h.01',
    home: 'M3 10l9-7 9 7v11h-6v-7H9v7H3z',
    documents: 'M8 3h10l3 3v15H8zM3 6v15M11 9h7m-7 4h7m-7 4h4',
    shield: 'M12 2l8 3v6c0 5-4 9-8 11-4-2-8-6-8-11V5zM8 12l3 3 5-6',
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

function LibraryContent({
  state,
  onRetry,
  onOpen,
  onLoadMore,
}: {
  readonly state: LibraryState;
  readonly onRetry: (() => void) | undefined;
  readonly onOpen: ((id: string) => void) | undefined;
  readonly onLoadMore: (() => void) | undefined;
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

  if (state.kind === 'ready') {
    return (
      <>
        <ul className="document-list" aria-label="Tài liệu đã lưu">
          {state.items.map((document) => (
            <li key={document.id}>
              <button type="button" onClick={() => onOpen?.(document.id)}>
                <span className="document-list__icon" aria-hidden="true">
                  PDF
                </span>
                <span>
                  <strong>{document.name}</strong>
                  <small>
                    {new Date(document.updatedAt).toLocaleDateString('vi-VN')} ·{' '}
                    {document.pageCount} trang
                  </small>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {state.items.length < state.total && (
          <button
            className="text-button"
            type="button"
            disabled={state.loadingMore}
            onClick={onLoadMore}
          >
            {state.loadingMore ? 'Đang tải…' : 'Xem thêm tài liệu'}
          </button>
        )}
      </>
    );
  }

  return (
    <div className="recent-empty">
      <div className="recent-empty__icon">
        <HomeIcon name="documents" />
      </div>
      <h3>Chưa có tài liệu nào</h3>
      <p>Chụp tài liệu hoặc chọn ảnh để bắt đầu bản scan đầu tiên của bạn.</p>
      <div className="recent-outline" aria-hidden="true">
        {[1, 2, 3].map((row) => (
          <div className="recent-outline__row" key={row}>
            <span className="recent-outline__thumbnail">
              <HomeIcon name="documents" />
            </span>
            <span className="recent-outline__details">
              <i />
              <i />
            </span>
            <span className="recent-outline__end" />
          </div>
        ))}
      </div>
      <p className="recent-empty__note">
        Tài liệu đã lưu sẽ xuất hiện tại đây khi bạn đăng nhập lại.
      </p>
    </div>
  );
}

interface HomeScreenProps {
  readonly headingRef: Ref<HTMLHeadingElement>;
  readonly libraryState: LibraryState;
  readonly onRetryLibrary: (() => void) | undefined;
  readonly onCamera: () => void;
  readonly onImport: (sources: readonly File[]) => void;
  readonly importError: string | undefined;
  readonly onOpenDocument?: (id: string) => void;
  readonly onLoadMoreLibrary?: () => void;
}

export function HomeScreen({
  headingRef,
  libraryState,
  onRetryLibrary,
  onCamera,
  onImport,
  importError,
  onOpenDocument,
  onLoadMoreLibrary,
}: HomeScreenProps) {
  return (
    <>
      <main id="main-content" className="home-screen" aria-label="clonecamscanner">
        <section className="home-start" aria-labelledby="library-page-title">
          <div className="home-title">
            <div>
              <p>KHÔNG GIAN CỦA BẠN</p>
              <h1 id="library-page-title" ref={headingRef} tabIndex={-1}>
                Tài liệu của tôi
              </h1>
            </div>
            <span className="home-title__symbol">
              <HomeIcon name="documents" />
            </span>
          </div>
          <div className="home-tools" role="group" aria-label="Chọn cách quét tài liệu">
            <button
              className="home-tool home-tool--scan"
              type="button"
              onClick={onCamera}
              aria-label="Chụp tài liệu"
            >
              <span className="home-tool__icon">
                <HomeIcon name="scan" />
              </span>
              <strong>Chụp tài liệu</strong>
              <small>Quét bằng camera</small>
            </button>
            <label className="home-tool home-tool--image">
              <span className="home-tool__icon">
                <HomeIcon name="image" />
              </span>
              <strong>Dùng ảnh có sẵn</strong>
              <small>Chọn một hoặc nhiều ảnh</small>
              <input
                className="visually-hidden"
                type="file"
                aria-label="Dùng ảnh có sẵn"
                accept={RASTER_MIME_TYPES.join(',')}
                multiple
                onChange={(event) => {
                  const sources = Array.from(event.currentTarget.files ?? []);
                  event.currentTarget.value = '';
                  if (sources.length > 0) onImport(sources);
                }}
              />
            </label>
          </div>
          {importError === undefined ? null : (
            <p className="home-import-error" role="alert">
              {importError}
            </p>
          )}
          <a href="?compare=1" className="home-comparison-link">
            So sánh Web / C++
          </a>
          <aside className="home-privacy" aria-label="Quyền riêng tư">
            <HomeIcon name="shield" />
            <p>
              Ảnh được xử lý trên thiết bị. Khi bạn bấm Lưu, ảnh và PDF được lưu vào tài khoản trên
              máy chủ.{' '}
              <a href="/licenses/" target="_blank" rel="noreferrer">
                Giấy phép phần mềm
              </a>
            </p>
          </aside>
        </section>
        <section className="home-recent" aria-labelledby="library-title">
          <div className="home-recent__heading">
            <h2 id="library-title" tabIndex={-1}>
              Gần đây
            </h2>
            <span>{libraryState.kind === 'ready' ? libraryState.total : 0} tài liệu</span>
          </div>
          <div className="home-recent__columns" aria-hidden="true">
            <span>TÀI LIỆU</span>
            <span>NGÀY TẠO · SỐ TRANG</span>
          </div>
          <LibraryContent
            state={libraryState}
            onRetry={onRetryLibrary}
            onOpen={onOpenDocument}
            onLoadMore={onLoadMoreLibrary}
          />
        </section>
      </main>
      <nav className="home-nav" aria-label="Điều hướng chính">
        <a href="#library-page-title" aria-current="page">
          <HomeIcon name="home" />
          <span>Trang chủ</span>
        </a>
        <button
          type="button"
          onClick={onCamera}
          className="home-nav__camera"
          aria-label="Chụp tài liệu mới"
        >
          <HomeIcon name="scan" />
        </button>
        <a href="#library-title">
          <HomeIcon name="documents" />
          <span>Tài liệu</span>
        </a>
      </nav>
    </>
  );
}
