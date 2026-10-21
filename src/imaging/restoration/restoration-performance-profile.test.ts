import { describe, expect, it } from 'vitest';

import { chooseRestorationPerformanceProfile } from './restoration-performance-profile';

describe('restoration performance profile', () => {
  it('keeps large neural models off CPU-only devices', () => {
    expect(
      chooseRestorationPerformanceProfile({
        hasWebGpu: false,
        hardwareConcurrency: 8,
        deviceMemoryGb: 8,
        saveData: false,
      }),
    ).toEqual({
      tier: 'classical-only',
      allowNeuralDewarp: false,
      allowNeuralDeblur: false,
      allowGpuAppearance: false,
      dewarpMaximumSide: 0,
      deblurMaximumSide: 0,
    });
  });

  it('uses smaller neural inputs on constrained WebGPU devices', () => {
    expect(
      chooseRestorationPerformanceProfile({
        hasWebGpu: true,
        hardwareConcurrency: 4,
        deviceMemoryGb: 4,
        saveData: false,
      }),
    ).toEqual({
      tier: 'balanced',
      allowNeuralDewarp: true,
      allowNeuralDeblur: true,
      allowGpuAppearance: true,
      dewarpMaximumSide: 768,
      deblurMaximumSide: 512,
    });
  });

  it('uses the quality profile only when GPU and memory signals are strong', () => {
    expect(
      chooseRestorationPerformanceProfile({
        hasWebGpu: true,
        hardwareConcurrency: 8,
        deviceMemoryGb: 8,
        saveData: false,
      }),
    ).toMatchObject({
      tier: 'quality',
      dewarpMaximumSide: 1024,
      deblurMaximumSide: 768,
    });
  });

  it('avoids downloading optional models when data saving is requested', () => {
    expect(
      chooseRestorationPerformanceProfile({
        hasWebGpu: true,
        hardwareConcurrency: 8,
        deviceMemoryGb: 8,
        saveData: true,
      }),
    ).toMatchObject({
      tier: 'balanced',
      allowNeuralDewarp: false,
      allowNeuralDeblur: false,
      allowGpuAppearance: true,
    });
  });
});
