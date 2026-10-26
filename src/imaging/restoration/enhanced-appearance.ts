import type { FilterMode } from '../../domain/document';
import type { RgbaBackendInput } from '../engines/scanic-backend-contract';
import { analyzeDocumentQuality } from '../analysis/document-quality';
import { applyDocumentFilter } from '../rendering/document-filter';
import { enhanceColorContrast } from '../rendering/enhanced-color';
import type { LocalRestorationAnalysis } from './local-restoration-client';
import { applyShadowField, createShadowSample } from './shadow-field';

/** Optional AI appearance; all existing filters retain their exact synchronous policy. */
export async function applyFinalAppearance(
  input: RgbaBackendInput,
  mode: FilterMode,
  analysis?: LocalRestorationAnalysis,
): Promise<RgbaBackendInput> {
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
