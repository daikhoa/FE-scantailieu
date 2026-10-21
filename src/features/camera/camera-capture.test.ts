import { afterEach, describe, expect, it, vi } from 'vitest';

import { CameraCaptureError, createCameraCapture } from './camera-capture';

function video(width = 1920, height = 1080, readyState = 2): HTMLVideoElement {
  return { videoWidth: width, videoHeight: height, readyState } as HTMLVideoElement;
}

function stream(): MediaStream {
  return { getVideoTracks: () => [{} as MediaStreamTrack] } as unknown as MediaStream;
}

function canvasFixture() {
  const drawImage = vi.fn();
  const getImageData = vi.fn((_x: number, _y: number, width: number, height: number) => ({
    data: new Uint8ClampedArray(width * height * 4),
  }));
  const toBlob = vi.fn();
  const getContext = vi.fn(() => ({ drawImage, getImageData }));
  const canvas = { width: 0, height: 0, getContext, toBlob } as unknown as HTMLCanvasElement;
  return { canvas, drawImage, getImageData, toBlob };
}

describe('camera capture', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('freezes the current 4K frame immediately without still-photo delay', async () => {
    const fixture = canvasFixture();
    const takePhoto = vi.fn(() => new Promise<Blob>(() => undefined));
    const ImageCapture = vi.fn(function ImageCapture() {
      return { takePhoto };
    });
    vi.stubGlobal('ImageCapture', ImageCapture);
    const capture = createCameraCapture({ createCanvas: () => fixture.canvas });

    const result = capture.capture(stream(), video(3840, 2160), new AbortController().signal);

    expect(fixture.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 3840, 2160);
    expect(ImageCapture).not.toHaveBeenCalled();
    expect(takePhoto).not.toHaveBeenCalled();

    await expect(result).resolves.toMatchObject({
      kind: 'rgba-frame',
      dimensions: { width: 3840, height: 2160 },
    });
    expect(fixture.getImageData).toHaveBeenCalledWith(0, 0, 3840, 2160);
    expect(fixture.toBlob).not.toHaveBeenCalled();
    expect(fixture.canvas.width).toBe(1);
    expect(fixture.canvas.height).toBe(1);
  });

  it('returns raw RGBA pixels for direct worker processing', async () => {
    const fixture = canvasFixture();
    const capture = createCameraCapture({ createCanvas: () => fixture.canvas });

    const output = await capture.capture(stream(), video(1280, 720), new AbortController().signal);

    expect(output).toMatchObject({
      kind: 'rgba-frame',
      dimensions: { width: 1280, height: 720 },
    });
    expect(output).not.toBeInstanceOf(Blob);
    expect(fixture.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1280, 720);
    expect(fixture.toBlob).not.toHaveBeenCalled();
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

  it('reports an honest failure when the browser cannot read pixels', async () => {
    const fixture = canvasFixture();
    fixture.getImageData.mockImplementationOnce(() => {
      throw new DOMException('blocked');
    });
    const capture = createCameraCapture({ createCanvas: () => fixture.canvas });

    await expect(capture.capture(stream(), video(), new AbortController().signal)).rejects.toEqual(
      new CameraCaptureError('failed'),
    );
  });
});
