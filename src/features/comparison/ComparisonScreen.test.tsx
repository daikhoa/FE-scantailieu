import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComparisonScreen } from './ComparisonScreen';
import { runComparison } from './comparison-client';
import { importImage } from '../camera/image-import';
import type { ComparisonResult } from './comparison-contract';
import { ComparisonError } from './comparison-error';

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
  it('removes the experimental OpenCV processor', () => {
    render(<ComparisonScreen />);
    expect(screen.queryByRole('button', { name: 'Chỉ chạy OpenCV' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('combobox', { name: 'Mức tăng cường OpenCV' }),
    ).not.toBeInTheDocument();
  });
  it('identifies memory failure without claiming that the device cannot run C++', async () => {
    vi.mocked(importImage).mockResolvedValue({ original: asset });
    vi.mocked(runComparison).mockRejectedValue(new ComparisonError('out-of-memory', 'process'));
    render(<ComparisonScreen />);
    fireEvent.change(screen.getByLabelText('Chọn ảnh gốc'), {
      target: { files: [new File(['image'], 'scan.png', { type: 'image/png' })] },
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Chỉ chạy C++ tự viết' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Chỉ chạy C++ tự viết' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('C++ tự viết: Không đủ bộ nhớ');
    expect(screen.getByRole('alert')).toHaveTextContent('process/out-of-memory');
    expect(screen.queryByRole('heading', { name: 'C++ tự viết' })).not.toBeInTheDocument();
  });
  it('keeps comparison opt-in and explains unsupported thermal/CPU measurements', () => {
    render(<ComparisonScreen />);
    expect(screen.getByRole('button', { name: 'So sánh cả hai' })).toBeDisabled();
    expect(screen.getByText(/Trang này không đọc được nhiệt độ/)).toBeVisible();
    expect(runComparison).not.toHaveBeenCalled();
    expect(screen.queryByRole('combobox', { name: 'Cặp so sánh' })).not.toBeInTheDocument();
    expect(screen.queryByText(/OpenCV/)).not.toBeInTheDocument();
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
    await screen.findByRole('heading', { name: 'C++ tự viết' });
    expect(order).toEqual(['web', 'cpp']);
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
      expect(screen.getByRole('button', { name: 'Chỉ chạy C++ tự viết' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Chỉ chạy C++ tự viết' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Không chạy được bộ xử lý');
    expect(screen.queryByRole('heading', { name: 'C++ tự viết' })).not.toBeInTheDocument();
  });
  it('runs original mode through only Web and custom C++', async () => {
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
      }),
    );
    render(<ComparisonScreen />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Bộ lọc' }), {
      target: { value: 'original' },
    });
    fireEvent.change(screen.getByLabelText('Chọn ảnh gốc'), {
      target: { files: [new File(['image'], 'scan.png', { type: 'image/png' })] },
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'So sánh cả hai' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'So sánh cả hai' }));
    await screen.findByRole('heading', { name: 'C++ tự viết' });
    expect(vi.mocked(runComparison).mock.calls.map((c) => c[0])).toEqual(['web', 'cpp']);
    expect(vi.mocked(runComparison).mock.calls.every((c) => c[1].filter === 'original')).toBe(true);
  });
  it('offers the pretrained illumination filter explicitly without changing the default', () => {
    render(<ComparisonScreen />);
    const filter = screen.getByRole('combobox', { name: 'Bộ lọc' });
    expect(filter).toHaveValue('enhanced-color');
    fireEvent.change(filter, { target: { value: 'shadow-removal' } });
    expect(filter).toHaveValue('shadow-removal');
    expect(screen.getByText(/Hai bản dùng chung bước AI sau khi cắt/)).toBeVisible();
    expect(runComparison).not.toHaveBeenCalled();
  });
});
