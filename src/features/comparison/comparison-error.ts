export type ComparisonStage = 'initialize' | 'decode' | 'process' | 'encode';
export type ComparisonFailureCode =
  'invalid-input' | 'unavailable' | 'load-failed' | 'wasm-unsupported' | 'out-of-memory' | 'failed';

export class ComparisonError extends Error {
  constructor(
    readonly code: ComparisonFailureCode,
    readonly stage: ComparisonStage,
  ) {
    super(code);
    this.name = 'ComparisonError';
  }
}

/** Only classified codes cross the worker boundary; never send raw engine messages. */
export function classifyComparisonError(error: unknown, stage: ComparisonStage): ComparisonError {
  if (error instanceof ComparisonError) return error;
  const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : '';
  const message =
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
      ? error.message
      : '';
  if (
    message === 'out-of-memory' ||
    ((name === 'RangeError' || name === 'RuntimeError') && /memory|alloc/i.test(message))
  )
    return new ComparisonError('out-of-memory', stage);
  if (message === 'invalid-input') return new ComparisonError('invalid-input', stage);
  if (stage === 'initialize')
    return new ComparisonError(
      name === 'CompileError' ||
        name === 'LinkError' ||
        (name === 'RuntimeError' && /CompileError|LinkError/.test(message))
        ? 'wasm-unsupported'
        : 'load-failed',
      stage,
    );
  return new ComparisonError(message === 'unavailable' ? 'unavailable' : 'failed', stage);
}

export function comparisonErrorMessage(error: unknown): string {
  const stage = error instanceof ComparisonError ? error.stage : undefined;
  const code =
    error instanceof ComparisonError
      ? error.code
      : error instanceof Error && error.message === 'out-of-memory'
        ? 'out-of-memory'
        : 'failed';
  const message =
    code === 'out-of-memory'
      ? 'Không đủ bộ nhớ để hoàn tất ảnh này. Ảnh gốc không bị thay đổi; hãy đóng các tab khác rồi thử lại.'
      : code === 'load-failed'
        ? 'Không tải được bộ xử lý. Kiểm tra kết nối rồi tải lại trang.'
        : code === 'wasm-unsupported'
          ? 'Trình duyệt không khởi tạo được lõi C++. Hãy thử mở link bằng trình duyệt khác hoặc cập nhật trình duyệt.'
          : code === 'invalid-input'
            ? 'Ảnh hoặc vùng cắt không hợp lệ. Hãy chọn lại vùng cắt.'
            : stage === 'decode'
              ? 'Không giải mã được ảnh gốc để chạy lượt so sánh.'
              : stage === 'encode'
                ? 'Không tạo được ảnh PNG sau khi xử lý.'
                : 'Không chạy được bộ xử lý. Lượt đo chưa có kết quả cho bản này.';
  return `${message}${stage === undefined ? '' : ` Mã kiểm tra: ${stage}/${code}.`}`;
}
