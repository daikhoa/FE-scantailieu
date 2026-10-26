import type { FilterMode } from '../../domain/document';
import type { RgbaBackendInput } from '../engines/scanic-backend-contract';
import { analyzeDocumentQuality } from '../analysis/document-quality';
import { applyDocumentFilter } from '../rendering/document-filter';
import { enhanceColorContrast } from '../rendering/enhanced-color';
import type { LocalRestorationAnalysis } from './local-restoration-client';
import { applyShadowField, createShadowSample } from './shadow-field';
import { analyzeEnhancement, applyEnhancement } from './adaptive-enhancement';

/** Shared orchestration only: the browser C++ adapter applies this field with its own kernel. */
export async function prepareEnhancedAppearance(input: RgbaBackendInput) {
  const sample = createShadowSample(input);
  const periodic = analyzeDocumentQuality(input).detail.periodicRatio;
  let plan = analyzeEnhancement(sample, undefined, periodic);
  let enhancement: NonNullable<RgbaBackendInput['enhancement']> = 'local';
  if (plan.needsModel) {
    try {
      const { predictIllumination } = await import('./gcnet-runtime');
      plan = analyzeEnhancement(sample, await predictIllumination(sample), periodic);
      enhancement = 'shadow-model';
    } catch {
      // No pixels have changed. Carry conservative fallback through cache identity and preview.
      enhancement = 'model-unavailable';
    }
  }
  return { plan, enhancement };
}

/** Default adaptive appearance; explicit legacy filters retain their synchronous policy. */
export async function applyFinalAppearance(
  input: RgbaBackendInput,
  mode: FilterMode,
  analysis?: LocalRestorationAnalysis,
): Promise<RgbaBackendInput> {
  if (mode === 'enhanced-color') {
    const { plan, enhancement } = await prepareEnhancedAppearance(input);
    applyEnhancement(input, plan);
    return { ...input, enhancement };
  }
  if (mode !== 'shadow-removal') return applyDocumentFilter(input, mode, analysis);
  const sample = createShadowSample(input);
  const { predictIllumination } = await import('./gcnet-runtime');
  const field = await predictIllumination(sample);
  applyShadowField(input, field);
  // Analyse corrected paper, never reuse black/white references from the shadowed image.
  const quality = analyzeDocumentQuality(input);
  enhanceColorContrast(input, quality.brightness, quality.detail, quality.color);
  return input;
}
