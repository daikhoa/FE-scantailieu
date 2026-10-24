import { useEffect, useRef, useState } from 'react';
import type { CropRegion } from '../../domain/document';
import { importImage, type ImportedImage } from '../camera/image-import';
import { ManualCropEditor } from '../editor/ManualCropEditor';
import { downloadBlob } from '../export/download-blob';
import { RASTER_MIME_TYPES } from '../../imaging/codecs/raster-metadata';
import { runComparison } from './comparison-client';
import {
  COMPARISON_LABELS,
  COMPARISON_PAIRS,
  OPENCV_PRESET_LABELS,
  type OpenCvPreset,
  MAX_COMPARISON_INPUT_PIXELS,
  type ComparisonEngine,
  type ComparisonFilter,
} from './comparison-contract';
import { ComparisonResults, type MeasuredResult } from './ComparisonResults';
import './comparison.css';

const LABELS = COMPARISON_LABELS;
const mib = (value: number) => `${(value / 1048576).toFixed(1)} MiB`;
export function ComparisonScreen() {
  const [imported, setImported] = useState<ImportedImage | null>(null);
  const [crop, setCrop] = useState<CropRegion>({ kind: 'full-frame' });
  const [editing, setEditing] = useState(false);
  const [pair, setPair] = useState<keyof typeof COMPARISON_PAIRS>('web-opencv');
  const [opencvPreset, setOpenCvPreset] = useState<OpenCvPreset>('balanced');
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
  useEffect(() => () => lifetime.current?.abort(), []);

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
    setResults({});
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
            { asset: imported.original, corners, filter, repetitions, opencvPreset },
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
        <h1>So sánh thuật toán và OpenCV</h1>
        <p>
          Cùng ảnh gốc, cùng vùng cắt, đầu ra tối đa 3000 px. Chỉ đo cắt phối cảnh và bộ lọc; giải
          mã, xuất PNG/PDF dùng chung. Không đo AI hay bộ mã hóa của DLL Windows.
        </p>
      </header>
      <p>
        OpenCV dùng cắt phối cảnh, CLAHE trên độ sáng và tăng nét nhẹ. Chọn “Giữ nguyên màu” để chỉ
        đối chiếu bước cắt. Các bản cũ vẫn có trong danh sách cặp so sánh.
      </p>
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
            Cặp so sánh
            <select
              aria-label="Cặp so sánh"
              value={pair}
              disabled={busy}
              onChange={(event) => {
                setPair(event.target.value as keyof typeof COMPARISON_PAIRS);
                setResults({});
              }}
            >
              <option value="web-opencv">Web hiện tại ↔ OpenCV</option>
              <option value="cpp-opencv">C++ tự viết ↔ OpenCV</option>
              <option value="web-cpp">Web hiện tại ↔ C++ tự viết</option>
            </select>
          </label>
          <label>
            Mức tăng cường OpenCV
            <select
              aria-label="Mức tăng cường OpenCV"
              value={opencvPreset}
              disabled={busy || filter === 'original'}
              onChange={(event) => {
                setOpenCvPreset(event.target.value as OpenCvPreset);
                setResults({});
              }}
            >
              {Object.entries(OPENCV_PRESET_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
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
              const order: ComparisonEngine[] = [...COMPARISON_PAIRS[pair]];
              if (reverse.current) order.reverse();
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
            Chỉ chạy C++ tự viết
          </button>
          <button disabled={!imported || busy || editing} onClick={() => void run(['opencv'])}>
            Chỉ chạy OpenCV
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
        <ComparisonResults results={results} zoom={zoom} />
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
          disabled={busy || Object.keys(results).length === 0}
          onClick={() => {
            const report = {
              schema: 2,
              selectedPair: pair,
              measuredEngines: Object.keys(results),
              opencvPreset,
              wasmAssets: '/docscan-wasm/v2/',
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
