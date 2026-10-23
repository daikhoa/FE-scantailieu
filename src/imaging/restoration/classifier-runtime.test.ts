import { describe, expect, it, vi } from 'vitest';
import { createClassifierRuntime } from './classifier-runtime';

describe('classifier execution recovery', () => {
  it('releases a failed GPU session and retries once with WASM', async () => {
    const gpu = {
      run: vi.fn(() => Promise.reject(new Error('device lost'))),
      release: vi.fn(() => Promise.resolve()),
    };
    const wasm = { run: vi.fn(() => Promise.resolve({})), release: vi.fn(() => Promise.resolve()) };
    const createSession = vi.fn().mockResolvedValueOnce(gpu).mockResolvedValueOnce(wasm);
    const runtime = createClassifierRuntime(createSession, true);
    await runtime.run({});
    await runtime.run({});
    expect(gpu.release).toHaveBeenCalledOnce();
    expect(createSession.mock.calls.map((parameters: unknown[]) => parameters[0])).toEqual([
      ['webgpu', 'wasm'],
      ['wasm'],
    ]);
    expect(wasm.run).toHaveBeenCalledTimes(2);
  });
  it('bounds retries when WASM also fails and releases the failed session', async () => {
    const release = vi.fn(() => Promise.resolve());
    const createSession = vi.fn(() =>
      Promise.resolve({ run: vi.fn(() => Promise.reject(new Error('failed'))), release }),
    );
    const runtime = createClassifierRuntime(createSession, false);
    await expect(runtime.run({})).rejects.toThrow('failed');
    expect(createSession).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});
