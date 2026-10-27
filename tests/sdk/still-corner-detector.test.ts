import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectStillCorners } from '@docscan/browser/internal/imaging/engines/still-corner-detector';

const helpers = vi.hoisted(() => ({ refine: vi.fn(), confirm: vi.fn() }));
vi.mock('@docscan/browser/internal/imaging/engines/docscan-corners', () => ({
  refineDocscanCorners: helpers.refine,
  confirmDocscanCorners: helpers.confirm,
}));
const corners = [
  { x: 10, y: 10 },
  { x: 70, y: 10 },
  { x: 70, y: 80 },
  { x: 10, y: 80 },
] as const;
function result(confidence: number) {
  return {
    success: true,
    confidence,
    corners: {
      topLeft: corners[0],
      topRight: corners[1],
      bottomRight: corners[2],
      bottomLeft: corners[3],
    },
    output: null,
    contour: null,
    debug: null,
    timings: [],
    message: 'detected',
  };
}
beforeEach(() => {
  vi.stubGlobal(
    'ImageData',
    class {
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number,
      ) {}
    },
  );
  helpers.refine.mockReset();
  helpers.confirm.mockReset();
});
afterEach(() => vi.unstubAllGlobals());
const image = () => new ImageData(new Uint8ClampedArray(100 * 120 * 4), 100, 120);

describe('still photo corner recovery', () => {
  it('refines a confident photo without another model inference', async () => {
    helpers.refine.mockResolvedValue({ corners, support: 65, action: 'accept' });
    const scan = vi.fn().mockResolvedValue(result(0.99));
    const output = await detectStillCorners(image(), scan);
    expect(output.success).toBe(true);
    expect(scan).toHaveBeenCalledOnce();
    expect(helpers.confirm).not.toHaveBeenCalled();
  });
  it('requires a second model confirmation before accepting weak initial evidence', async () => {
    helpers.refine.mockResolvedValue({ corners, support: 65, action: 'verify' });
    helpers.confirm.mockResolvedValue(true);
    const scan = vi.fn().mockResolvedValueOnce(result(0.19)).mockResolvedValueOnce(result(0.99));
    const output = await detectStillCorners(image(), scan);
    expect(output.success).toBe(true);
    expect(output.confidence).toBe(0.99);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(helpers.confirm).toHaveBeenCalledOnce();
  });
  it('rejects mismatched model confirmation instead of treating any rectangle as a document', async () => {
    helpers.refine.mockResolvedValue({ corners, support: 65, action: 'verify' });
    helpers.confirm.mockResolvedValue(false);
    const scan = vi.fn().mockResolvedValue(result(0.2));
    const output = await detectStillCorners(image(), scan);
    expect(output.success).toBe(false);
    expect(output.corners).toBeNull();
    expect(scan).toHaveBeenCalledTimes(3);
  });
  it('tries one center proposal when the full-scene rectangle fails confirmation', async () => {
    const local = [corners[0], { x: 60, y: 10 }, { x: 60, y: 70 }, { x: 10, y: 70 }] as const;
    helpers.refine
      .mockResolvedValueOnce({ corners, support: 65, action: 'verify' })
      .mockResolvedValueOnce({ corners: local, support: 65, action: 'accept' });
    helpers.confirm.mockResolvedValue(false);
    const scan = vi
      .fn()
      .mockResolvedValueOnce(result(0.19))
      .mockResolvedValueOnce(result(0.8))
      .mockResolvedValueOnce(result(0.99));
    const output = await detectStillCorners(image(), scan);
    expect(output.success).toBe(true);
    expect(output.corners?.topLeft).toEqual({ x: 25, y: 28 });
    expect(scan).toHaveBeenCalledTimes(3);
  });
  it('limits empty-scene recovery to one center crop and keeps a full-frame fallback', async () => {
    helpers.refine.mockResolvedValue({ corners, support: 2, action: 'reject' });
    const scan = vi.fn().mockResolvedValue(result(0.001));
    const output = await detectStillCorners(image(), scan);
    expect(output.success).toBe(false);
    expect(output.corners).toBeNull();
    expect(scan).toHaveBeenCalledTimes(2);
    expect(scan.mock.calls[1]?.[0]).toMatchObject({ width: 70, height: 84 });
  });
  it('bounds the hardest recovery to four model calls and remaps center-crop coordinates', async () => {
    const local = [
      { x: 5, y: 5 },
      { x: 60, y: 5 },
      { x: 60, y: 75 },
      { x: 5, y: 75 },
    ] as const;
    helpers.refine
      .mockResolvedValueOnce({ corners, support: 65, action: 'verify' })
      .mockResolvedValueOnce({ corners: local, support: 65, action: 'verify' });
    helpers.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const scan = vi
      .fn()
      .mockResolvedValueOnce(result(0.19))
      .mockResolvedValueOnce(result(0.8))
      .mockResolvedValueOnce(result(0.1))
      .mockResolvedValueOnce(result(0.99));
    const output = await detectStillCorners(image(), scan);
    expect(output.success).toBe(true);
    expect(output.corners?.topLeft).toEqual({ x: 20, y: 23 });
    expect(scan).toHaveBeenCalledTimes(4);
  });
});
