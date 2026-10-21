import type { RestorationStage } from './restoration-policy';

export type AppliedRestorationStage = Exclude<RestorationStage, 'finger-segmentation' | 'demoire'>;

export type RestorationWarning = 'retake-finger' | 'unsupported-moire';
