import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('application bootstrap', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    vi.resetModules();
  });

  it('labels the main application landmark with the product name', async () => {
    await import('./main');

    expect(await screen.findByRole('main', { name: 'clonecamscanner' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Tài liệu của tôi' })).not.toHaveFocus();
  });

  it('fails clearly when the application root is missing', async () => {
    document.body.replaceChildren();

    await expect(import('./main')).rejects.toThrow(
      'Không tìm thấy phần tử gốc để khởi tạo ứng dụng.',
    );
  });
});
