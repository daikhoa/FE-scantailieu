import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountApi, apiJson, ApiError } from './api-client';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('account API boundary', () => {
  it('uses same-origin HttpOnly sessions and a CSRF header without storing tokens in browser storage', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 'test', email: 'test@example.com' }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetcher);
    await accountApi.login('test@example.com', 'test password');
    const [path, options] = fetcher.mock.calls[0] ?? [];
    expect(path).toBe('/api/v1/auth/session');
    expect(options?.credentials).toBe('same-origin');
    expect(new Headers(options?.headers).get('X-Requested-With')).toBe('docscan');
    expect(options?.body).toBe(
      JSON.stringify({ email: 'test@example.com', password: 'test password' }),
    );
  });
  it('preserves conflict and session-expiry errors for the UI', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ detail: 'Tài liệu đã thay đổi.' }), { status: 409 }),
        ),
    );
    await expect(apiJson('/api/v1/documents/id')).rejects.toEqual(
      new ApiError(409, 'Tài liệu đã thay đổi.'),
    );
  });
  it('times out a stalled network request and releases its timer', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        (_, options) =>
          new Promise((_, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => {
                reject(new DOMException('Aborted', 'AbortError'));
              },
              { once: true },
            );
          }),
      ),
    );
    const pending = apiJson('/api/v1/documents', {}, 1000);
    const rejected = expect(pending).rejects.toThrow('Kết nối mất quá nhiều thời gian');
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
