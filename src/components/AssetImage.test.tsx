import { render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { AssetImage } from './AssetImage';

afterEach(() => vi.unstubAllGlobals());

it('keeps shared image URLs live after StrictMode cleanup and releases them on unmount', () => {
  let next = 0;
  const revoked = new Set<string>();
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:asset-${String(++next)}`),
    revokeObjectURL: vi.fn((url: string) => {
      revoked.add(url);
    }),
  });
  const image = {
    blob: new Blob(['image'], { type: 'image/jpeg' }),
    dimensions: { width: 12, height: 16 },
  };
  const view = render(
    <StrictMode>
      <AssetImage image={image} alt="Trang" />
      <AssetImage image={image} alt="Bộ lọc" />
    </StrictMode>,
  );
  const src = screen.getByAltText('Trang').getAttribute('src');
  expect(screen.getByAltText('Bộ lọc')).toHaveAttribute('src', src);
  expect(src).toBeTruthy();
  expect(revoked.has(src ?? '')).toBe(false);
  view.unmount();
  expect(revoked.has(src ?? '')).toBe(true);
});
