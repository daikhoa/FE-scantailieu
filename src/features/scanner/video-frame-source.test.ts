import { afterEach, describe, expect, it, vi } from 'vitest';

import { createVideoFrameSource, PreviewFrameError } from './video-frame-source';

function video(width: number, height: number, readyState = 2): HTMLVideoElement {
  return { videoWidth: width, videoHeight: height, readyState } as HTMLVideoElement;
}

function canvasFixture() {
  const drawImage = vi.fn();
  const getImageData = vi.fn((_x: number, _y: number, width: number, height: number) => ({
    data: new Uint8ClampedArray(width * height * 4).fill(127),
  }));
  const getContext = vi.fn(() => ({ drawImage, getImageData }));
  const canvas = { width: 0, height: 0, getContext } as unknown as HTMLCanvasElement;
  return { canvas, drawImage, getImageData, getContext };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('video frame source', () => {
  it('downscales landscape preview frames without changing their aspect ratio', () => {
    const fixture = canvasFixture();
    const source = createVideoFrameSource({
      maxSide: 960,
      createCanvas: () => fixture.canvas,
    });
    const element = video(1920, 1080);

    const frame = source.capture(element, new AbortController().signal);

    expect(frame.dimensions).toEqual({ width: 960, height: 540 });
    expect(fixture.canvas.width).toBe(960);
    expect(fixture.canvas.height).toBe(540);
    expect(fixture.drawImage).toHaveBeenCalledWith(element, 0, 0, 960, 540);
    expect(fixture.getImageData).toHaveBeenCalledWith(0, 0, 960, 540);
    frame.close();
    frame.close();
    source.dispose();
  });

  it('does not upscale a smaller portrait frame', () => {
    const fixture = canvasFixture();
    const source = createVideoFrameSource({ createCanvas: () => fixture.canvas });

    const frame = source.capture(video(480, 640), new AbortController().signal);

    expect(frame.dimensions).toEqual({ width: 480, height: 640 });
    expect(fixture.canvas.width).toBe(480);
    expect(fixture.canvas.height).toBe(640);
    frame.close();
    source.dispose();
  });

  it('rejects an unready or malformed video before allocating a canvas', () => {
    const createCanvas = vi.fn(() => canvasFixture().canvas);
    const source = createVideoFrameSource({ createCanvas });

    expect(() => source.capture(video(1920, 1080, 1), new AbortController().signal)).toThrow(
      new PreviewFrameError('unavailable'),
    );
    expect(() => source.capture(video(0, 1080), new AbortController().signal)).toThrow(
      new PreviewFrameError('invalid-input'),
    );
    expect(createCanvas).not.toHaveBeenCalled();
    source.dispose();
  });

  it('sanitizes cancellation before and during extraction', () => {
    const before = new AbortController();
    before.abort('private document data');
    const createCanvas = vi.fn(() => canvasFixture().canvas);
    const source = createVideoFrameSource({ createCanvas });

    expect(() => source.capture(video(640, 480), before.signal)).toThrow(
      expect.objectContaining({ name: 'AbortError', message: 'Preview frame capture cancelled.' }),
    );
    expect(createCanvas).not.toHaveBeenCalled();

    const during = new AbortController();
    const fixture = canvasFixture();
    fixture.drawImage.mockImplementationOnce(() => {
      during.abort('private document data');
    });
    const activeSource = createVideoFrameSource({ createCanvas: () => fixture.canvas });

    expect(() => activeSource.capture(video(640, 480), during.signal)).toThrow(
      expect.objectContaining({ name: 'AbortError', message: 'Preview frame capture cancelled.' }),
    );
    expect(fixture.getImageData).not.toHaveBeenCalled();
    source.dispose();
    activeSource.dispose();
  });

  it('returns safe failures for unavailable canvas APIs and extraction errors', () => {
    const missingContext = canvasFixture();
    missingContext.getContext.mockReturnValueOnce(null as never);
    const unavailable = createVideoFrameSource({ createCanvas: () => missingContext.canvas });
    expect(() => unavailable.capture(video(640, 480), new AbortController().signal)).toThrow(
      new PreviewFrameError('unavailable'),
    );

    const broken = canvasFixture();
    broken.getImageData.mockImplementationOnce(() => {
      throw new Error('private browser canvas error');
    });
    const failed = createVideoFrameSource({ createCanvas: () => broken.canvas });
    expect(() => failed.capture(video(640, 480), new AbortController().signal)).toThrow(
      new PreviewFrameError('failed'),
    );
    unavailable.dispose();
    failed.dispose();
  });

  it('releases its backing canvas and rejects captures after disposal', () => {
    const fixture = canvasFixture();
    const source = createVideoFrameSource({ createCanvas: () => fixture.canvas });
    const frame = source.capture(video(640, 480), new AbortController().signal);
    frame.close();

    source.dispose();

    expect(fixture.canvas.width).toBe(0);
    expect(fixture.canvas.height).toBe(0);
    expect(() => source.capture(video(640, 480), new AbortController().signal)).toThrow(
      new PreviewFrameError('unavailable'),
    );
  });

  it('rejects unsafe configuration immediately', () => {
    expect(() => createVideoFrameSource({ maxSide: 0 })).toThrow(RangeError);
    expect(() => createVideoFrameSource({ maxSide: 9000 })).toThrow(RangeError);
  });
});
