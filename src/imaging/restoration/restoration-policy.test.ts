import { describe, expect, it } from 'vitest';

import { decideRestorationPolicy } from './restoration-policy';

const cleanScores = {
  shadow: 0.05,
  curved: 0.04,
  blur: 0.08,
  moire: 0.02,
  finger: 0.01,
  lowContrast: 0.09,
  colorDocument: 0.1,
} as const;

describe('decideRestorationPolicy', () => {
  it('keeps a clean document on the local pipeline', () => {
    expect(
      decideRestorationPolicy({
        scores: cleanScores,
        evidence: { illuminationRange: 4, highlightRatio: 0.02, detail: 'high' },
      }),
    ).toEqual({ kind: 'local', protectColor: false });
  });

  it('orders only the specialist GPU stages supported by high-confidence defects', () => {
    expect(
      decideRestorationPolicy({
        scores: {
          ...cleanScores,
          shadow: 0.91,
          curved: 0.84,
          blur: 0.78,
          moire: 0.8,
          lowContrast: 0.88,
          colorDocument: 0.72,
        },
        evidence: { illuminationRange: 32, highlightRatio: 0.1, detail: 'low' },
      }),
    ).toEqual({
      kind: 'gpu',
      stages: ['dewarp', 'deshadow', 'demoire', 'deblur', 'appearance'],
      protectColor: true,
    });
  });

  it('uses bounded classical evidence to confirm a medium-confidence shadow', () => {
    expect(
      decideRestorationPolicy({
        scores: { ...cleanScores, shadow: 0.58 },
        evidence: { illuminationRange: 24, highlightRatio: 0.12, detail: 'medium' },
      }),
    ).toEqual({ kind: 'gpu', stages: ['deshadow'], protectColor: false });
  });

  it('does not run shadow restoration when highlights are already heavily clipped', () => {
    expect(
      decideRestorationPolicy({
        scores: { ...cleanScores, shadow: 0.58 },
        evidence: { illuminationRange: 24, highlightRatio: 0.7, detail: 'medium' },
      }),
    ).toEqual({ kind: 'local', protectColor: false });
  });

  it('requests finger segmentation instead of pretending hidden content can be restored', () => {
    expect(
      decideRestorationPolicy({
        scores: { ...cleanScores, finger: 0.86 },
        evidence: { illuminationRange: 4, highlightRatio: 0.02, detail: 'high' },
      }),
    ).toEqual({ kind: 'gpu', stages: ['finger-segmentation'], protectColor: false });
  });

  it('rejects non-finite or out-of-range model scores at the trust boundary', () => {
    expect(() =>
      decideRestorationPolicy({
        scores: { ...cleanScores, blur: Number.NaN },
        evidence: { illuminationRange: 4, highlightRatio: 0.02, detail: 'high' },
      }),
    ).toThrow(RangeError);

    expect(() =>
      decideRestorationPolicy({
        scores: { ...cleanScores, moire: 1.01 },
        evidence: { illuminationRange: 4, highlightRatio: 0.02, detail: 'high' },
      }),
    ).toThrow(RangeError);
  });
});
