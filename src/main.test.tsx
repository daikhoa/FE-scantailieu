import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('application bootstrap', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    vi.resetModules();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ detail: 'Đăng nhập' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      ),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('labels the main application landmark with the product name', async () => {
    await import('./main');

    expect(await screen.findByRole('form', { name: 'Đăng nhập tài khoản' })).toBeInTheDocument();
    expect(screen.getByRole('main', { name: 'clonecamscanner' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Tài liệu của bạn, luôn sẵn sàng' }),
    ).not.toHaveFocus();
    expect(screen.queryByRole('heading', { name: 'Tài liệu của tôi' })).not.toBeInTheDocument();
  });

  it('fails clearly when the application root is missing', async () => {
    document.body.replaceChildren();

    await expect(import('./main')).rejects.toThrow(
      'Không tìm thấy phần tử gốc để khởi tạo ứng dụng.',
    );
  });
});
