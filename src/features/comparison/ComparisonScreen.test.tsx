import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComparisonScreen } from './ComparisonScreen';
import { runComparison } from './comparison-client';
import { importImage } from '../camera/image-import';
import type { ComparisonResult } from './comparison-contract';

vi.mock('./comparison-client', () => ({ runComparison: vi.fn() }));
vi.mock('../camera/image-import', () => ({ importImage: vi.fn() }));
const asset = {
  blob: new Blob(['image'], { type: 'image/png' }),
  dimensions: { width: 20, height: 30 },
};
const sample = {
  decodeMs: 2,
  processMs: 3,
  encodeMs: 4,
  totalMs: 9,
  inputPixelBytes: 2400,
  outputPixelBytes: 2400,
  wasmReservedBytes: null,
};
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('comparison screen', () => {
  it('keeps comparison opt-in and explains unsupported thermal/CPU measurements', () => {
    render(<ComparisonScreen />);
    expect(screen.getByRole('button', { name: 'So sánh cả hai' })).toBeDisabled();
    expect(screen.getByText(/Trang này không đọc được nhiệt độ/)).toBeVisible();
    expect(runComparison).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox', { name: 'Cặp so sánh' })).toHaveValue('web-opencv');
    expect(screen.getByRole('combobox', { name: 'Mức tăng cường OpenCV' })).toHaveValue('balanced');
  });
  it('runs the two engines sequentially with the exact same source and crop', async () => {
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => 'blob:comparison'),
        revokeObjectURL: vi.fn(),
      }),
    );
    vi.mocked(importImage).mockResolvedValue({ original: asset });
    const order: string[] = [];
    vi.mocked(runComparison).mockImplementation((engine, input) => {
      order.push(engine);
      return Promise.resolve({
        engine,
        filter: input.filter,
        implementation: 'test',
        image: asset,
        setupMs: 1,
        wallMs: 46,
        samples: Array.from({ length: input.repetitions }, () => sample),
      } satisfies ComparisonResult);
    });
    render(<ComparisonScreen />);
    fireEvent.change(screen.getByLabelText('Chọn ảnh gốc'), {
      target: { files: [new File(['image'], 'scan.png', { type: 'image/png' })] },
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'So sánh cả hai' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'So sánh cả hai' }));
    await screen.findByRole('heading', { name: 'C++ OpenCV' });
    expect(order).toEqual(['web', 'opencv']);
    const calls = vi.mocked(runComparison).mock.calls;
    expect(calls[0]?.[1]).toEqual(calls[1]?.[1]);
    expect(calls[0]?.[1].asset).toBe(asset);
    expect(calls[0]?.[1].filter).toBe('enhanced-color');
    expect(screen.getAllByRole('img')).toHaveLength(2);
  });
  it('shows a real failure when C++ is unavailable, rather than displaying Web as C++', async () => {
    vi.mocked(importImage).mockResolvedValue({ original: asset });
    vi.mocked(runComparison).mockRejectedValue(new Error('unavailable'));
    render(<ComparisonScreen />);
    fireEvent.change(screen.getByLabelText('Chọn ảnh gốc'), {
      target: { files: [new File(['image'], 'scan.png', { type: 'image/png' })] },
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Chỉ chạy OpenCV' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Chỉ chạy OpenCV' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Không chạy được bộ xử lý');
    expect(screen.queryByRole('heading', { name: 'C++ OpenCV' })).not.toBeInTheDocument();
  });
  it.each([
    ['cpp-opencv', ['cpp', 'opencv']],
    ['web-cpp', ['web', 'cpp']],
  ] as const)('retains pair %s and passes the chosen configuration', async (pair, engines) => {
    vi.mocked(importImage).mockResolvedValue({ original: asset });
    vi.mocked(runComparison).mockImplementation((engine, input) =>
      Promise.resolve({
        engine,
        filter: input.filter,
        implementation: 'test',
        image: asset,
        setupMs: 1,
        wallMs: 2,
        samples: [sample],
        ...(engine === 'opencv' ? { opencvPreset: input.opencvPreset ?? 'balanced' } : {}),
      }),
    );
    render(<ComparisonScreen />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Cặp so sánh' }), {
      target: { value: pair },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Mức tăng cường OpenCV' }), {
      target: { value: 'text' },
    });
    fireEvent.change(screen.getByLabelText('Chọn ảnh gốc'), {
      target: { files: [new File(['image'], 'scan.png', { type: 'image/png' })] },
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'So sánh cả hai' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'So sánh cả hai' }));
    await screen.findByRole('heading', {
      name: pair === 'cpp-opencv' ? 'C++ OpenCV' : 'C++ tự viết',
    });
    expect(vi.mocked(runComparison).mock.calls.map((c) => c[0])).toEqual(engines);
    expect(vi.mocked(runComparison).mock.calls[1]?.[1].opencvPreset).toBe('text');
    expect(screen.getByRole('heading', { name: 'C++ tự viết' })).toBeVisible();
    if (pair === 'cpp-opencv') expect(screen.getByText('Mức OpenCV: Rõ chữ')).toBeVisible();
    else expect(screen.queryByRole('heading', { name: 'C++ OpenCV' })).not.toBeInTheDocument();
  });
});
