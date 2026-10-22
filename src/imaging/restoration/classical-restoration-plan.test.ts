import { describe, expect, it } from 'vitest';

import type { DocumentDefectScores, RestorationDecision } from './restoration-policy';
import { createClassicalRestorationPlan } from './classical-restoration-plan';

const scores: DocumentDefectScores = {
  shadow: 0.82,
  curved: 0.91,
  blur: 0.86,
  moire: 0.8,
  finger: 0.78,
  lowContrast: 0.84,
  colorDocument: 0.2,
};

describe('classical restoration plan', () => {
  it('keeps fast pixel stages and reports defects that cannot be safely reconstructed', () => {
    const decision: RestorationDecision = {
      kind: 'enhance',
      stages: ['finger-segmentation', 'dewarp', 'deshadow', 'demoire', 'deblur', 'appearance'],
      protectColor: false,
    };

    expect(createClassicalRestorationPlan(decision, scores)).toEqual({
      stages: ['deshadow', 'demoire', 'deblur', 'appearance'],
      warnings: ['retake-finger', 'retake-curved', 'unsupported-moire'],
      protectColor: false,
    });
  });

  it('does no extra pixel work when the classifier selects the local route', () => {
    expect(
      createClassicalRestorationPlan(
        { kind: 'local', protectColor: true },
        { ...scores, finger: 0, curved: 0, moire: 0 },
      ),
    ).toEqual({ stages: [], warnings: [], protectColor: true });
  });
});
