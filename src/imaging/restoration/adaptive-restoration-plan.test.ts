import { describe, expect, it } from 'vitest';
import { analyzeDocumentQuality } from '../analysis/document-quality';
import { createAdaptiveRestorationPlan } from './adaptive-restoration-plan';
import type { DocumentDefectScores } from './restoration-policy';

const scores: DocumentDefectScores = {
  shadow: 0.48,
  curved: 0,
  blur: 0.55,
  moire: 0,
  finger: 0,
  lowContrast: 0,
  colorDocument: 0,
};
function quality(shadow = false) {
  const pixels = new Uint8ClampedArray(64 * 64 * 4);
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++)
      pixels.set(
        [shadow ? 70 + x * 2 : 215, shadow ? 70 + x * 2 : 215, shadow ? 70 + x * 2 : 215, 255],
        (y * 64 + x) * 4,
      );
  return analyzeDocumentQuality({ dimensions: { width: 64, height: 64 }, pixels });
}
describe('adaptive restoration plan', () => {
  it('rejects corrupt classifier scores instead of applying NaN strengths', () => {
    expect(() => createAdaptiveRestorationPlan({ ...scores, blur: NaN }, quality())).toThrow(
      RangeError,
    );
  });
  it('requires measured uneven lighting before deshadowing and varies strength continuously', () => {
    expect(createAdaptiveRestorationPlan(scores, quality()).strengths?.shadow).toBe(0);
    const mild = createAdaptiveRestorationPlan(scores, quality(true));
    const strong = createAdaptiveRestorationPlan({ ...scores, shadow: 0.82 }, quality(true));
    expect(strong.strengths?.shadow).toBeGreaterThan(mild.strengths?.shadow ?? 0);
    expect(strong.strengths?.shadow).toBeLessThanOrEqual(1);
  });
  it('bounds sharpening and warns about severe blur, fingers and curved pages', () => {
    const plan = createAdaptiveRestorationPlan(
      { ...scores, blur: 0.95, finger: 0.9, curved: 0.9 },
      quality(),
    );
    expect(plan.warnings).toEqual(
      expect.arrayContaining(['retake-blur', 'retake-finger', 'retake-curved']),
    );
    expect(plan.strengths?.sharpen).toBeLessThanOrEqual(0.8);
  });
  it('protects colored documents and avoids sharpening high-detail input', () => {
    const measured = quality();
    const plan = createAdaptiveRestorationPlan(
      { ...scores, colorDocument: 0.9 },
      { ...measured, detail: { kind: 'high', edgeScore: 60 } },
    );
    expect(plan.protectColor).toBe(true);
    expect(plan.strengths?.sharpen).toBe(0);
    expect(plan.strengths?.lift).toBeLessThanOrEqual(0.15);
  });
});
