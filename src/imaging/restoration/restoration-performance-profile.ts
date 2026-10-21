export interface RestorationDeviceSignals {
  readonly hasWebGpu: boolean;
  readonly hardwareConcurrency: number | null;
  readonly deviceMemoryGb: number | null;
  readonly saveData: boolean;
}

export interface RestorationPerformanceProfile {
  readonly tier: 'classical-only' | 'balanced' | 'quality';
  readonly allowNeuralDewarp: boolean;
  readonly allowNeuralDeblur: boolean;
  readonly allowGpuAppearance: boolean;
  readonly dewarpMaximumSide: number;
  readonly deblurMaximumSide: number;
}

const CLASSICAL_ONLY: RestorationPerformanceProfile = {
  tier: 'classical-only',
  allowNeuralDewarp: false,
  allowNeuralDeblur: false,
  allowGpuAppearance: false,
  dewarpMaximumSide: 0,
  deblurMaximumSide: 0,
};

export function chooseRestorationPerformanceProfile(
  signals: RestorationDeviceSignals,
): RestorationPerformanceProfile {
  if (!signals.hasWebGpu) return CLASSICAL_ONLY;

  const strongCpu = signals.hardwareConcurrency !== null && signals.hardwareConcurrency >= 6;
  const strongMemory = signals.deviceMemoryGb !== null && signals.deviceMemoryGb >= 6;
  if (strongCpu && strongMemory && !signals.saveData) {
    return {
      tier: 'quality',
      allowNeuralDewarp: true,
      allowNeuralDeblur: true,
      allowGpuAppearance: true,
      dewarpMaximumSide: 1024,
      deblurMaximumSide: 768,
    };
  }

  return {
    tier: 'balanced',
    allowNeuralDewarp: !signals.saveData,
    allowNeuralDeblur: !signals.saveData,
    allowGpuAppearance: true,
    dewarpMaximumSide: signals.saveData ? 0 : 768,
    deblurMaximumSide: signals.saveData ? 0 : 512,
  };
}
