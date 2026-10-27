export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface Account {
  readonly id: string;
  readonly email: string;
}

const API = '/api/v1';

async function request<T>(
  path: string,
  options: RequestInit,
  decode: (response: Response) => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  if (!path.startsWith(`${API}/`)) throw new Error('Địa chỉ API không hợp lệ.');
  const controller = new AbortController();
  const abort = () => {
    controller.abort();
  };
  const signal = options.signal;
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  try {
    const headers = new Headers(options.headers);
    if (options.method && options.method !== 'GET') headers.set('X-Requested-With', 'docscan');
    const response = await fetch(path, {
      ...options,
      headers,
      credentials: 'same-origin',
      signal: controller.signal,
    });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const detail =
        body !== null && typeof body === 'object' && 'detail' in body ? body.detail : null;
      throw new ApiError(
        response.status,
        typeof detail === 'string' ? detail : 'Không thể kết nối kho tài liệu. Vui lòng thử lại.',
      );
    }
    return await decode(response);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (signal?.aborted) throw new DOMException('Đã huỷ thao tác.', 'AbortError');
    if (controller.signal.aborted)
      throw new Error('Kết nối mất quá nhiều thời gian. Vui lòng thử lại.', { cause: error });
    throw new Error('Không kết nối được máy chủ. Kiểm tra kết nối và thử lại.', { cause: error });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export function apiJson<T>(
  path: string,
  options: RequestInit = {},
  timeoutMs?: number,
): Promise<T> {
  return request(
    path,
    options,
    async (response) =>
      response.status === 204 ? (undefined as T) : ((await response.json()) as T),
    timeoutMs,
  );
}

export function apiBlob(path: string, signal?: AbortSignal): Promise<Blob> {
  return request(path, { ...(signal ? { signal } : {}) }, (response) => response.blob(), 90_000);
}

export const accountApi = {
  me: (signal?: AbortSignal) => apiJson<Account>(`${API}/auth/me`, signal ? { signal } : {}),
  register: (email: string, password: string) =>
    apiJson<Account>(`${API}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
  login: (email: string, password: string) =>
    apiJson<Account>(`${API}/auth/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
  logout: () => apiJson<undefined>(`${API}/auth/session`, { method: 'DELETE' }),
};
