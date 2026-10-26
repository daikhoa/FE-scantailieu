import { useEffect, useMemo, useRef, useState } from 'react';
import { downloadBlob } from '../export/download-blob';
import { createImagePdf } from '../export/image-pdf';
import {
  COMPARISON_LABELS,
  median,
  type ComparisonEngine,
  type ComparisonResult,
} from './comparison-contract';
export type MeasuredResult = ComparisonResult & {
  readonly frameGapsOver50ms: number;
  readonly maximumFrameGapMs: number;
};
const LABELS = COMPARISON_LABELS;
const ms = (value: number | null) => (value === null ? 'Chưa có' : `${value.toFixed(1)} ms`);
const mib = (value: number) => `${(value / 1048576).toFixed(1)} MiB`;

function ResultImage({
  result,
  zoom,
  scrollRef,
  onScroll,
}: {
  readonly result: MeasuredResult;
  readonly zoom: number;
  readonly scrollRef: (node: HTMLDivElement | null) => void;
  readonly onScroll: () => void;
}) {
  const url = useMemo(() => URL.createObjectURL(result.image.blob), [result.image.blob]);
  useEffect(
    () => () => {
      URL.revokeObjectURL(url);
    },
    [url],
  );
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => () => lifetime.current?.abort(), []);
  return (
    <article className="comparison-result">
      <h2>{LABELS[result.engine]}</h2>
      {result.filter === 'shadow-removal' && <p>Khử bóng AI · GCNet</p>}
      <p>
        {result.image.dimensions.width} × {result.image.dimensions.height} · PNG không mất dữ liệu
      </p>
      <div
        className="comparison-image"
        ref={scrollRef}
        onScroll={onScroll}
        tabIndex={0}
        role="region"
        aria-label={`Phóng to kết quả ${LABELS[result.engine]}`}
      >
        <img
          src={url}
          alt={`Kết quả ${LABELS[result.engine]}`}
          style={{ width: `${String(zoom * 100)}%` }}
        />
      </div>
      <div className="comparison-actions">
        <button
          onClick={() => {
            downloadBlob(result.image.blob, `scan-${result.engine}.png`);
          }}
        >
          Tải ảnh PNG
        </button>
        <button
          disabled={exporting}
          onClick={() => {
            setExporting(true);
            setError('');
            const controller = new AbortController();
            lifetime.current = controller;
            void createImagePdf([result.image], controller.signal)
              .then((blob) => {
                if (!controller.signal.aborted) downloadBlob(blob, `scan-${result.engine}.pdf`);
              })
              .catch(() => {
                if (!controller.signal.aborted) setError('Chưa xuất được PDF. Hãy thử lại.');
              })
              .finally(() => {
                if (!controller.signal.aborted) setExporting(false);
              });
          }}
        >
          {exporting ? 'Đang tạo PDF…' : 'Tải PDF'}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      <dl className="comparison-metrics">
        <div>
          <dt>Khởi động worker / bộ xử lý</dt>
          <dd>{ms(result.setupMs)}</dd>
        </div>
        <div>
          <dt>Lần đầu: giải mã → ảnh PNG</dt>
          <dd>{ms(result.samples[0]?.totalMs ?? null)}</dd>
        </div>
        <div>
          <dt>Trung vị các lần sau</dt>
          <dd>{ms(median(result.samples.slice(1).map((s) => s.totalMs)))}</dd>
        </div>
        <div>
          <dt>Riêng cắt + bộ lọc (trung vị)</dt>
          <dd>{ms(median(result.samples.map((s) => s.processMs)))}</dd>
        </div>
        <div>
          <dt>Tổng lượt, gồm khởi động / trao đổi</dt>
          <dd>{ms(result.wallMs)}</dd>
        </div>
        <div>
          <dt>Khoảng khung hình UI &gt; 50 ms</dt>
          <dd>
            {result.frameGapsOver50ms} · lớn nhất {ms(result.maximumFrameGapMs)}
          </dd>
        </div>
        <div>
          <dt>Buffer ảnh vào / ra đã biết</dt>
          <dd>
            {mib(result.samples[0]?.inputPixelBytes ?? 0)} /{' '}
            {mib(result.samples[0]?.outputPixelBytes ?? 0)}
          </dd>
        </div>
        <div>
          <dt>Bộ nhớ WASM của bước cắt C++</dt>
          <dd>
            {result.engine !== 'web'
              ? mib(Math.max(...result.samples.map((s) => s.wasmReservedBytes ?? 0)))
              : 'Không áp dụng'}
          </dd>
        </div>
      </dl>
      <p className="comparison-note">
        Các buffer và vùng nhớ WASM không phải tổng RAM cao nhất của trình duyệt; chưa đo RAM của
        model AI. Không cộng hai số này để suy ra tổng RAM.
      </p>
    </article>
  );
}

export function ComparisonResults({
  results,
  zoom,
}: {
  readonly results: Partial<Record<ComparisonEngine, MeasuredResult>>;
  readonly zoom: number;
}) {
  const surfaces = useRef<Record<ComparisonEngine, HTMLDivElement | null>>({
    web: null,
    cpp: null,
  });
  const synchronize = (engine: ComparisonEngine) => {
    const source = surfaces.current[engine];
    if (!source) return;
    for (const target of Object.values(surfaces.current)) {
      if (!target || target === source) continue;
      const x =
        (source.scrollLeft / Math.max(1, source.scrollWidth - source.clientWidth)) *
        (target.scrollWidth - target.clientWidth);
      const y =
        (source.scrollTop / Math.max(1, source.scrollHeight - source.clientHeight)) *
        (target.scrollHeight - target.clientHeight);
      if (Math.abs(target.scrollLeft - x) > 1) target.scrollLeft = x;
      if (Math.abs(target.scrollTop - y) > 1) target.scrollTop = y;
    }
  };
  return (
    <div className="comparison-results">
      {(['web', 'cpp'] as const).map((engine) => {
        const result = results[engine];
        return result ? (
          <ResultImage
            key={engine}
            result={result}
            zoom={zoom}
            scrollRef={(node) => {
              surfaces.current[engine] = node;
            }}
            onScroll={() => {
              synchronize(engine);
            }}
          />
        ) : null;
      })}
    </div>
  );
}
