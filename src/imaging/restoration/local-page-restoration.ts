import type { EditRecipe } from '../../domain/document';
import type { ProcessedScanPage } from '../../features/scanner/background-page-processor';
import type {
  LocalRestorationClient,
  LocalRestorationRequestOptions,
} from './local-restoration-client';

export function canReuseRestorationAnalysis(previous: EditRecipe, next: EditRecipe): boolean {
  const left = previous.crop;
  const right = next.crop;
  if (left.kind !== right.kind) return false;
  if (left.kind === 'full-frame' || right.kind === 'full-frame') return true;
  return left.corners.every((point, index) => {
    const candidate = right.corners[index];
    return candidate !== undefined && point.x === candidate.x && point.y === candidate.y;
  });
}

export async function restoreProcessedPage(
  page: ProcessedScanPage,
  client: LocalRestorationClient,
  signal: AbortSignal,
  options?: LocalRestorationRequestOptions,
): Promise<ProcessedScanPage> {
  const result = await client.restore(page.variant.image.blob, signal, options);
  if (result.route === 'local' || result.image === undefined || result.provider === null) {
    return {
      ...page,
      restoration: {
        kind: 'classified-local',
        classifierModel: result.classifierModel,
        warnings: result.warnings,
      },
    };
  }
  return {
    ...page,
    variant: {
      ...page.variant,
      image: result.image,
      engineVersion: `${page.variant.engineVersion}+local-ai:${result.provider}`,
      dewarp: result.stages.includes('dewarp')
        ? { kind: 'applied', modelVersion: result.provider }
        : page.variant.dewarp,
    },
    restoration: {
      kind: 'applied',
      stages: result.stages,
      classifierModel: result.classifierModel,
      provider: result.provider,
      warnings: result.warnings,
    },
  };
}
