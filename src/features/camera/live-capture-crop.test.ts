import { describe, expect, it } from 'vitest';

import { mapLiveDetectionToCrop } from './live-capture-crop';

describe('mapLiveDetectionToCrop', () => {
  it('keeps the complete captured image when the live frame has no document', () => {
    expect(mapLiveDetectionToCrop(null, { width: 1200, height: 1600 })).toEqual({
      kind: 'full-frame',
    });
    expect(
      mapLiveDetectionToCrop(
        {
          kind: 'full-frame',
          dimensions: { width: 600, height: 800 },
          reason: 'no-document',
        },
        { width: 1200, height: 1600 },
      ),
    ).toEqual({ kind: 'full-frame' });
  });

  it('maps the detected live corners to the captured image dimensions', () => {
    expect(
      mapLiveDetectionToCrop(
        {
          kind: 'document',
          dimensions: { width: 600, height: 800 },
          confidence: 0.91,
          corners: [
            { x: 30, y: 40 },
            { x: 570, y: 40 },
            { x: 570, y: 760 },
            { x: 30, y: 760 },
          ],
        },
        { width: 1200, height: 1600 },
      ),
    ).toEqual({
      kind: 'document',
      corners: [
        { x: 60, y: 80 },
        { x: 1140, y: 80 },
        { x: 1140, y: 1520 },
        { x: 60, y: 1520 },
      ],
    });
  });

  it('maps a narrower live frame into the centered matching area of a wider photo', () => {
    expect(
      mapLiveDetectionToCrop(
        {
          kind: 'document',
          dimensions: { width: 100, height: 100 },
          confidence: 0.9,
          corners: [
            { x: 10, y: 10 },
            { x: 90, y: 10 },
            { x: 90, y: 90 },
            { x: 10, y: 90 },
          ],
        },
        { width: 200, height: 100 },
      ),
    ).toEqual({
      kind: 'document',
      corners: [
        { x: 60, y: 10 },
        { x: 140, y: 10 },
        { x: 140, y: 90 },
        { x: 60, y: 90 },
      ],
    });
  });
});
