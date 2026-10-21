import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ManualCropEditor } from './ManualCropEditor';

const original = {
  blob: new Blob(['original'], { type: 'image/jpeg' }),
  dimensions: { width: 1200, height: 1600 },
};

beforeEach(() => {
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:original-page'),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ManualCropEditor', () => {
  it('starts from the saved document corners and applies a keyboard adjustment', () => {
    const onApply = vi.fn();
    render(
      <ManualCropEditor
        original={original}
        initialCrop={{
          kind: 'document',
          corners: [
            { x: 120, y: 160 },
            { x: 1080, y: 160 },
            { x: 1080, y: 1440 },
            { x: 120, y: 1440 },
          ],
        }}
        busy={false}
        onCancel={vi.fn()}
        onApply={onApply}
      />,
    );

    const topLeft = screen.getByRole('slider', { name: 'Góc trên trái' });
    expect(topLeft).toHaveAttribute('aria-valuetext', '120, 160');

    fireEvent.keyDown(topLeft, { key: 'ArrowRight' });
    fireEvent.click(screen.getByRole('button', { name: 'Áp dụng vùng cắt' }));

    expect(onApply).toHaveBeenCalledWith({
      kind: 'document',
      corners: [
        { x: 132, y: 160 },
        { x: 1080, y: 160 },
        { x: 1080, y: 1440 },
        { x: 120, y: 1440 },
      ],
    });
  });

  it('uses all four image edges when the saved crop is full frame', () => {
    const onApply = vi.fn();
    render(
      <ManualCropEditor
        original={original}
        initialCrop={{ kind: 'full-frame' }}
        busy={false}
        onCancel={vi.fn()}
        onApply={onApply}
      />,
    );

    expect(screen.getAllByRole('slider')).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: 'Áp dụng vùng cắt' }));
    expect(onApply).toHaveBeenCalledWith({
      kind: 'document',
      corners: [
        { x: 0, y: 0 },
        { x: 1200, y: 0 },
        { x: 1200, y: 1600 },
        { x: 0, y: 1600 },
      ],
    });
  });

  it('maps a dragged handle from the displayed image back to original-image coordinates', () => {
    const onApply = vi.fn();
    const { container } = render(
      <ManualCropEditor
        original={original}
        initialCrop={{ kind: 'full-frame' }}
        busy={false}
        onCancel={vi.fn()}
        onApply={onApply}
      />,
    );
    const overlay = container.querySelector('svg');
    if (overlay === null) throw new Error('Crop overlay was not rendered.');
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 600,
      bottom: 800,
      width: 600,
      height: 800,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(screen.getByRole('slider', { name: 'Góc trên trái' }), {
      pointerId: 1,
    });
    fireEvent.pointerMove(overlay, { pointerId: 1, clientX: 100, clientY: 200 });
    fireEvent.pointerUp(overlay, { pointerId: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Áp dụng vùng cắt' }));

    expect(onApply).toHaveBeenCalledWith({
      kind: 'document',
      corners: [
        { x: 200, y: 400 },
        { x: 1200, y: 0 },
        { x: 1200, y: 1600 },
        { x: 0, y: 1600 },
      ],
    });
  });
});
