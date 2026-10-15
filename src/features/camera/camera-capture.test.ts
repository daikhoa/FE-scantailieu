import { afterEach, describe, expect, it, vi } from 'vitest';

import { CameraCaptureError, createCameraCapture } from './camera-capture';

function video(width = 1920, height = 1080, readyState = 2): HTMLVideoElement {
  return { videoWidth: width, videoHeight: height, readyState } as HTMLVideoElement;
}

function stream(track: MediaStreamTrack = {} as MediaStreamTrack): MediaStream {
  return { getVideoTracks: () => [track] } as unknown as MediaStream;
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

  it('prefers the highest safe still-photo resolution over the video frame', async () => {
    const stillPhoto = new Blob(['high-resolution-photo'], { type: 'image/jpeg' });
    const getPhotoCapabilities = vi.fn(() =>
      Promise.resolve({
        imageWidth: { min: 640, max: 4032, step: 1 },
        imageHeight: { min: 480, max: 3024, step: 1 },
      }),
    );
    const takePhoto = vi.fn(() => Promise.resolve(stillPhoto));
    const ImageCapture = vi.fn(function ImageCapture() {
      return { getPhotoCapabilities, takePhoto };
    });
    vi.stubGlobal('ImageCapture', ImageCapture);
    const fixture = canvasFixture();
    const track = {} as MediaStreamTrack;
    const capture = createCameraCapture({ createCanvas: () => fixture.canvas });

    const result = await capture.capture(stream(track), video(), new AbortController().signal);

    expect(result).toBe(stillPhoto);
    expect(ImageCapture).toHaveBeenCalledWith(track);
    expect(getPhotoCapabilities).toHaveBeenCalledOnce();
    expect(takePhoto).toHaveBeenCalledWith({ imageWidth: 4032, imageHeight: 3024 });
    expect(fixture.drawImage).not.toHaveBeenCalled();
  });

  it('encodes a lossless PNG fallback when still-photo capture is unavailable', async () => {
    const fixture = canvasFixture();
    const capture = createCameraCapture({ createCanvas: () => fixture.canvas });

    const output = await capture.capture(stream(), video(1280, 720), new AbortController().signal);

    expect(output.type).toBe('image/png');
    expect(fixture.canvas.width).toBe(1);
    expect(fixture.canvas.height).toBe(1);
    expect(fixture.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1280, 720);
    expect(fixture.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png', undefined);
  });

  it('falls back to the lossless video frame when takePhoto fails', async () => {
    const takePhoto = vi.fn(() => Promise.reject(new DOMException('hardware failure')));
    vi.stubGlobal(
      'ImageCapture',
      vi.fn(function ImageCapture() {
        return { takePhoto };
      }),
    );
    const fixture = canvasFixture();
    const capture = createCameraCapture({ createCanvas: () => fixture.canvas });

    const output = await capture.capture(stream(), video(), new AbortController().signal);

    expect(output.type).toBe('image/png');
    expect(takePhoto).toHaveBeenCalledOnce();
    expect(fixture.drawImage).toHaveBeenCalledOnce();
  });

  it('requests the largest still photo that fits the working pixel budget', async () => {
    const takePhoto = vi.fn<
      (settings?: { imageWidth: number; imageHeight: number }) => Promise<Blob>
    >(() => Promise.resolve(new Blob(['photo'], { type: 'image/jpeg' })));
    vi.stubGlobal(
      'ImageCapture',
      vi.fn(function ImageCapture() {
        return {
          getPhotoCapabilities: () =>
            Promise.resolve({
              imageWidth: { min: 640, max: 8000 },
              imageHeight: { min: 480, max: 6000 },
            }),
          takePhoto,
        };
      }),
    );
    const capture = createCameraCapture();

    await capture.capture(stream(), video(), new AbortController().signal);

    const settings = takePhoto.mock.calls[0]?.[0];
    expect(settings).toBeDefined();
    expect((settings?.imageWidth ?? 0) * (settings?.imageHeight ?? 0)).toBeLessThanOrEqual(
      16_777_216,
    );
    expect(settings?.imageWidth).toBeGreaterThan(4000);
    expect(settings?.imageHeight).toBeGreaterThan(3000);
  });

  it('cancels a pending still photo without falling back to another frame', async () => {
    const controller = new AbortController();
    const takePhoto = vi.fn(
      () =>
        new Promise<Blob>(() => {
          controller.abort('private image data');
        }),
    );
    vi.stubGlobal(
      'ImageCapture',
      vi.fn(function ImageCapture() {
        return { takePhoto };
      }),
    );
    const fixture = canvasFixture();
    const capture = createCameraCapture({ createCanvas: () => fixture.canvas });

    await expect(capture.capture(stream(), video(), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Camera capture cancelled.',
    });
    expect(fixture.drawImage).not.toHaveBeenCalled();
  });

  it('rejects unsafe video dimensions before allocating a canvas', async () => {
    const createCanvas = vi.fn(() => canvasFixture().canvas);
    const capture = createCameraCapture({ createCanvas });

    await expect(
      capture.capture(stream(), video(9000, 1000), new AbortController().signal),
    ).rejects.toEqual(new CameraCaptureError('invalid-input'));
    expect(createCanvas).not.toHaveBeenCalled();
  });

  it('sanitizes cancellation and releases the fallback canvas', async () => {
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
