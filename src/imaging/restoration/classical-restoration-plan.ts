import type {
  DocumentDefectScores,
  RestorationDecision,
  RestorationStage,
} from './restoration-policy';
import type { AppliedRestorationStage, RestorationWarning } from './restoration-types';

const HIGH_CONFIDENCE = 0.75;

function isClassicalStage(stage: RestorationStage): stage is AppliedRestorationStage {
  return stage !== 'finger-segmentation' && stage !== 'dewarp';
}

/** Converts classifier output into bounded pixel operations; no restoration model is loaded. */
export function createClassicalRestorationPlan(
  decision: RestorationDecision,
  scores: DocumentDefectScores,
): {
  readonly stages: readonly AppliedRestorationStage[];
  readonly warnings: readonly RestorationWarning[];
  readonly protectColor: boolean;
} {
  const warnings: RestorationWarning[] = [];
  if (scores.finger >= HIGH_CONFIDENCE) warnings.push('retake-finger');
  if (scores.curved >= HIGH_CONFIDENCE) warnings.push('retake-curved');
  if (scores.moire >= HIGH_CONFIDENCE) warnings.push('unsupported-moire');
  return {
    stages: decision.kind === 'enhance' ? decision.stages.filter(isClassicalStage) : [],
    warnings,
    protectColor: decision.protectColor,
  };
}
