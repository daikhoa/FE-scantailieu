import { afterEach, describe, expect, it, vi } from 'vitest';
import { preparePdf } from './prepare-pdf';

afterEach(() => vi.useRealTimers());

describe('PDF preparation lifetime', () => {
  it('times out a stalled exporter and cancels its work so the UI can retry', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = preparePdf([], controller, () => new Promise(() => undefined), 1000);
    const rejection = expect(pending).rejects.toThrow('Tạo PDF mất quá nhiều thời gian');
    await vi.advanceTimersByTimeAsync(1000);
    await rejection;
    expect(controller.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects cancellation even if the exporter never settles', async () => {
    const controller = new AbortController();
    const pending = preparePdf([], controller, () => new Promise(() => undefined));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
