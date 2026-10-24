import { useEffect, useMemo, useRef, useState } from 'react';
import type { CropRegion } from '../../domain/document';
import { importImage, type ImportedImage } from '../camera/image-import';
import { ManualCropEditor } from '../editor/ManualCropEditor';
import { downloadBlob } from '../export/download-blob';
import { createImagePdf } from '../export/image-pdf';
import { RASTER_MIME_TYPES } from '../../imaging/codecs/raster-metadata';
import { runComparison } from './comparison-client';
import {
  median,
  MAX_COMPARISON_INPUT_PIXELS,
  type ComparisonEngine,
  type ComparisonFilter,
  type ComparisonResult,
} from './comparison-contract';
import './comparison.css';

type MeasuredResult = ComparisonResult & {
  readonly frameGapsOver50ms: number;
  readonly maximumFrameGapMs: number;
};
const LABELS = { web: 'Web hiện tại', cpp: 'C++ WebAssembly' } as const;
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
  readonly scrollRef: React.RefObject<HTMLDivElement | null>;
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
          <dt>Bộ nhớ tuyến tính WASM được cấp</dt>
          <dd>
            {result.engine === 'cpp'
              ? mib(Math.max(...result.samples.map((s) => s.wasmReservedBytes ?? 0)))
              : 'Không áp dụng'}
          </dd>
        </div>
      </dl>
      <p className="comparison-note">
        Các buffer và vùng nhớ WASM không phải tổng RAM cao nhất của trình duyệt. Không cộng hai số
        này để suy ra tổng RAM.
      </p>
    </article>
  );
}

export function ComparisonScreen() {
  const [imported, setImported] = useState<ImportedImage | null>(null);
  const [crop, setCrop] = useState<CropRegion>({ kind: 'full-frame' });
  const [editing, setEditing] = useState(false);
  const [filter, setFilter] = useState<ComparisonFilter>('enhanced-color');
  const [repetitions, setRepetitions] = useState(5);
  const [results, setResults] = useState<Partial<Record<ComparisonEngine, MeasuredResult>>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Chọn ảnh để bắt đầu.');
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(1);
  const [notes, setNotes] = useState('');
  const reverse = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  const webScroll = useRef<HTMLDivElement>(null);
  const cppScroll = useRef<HTMLDivElement>(null);
  useEffect(() => () => lifetime.current?.abort(), []);

  const synchronize = (from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (!from || !to) return;
    const left =
      (from.scrollLeft / Math.max(1, from.scrollWidth - from.clientWidth)) *
      (to.scrollWidth - to.clientWidth);
    const top =
      (from.scrollTop / Math.max(1, from.scrollHeight - from.clientHeight)) *
      (to.scrollHeight - to.clientHeight);
    if (Math.abs(to.scrollLeft - left) > 1) to.scrollLeft = left;
    if (Math.abs(to.scrollTop - top) > 1) to.scrollTop = top;
  };

  const choose = async (file: File) => {
    const controller = new AbortController();
    lifetime.current?.abort();
    lifetime.current = controller;
    setBusy(true);
    setError('');
    setResults({});
    setImported(null);
    setStatus('Đang mở ảnh gốc…');
    try {
      const image = await importImage(file, controller.signal);
      if (controller.signal.aborted) return;
      if (
        image.original.dimensions.width * image.original.dimensions.height >
        MAX_COMPARISON_INPUT_PIXELS
      )
        throw new Error('large');
      setImported(image);
      setCrop({ kind: 'full-frame' });
      setStatus('Ảnh sẵn sàng. Có thể chỉnh cùng một vùng cắt cho cả hai bản.');
    } catch {
      if (!controller.signal.aborted)
        setError(
          'Không mở được ảnh. Khu vực thử nhận ảnh tối đa 50 MP; không tự giảm độ phân giải.',
        );
    } finally {
      if (lifetime.current === controller) {
        setBusy(false);
        if (controller.signal.aborted) setStatus('Đã dừng.');
      }
    }
  };

  const run = async (engines: readonly ComparisonEngine[]) => {
    if (!imported || busy || document.hidden) return;
    const controller = new AbortController();
    lifetime.current = controller;
    setBusy(true);
    setError('');
    setResults((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([key]) => !engines.includes(key as ComparisonEngine)),
      ),
    );
    const visibility = () => {
      if (document.hidden) controller.abort();
    };
    document.addEventListener('visibilitychange', visibility);
    const dimensions = imported.original.dimensions;
    const corners =
      crop.kind === 'document'
        ? crop.corners
        : ([
            { x: 0, y: 0 },
            { x: dimensions.width, y: 0 },
            { x: dimensions.width, y: dimensions.height },
            { x: 0, y: dimensions.height },
          ] as const);
    try {
      for (const engine of engines) {
        if (controller.signal.aborted) break;
        setStatus(`${LABELS[engine]}: đang khởi động…`);
        let previous = performance.now();
        let maximum = 0;
        let gaps = 0;
        let frame = 0;
        const tick = (now: number) => {
          const gap = now - previous;
          maximum = Math.max(maximum, gap);
          if (gap > 50) gaps++;
          previous = now;
          frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        try {
          const result = await runComparison(
            engine,
            { asset: imported.original, corners, filter, repetitions },
            controller.signal,
            (completed) => {
              setStatus(`${LABELS[engine]}: ${String(completed)}/${String(repetitions)} lần.`);
            },
          );
          controller.signal.throwIfAborted();
          setResults((current) => ({
            ...current,
            [engine]: { ...result, frameGapsOver50ms: gaps, maximumFrameGapMs: maximum },
          }));
        } finally {
          cancelAnimationFrame(frame);
        }
      }
      setStatus(
        controller.signal.aborted
          ? 'Đã dừng. Nếu chuyển ứng dụng hoặc khóa màn hình, lượt đo sẽ bị hủy.'
          : 'Đã đo xong. Bộ xử lý đã được đóng để trả bộ nhớ.',
      );
    } catch (cause) {
      if (controller.signal.aborted) setStatus('Đã dừng.');
      else {
        setStatus('Lượt đo chưa hoàn tất.');
        setError(
          cause instanceof Error && cause.message === 'timeout'
            ? 'Lượt đo quá lâu nên đã dừng. Hãy giảm số lần hoặc dùng ảnh khác.'
            : 'Không chạy được bộ xử lý trên thiết bị này, hoặc bộ nhớ không đủ. Không có kết quả thay thế giả lập; hãy thử ít lần hơn hoặc ảnh khác.',
        );
      }
    } finally {
      document.removeEventListener('visibilitychange', visibility);
      setBusy(false);
    }
  };

  return (
    <main className="comparison-screen">
      <header>
        <a href="/">← Về trang chủ</a>
        <p className="eyebrow">Thử nghiệm trên thiết bị</p>
        <h1>So sánh Web và C++</h1>
        <p>
          Cùng ảnh gốc, cùng vùng cắt, đầu ra tối đa 3000 px. Chỉ đo cắt phối cảnh và bộ lọc; giải
          mã, xuất PNG/PDF dùng chung. Không đo AI hay bộ mã hóa của DLL Windows.
        </p>
      </header>
      <section className="comparison-controls" aria-label="Cấu hình so sánh">
        <label className="comparison-file">
          Chọn ảnh gốc
          <input
            type="file"
            accept={RASTER_MIME_TYPES.join(',')}
            disabled={busy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file) void choose(file);
            }}
          />
        </label>
        {imported && (
          <p>
            Ảnh đầu vào: {imported.original.dimensions.width} ×{' '}
            {imported.original.dimensions.height} · {mib(imported.original.blob.size)}
          </p>
        )}
        <div className="comparison-actions">
          <label>
            Bộ lọc
            <select
              value={filter}
              disabled={busy}
              onChange={(event) => {
                setFilter(event.target.value as ComparisonFilter);
                setResults({});
              }}
            >
              <option value="enhanced-color">Tăng cường</option>
              <option value="original">Giữ nguyên màu</option>
            </select>
          </label>
          <label>
            Số lần mỗi bản
            <select
              value={repetitions}
              disabled={busy}
              onChange={(event) => {
                setRepetitions(Number(event.target.value));
                setResults({});
              }}
            >
              <option value={1}>1 lần</option>
              <option value={5}>5 lần</option>
              <option value={20}>20 lần liên tục</option>
            </select>
          </label>
          <button
            disabled={!imported || busy}
            onClick={() => {
              setEditing(true);
            }}
          >
            Chỉnh vùng cắt chung
          </button>
          <button
            disabled={!imported || busy}
            onClick={() => {
              setCrop({ kind: 'full-frame' });
              setResults({});
            }}
          >
            Dùng toàn ảnh
          </button>
        </div>
        {editing && imported && (
          <ManualCropEditor
            original={imported.original}
            {...(imported.preview ? { preview: imported.preview } : {})}
            initialCrop={crop}
            busy={busy}
            onCancel={() => {
              setEditing(false);
            }}
            onApply={(value) => {
              setCrop(value);
              setEditing(false);
              setResults({});
            }}
          />
        )}
        <p>
          Vùng cắt: {crop.kind === 'full-frame' ? 'toàn ảnh' : '4 góc đã chọn'}. Ảnh không được tải
          lên máy chủ.
        </p>
        <div className="comparison-actions">
          <button
            className="primary-button"
            disabled={!imported || busy || editing}
            onClick={() => {
              const order: ComparisonEngine[] = reverse.current ? ['cpp', 'web'] : ['web', 'cpp'];
              reverse.current = !reverse.current;
              setResults({});
              void run(order);
            }}
          >
            So sánh cả hai
          </button>
          <button disabled={!imported || busy || editing} onClick={() => void run(['web'])}>
            Chỉ chạy Web
          </button>
          <button disabled={!imported || busy || editing} onClick={() => void run(['cpp'])}>
            Chỉ chạy C++
          </button>
          {busy && <button onClick={() => lifetime.current?.abort()}>Dừng đo</button>}
        </div>
        <p role="status" aria-live="polite">
          {status}
        </p>
        {error && (
          <p className="comparison-error" role="alert">
            {error}
          </p>
        )}
      </section>
      <section aria-label="Kết quả so sánh">
        <label className="comparison-zoom">
          Phóng to đồng bộ: {zoom.toFixed(1)}×
          <input
            type="range"
            min="1"
            max="4"
            step="0.25"
            value={zoom}
            onChange={(event) => {
              setZoom(Number(event.target.value));
            }}
          />
        </label>
        <div className="comparison-results">
          {results.web && (
            <ResultImage
              result={results.web}
              zoom={zoom}
              scrollRef={webScroll}
              onScroll={() => {
                synchronize(webScroll.current, cppScroll.current);
              }}
            />
          )}
          {results.cpp && (
            <ResultImage
              result={results.cpp}
              zoom={zoom}
              scrollRef={cppScroll}
              onScroll={() => {
                synchronize(cppScroll.current, webScroll.current);
              }}
            />
          )}
        </div>
      </section>
      <section className="comparison-guide" aria-labelledby="physical-test-title">
        <h2 id="physical-test-title">Đo nóng máy và hao pin</h2>
        <p>
          Trang này không đọc được nhiệt độ, % CPU, tổng RAM hay điện năng của điện thoại. Các mục
          đó chưa được đo, không phải bằng 0. C++ ở đây chạy qua WASM; không đại diện tốc độ DLL
          chạy trực tiếp.
        </p>
        <ol>
          <li>Dùng cùng ảnh và vùng cắt, cùng độ sáng; tránh vừa sạc vừa đo.</li>
          <li>
            Chạy riêng một bản 20 lần. Giữ màn hình mở, ghi pin, thời lượng và nhiệt độ trước/sau
            bằng thiết bị đo hoặc công cụ hệ điều hành nếu có.
          </li>
          <li>
            Cho máy nguội về mức ban đầu rồi chạy bản còn lại. Lặp lại và đảo thứ tự. Không dùng
            lượt “cả hai” để kết luận bản nào ít nóng hơn.
          </li>
        </ol>
        <p>
          Lần đầu có tải/biên dịch và cấp bộ nhớ; trung vị các lần sau bỏ lần đầu nhưng không bảo
          đảm hết mọi ảnh hưởng khởi động. Khoảng khung hình đo độ mượt UI, không phải % CPU. Bộ nhớ
          WASM được giải phóng khi worker kết thúc.
        </p>
        <label>
          Ghi chú thiết bị và kết quả đo thực tế
          <textarea
            value={notes}
            maxLength={2000}
            onChange={(event) => {
              setNotes(event.target.value);
            }}
            placeholder="Ví dụ: dòng máy, trình duyệt, pin trước/sau, nhiệt độ đo được…"
          />
        </label>
        <button
          disabled={busy || (!results.web && !results.cpp)}
          onClick={() => {
            const report = {
              schema: 1,
              createdAt: new Date().toISOString(),
              boundary: 'shared browser decode; warp + enhanced/original; shared lossless PNG/PDF',
              outputMaximumSide: 3000,
              sourceDimensions: imported?.original.dimensions,
              crop,
              filter,
              notes,
              cpuPercent: null,
              processPeakRamBytes: null,
              temperatureCelsius: null,
              energyJoules: null,
              results: Object.values(results).map(({ image, ...measurement }) => ({
                ...measurement,
                dimensions: image.dimensions,
                encodedBytes: image.blob.size,
              })),
            };
            downloadBlob(
              new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
              'so-sanh-web-cpp.json',
            );
          }}
        >
          Tải số đo và ghi chú
        </button>
      </section>
    </main>
  );
}
