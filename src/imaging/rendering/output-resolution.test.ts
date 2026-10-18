import { describe, expect, it } from 'vitest';

import { resolveHighQualityOutputDimensions } from './output-resolution';

describe('high-quality perspective output resolution', () => {
  it('raises a foreshortened document to a 3000-pixel long side when the source supports it', () => {
    expect(
      resolveHighQualityOutputDimensions(
        [
          { x: 200, y: 200 },
          { x: 1400, y: 200 },
          { x: 1400, y: 1800 },
          { x: 200, y: 1800 },
        ],
        { width: 3000, height: 4000 },
      ),
    ).toEqual({ width: 2250, height: 3000 });
  });

  it('does not enlarge an image whose source is below the quality target', () => {
    expect(
      resolveHighQualityOutputDimensions(
        [
          { x: 100, y: 100 },
          { x: 900, y: 100 },
          { x: 900, y: 1300 },
          { x: 100, y: 1300 },
        ],
        { width: 1500, height: 2000 },
      ),
    ).toEqual({ width: 801, height: 1200 });
  });

  it('does not downscale a document already larger than the quality target', () => {
    expect(
      resolveHighQualityOutputDimensions(
        [
          { x: 0, y: 0 },
          { x: 4000, y: 0 },
          { x: 4000, y: 3000 },
          { x: 0, y: 3000 },
        ],
        { width: 4000, height: 3000 },
      ),
    ).toEqual({ width: 4000, height: 3000 });
  });
});
