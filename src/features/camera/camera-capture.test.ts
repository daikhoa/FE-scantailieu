import { afterEach, describe, expect, it, vi } from 'vitest';

import { CameraCaptureError, createCameraCapture } from './camera-capture';

function video(width = 1920, height = 1080, readyState = 2): HTMLVideoElement {
  return { videoWidth: width, videoHeight: height, readyState } as HTMLVideoElement;
}

function stream(): MediaStream {
  return { getVideoTracks: () => [{} as MediaStreamTrack] } as unknown as MediaStream;
}

function canvasFixture(blob: Blob | null = new Blob(['photo'], { type: 'image/png' })) {
  const drawImage = vi.fn();
  const toBlob = vi.fn((callback: BlobCallback) => {
    callback(blob);
  });
  const getContext = vi.fn(() => ({ drawImage }));
  const canvas = { width: 0, height: 0, getContext, toBlob } as unknown as HTMLCanvasElement;
  return { canvas, drawImage, toBlob };
}

describe('camera capture', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('freezes the current 4K frame before asynchronous encoding or still-photo delay', async () => {
    const fixture = canvasFixture();
    let finishEncoding: BlobCallback | undefined;
    fixture.toBlob.mockImplementationOnce((callback) => {
      finishEncoding = callback;
    });
    const takePhoto = vi.fn(() => new Promise<Blob>(() => undefined));
    const ImageCapture = vi.fn(function ImageCapture() {
      return { takePhoto };
    });
    vi.stubGlobal('ImageCapture', ImageCapture);
    const capture = createCameraCapture({ createCanvas: () => fixture.canvas });

    const result = capture.capture(stream(), video(3840, 2160), new AbortController().signal);

    expect(fixture.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 3840, 2160);
    expect(fixture.canvas.width).toBe(3840);
    expect(fixture.canvas.height).toBe(2160);
    expect(ImageCapture).not.toHaveBeenCalled();
    expect(takePhoto).not.toHaveBeenCalled();

    finishEncoding?.(new Blob(['frozen'], { type: 'image/png' }));
    await expect(result).resolves.toMatchObject({ type: 'image/png' });
    expect(fixture.canvas.width).toBe(1);
    expect(fixture.canvas.height).toBe(1);
  });

  it('encodes the frozen frame as lossless PNG', async () => {
    const fixture = canvasFixture();
    const capture = createCameraCapture({ createCanvas: () => fixture.canvas });

    const output = await capture.capture(stream(), video(1280, 720), new AbortController().signal);

    expect(output.type).toBe('image/png');
    expect(fixture.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1280, 720);
    expect(fixture.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png', undefined);
  });

  it('rejects unsafe video dimensions before allocating a canvas', async () => {
    const createCanvas = vi.fn(() => canvasFixture().canvas);
    const capture = createCameraCapture({ createCanvas });

    await expect(
      capture.capture(stream(), video(9000, 1000), new AbortController().signal),
    ).rejects.toEqual(new CameraCaptureError('invalid-input'));
    expect(createCanvas).not.toHaveBeenCalled();
  });

  it('sanitizes cancellation and releases the frozen canvas', async () => {
    const controller = new AbortController();
    const fixture = canvasFixture();
    fixture.drawImage.mockImplementationOnce(() => {
      controller.abort('private image data');
    });
    const capture = createCameraCapture({ createCanvas: () => fixture.canvas });

    await expect(capture.capture(stream(), video(), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Camera capture cancelled.',
    });
    expect(fixture.canvas.width).toBe(1);
    expect(fixture.canvas.height).toBe(1);
  });

  it('reports an honest failure when the browser cannot encode a frame', async () => {
    const capture = createCameraCapture({ createCanvas: () => canvasFixture(null).canvas });

    await expect(capture.capture(stream(), video(), new AbortController().signal)).rejects.toEqual(
      new CameraCaptureError('failed'),
    );
  });
});
