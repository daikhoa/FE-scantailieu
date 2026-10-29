import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PageOrderEditor } from './PageOrderEditor';
import type { ScanBatchPage } from './scan-batch';

const pages: readonly ScanBatchPage[] = ['a', 'b', 'c'].map((id) => ({
  id,
  kind: 'loading-saved',
  previewUrl: `/preview-${id}`,
}));

describe('PageOrderEditor', () => {
  it('moves by captured pointer and restores the draft if the gesture is cancelled', () => {
    const { container } = render(
      <PageOrderEditor pages={pages} selectedPageId="a" onApply={vi.fn()} onCancel={vi.fn()} />,
    );
    const descriptor = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => container.querySelector('[data-order-id="c"]'),
    });
    try {
      const handle = screen.getByRole('button', { name: 'Kéo trang 1 để đổi thứ tự' });
      fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 50, clientY: 50 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 200, clientY: 200 });
      expect(screen.getByRole('combobox')).toHaveValue('3');
      fireEvent.pointerCancel(handle, { pointerId: 1 });
      expect(screen.getByRole('combobox')).toHaveValue('1');
    } finally {
      if (descriptor) Object.defineProperty(document, 'elementFromPoint', descriptor);
      else Reflect.deleteProperty(document, 'elementFromPoint');
    }
  });
  it('moves a selected page directly to a distant position and commits only on Done', () => {
    const onApply = vi.fn();
    const { container } = render(
      <PageOrderEditor pages={pages} selectedPageId="a" onApply={onApply} onCancel={vi.fn()} />,
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Đưa trang đã chọn tới vị trí' }), {
      target: { value: '3' },
    });
    expect(
      [...container.querySelectorAll('[data-order-id]')].map((el) =>
        el.getAttribute('data-order-id'),
      ),
    ).toEqual(['b', 'c', 'a']);
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Lên trước' }));
    fireEvent.click(screen.getByRole('button', { name: 'Xong' }));
    expect(onApply).toHaveBeenCalledWith(['b', 'a', 'c']);
  });

  it('supports keyboard reordering and discards a cancelled draft', () => {
    const onApply = vi.fn();
    const onCancel = vi.fn();
    render(
      <PageOrderEditor pages={pages} selectedPageId="a" onApply={onApply} onCancel={onCancel} />,
    );
    fireEvent.keyDown(screen.getByRole('button', { name: 'Kéo trang 1 để đổi thứ tự' }), {
      key: 'ArrowRight',
    });
    expect(screen.getByRole('combobox')).toHaveValue('2');
    fireEvent.click(screen.getByRole('button', { name: 'Hủy' }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onApply).not.toHaveBeenCalled();
  });
});
