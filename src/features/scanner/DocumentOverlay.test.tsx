import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { LiveDetectionResult } from './detection-scheduler';
import { DocumentOverlay } from './DocumentOverlay';

const dimensions = { width: 1000, height: 1400 };

function renderOverlay(result: LiveDetectionResult | null) {
  return render(<DocumentOverlay result={result} />);
}

describe('DocumentOverlay', () => {
  it('announces detection startup without drawing an invented document', () => {
    const view = renderOverlay(null);

    expect(screen.getByRole('status')).toHaveTextContent('Đang tìm tài liệu');
    expect(view.container.querySelector('polygon')).not.toBeInTheDocument();
  });

  it.each([
    ['no-document', 'Chưa thấy tài liệu — ảnh sẽ giữ toàn bộ khung.'],
    ['low-confidence', 'Chưa nhận diện chắc chắn — ảnh sẽ giữ toàn bộ khung.'],
    ['unstable-document', 'Giữ máy ổn định để định khung tài liệu.'],
  ] as const)('draws the full frame and explains %s with text', (reason, status) => {
    const view = renderOverlay({ kind: 'full-frame', dimensions, reason });

    expect(screen.getByRole('status')).toHaveTextContent(status);
    expect(view.container.querySelector('polygon')).toHaveAttribute(
      'points',
      '0,0 1000,0 1000,1400 0,1400',
    );
    expect(view.container.querySelector('svg')).toHaveAttribute('viewBox', '0 0 1000 1400');
  });

  it('draws a stable document quad and announces successful detection', () => {
    const view = renderOverlay({
      kind: 'document',
      dimensions,
      confidence: 0.91,
      corners: [
        { x: 100, y: 120 },
        { x: 900, y: 130 },
        { x: 880, y: 1280 },
        { x: 120, y: 1270 },
      ],
    });

    expect(screen.getByRole('status')).toHaveTextContent('Đã định khung tài liệu');
    expect(view.container.querySelector('polygon')).toHaveAttribute(
      'points',
      '100,120 900,130 880,1280 120,1270',
    );
    expect(view.container.firstElementChild).toHaveAttribute('data-detection', 'document');
  });
});
