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

export function discardTransientRestorationPixels(page: ProcessedScanPage): ProcessedScanPage {
  const { transientRgba: _transientRgba, ...variant } = page.variant;
  return _transientRgba === undefined ? page : { ...page, variant };
}

export async function restoreProcessedPage(
  page: ProcessedScanPage,
  client: LocalRestorationClient,
  signal: AbortSignal,
  options?: LocalRestorationRequestOptions,
): Promise<ProcessedScanPage> {
  const transient = page.variant.transientRgba;
  const source =
    transient === undefined ? page.variant.image.blob : { kind: 'rgba-frame' as const, ...transient };
  const result = await client.restore(source, signal, options);
  const persistentPage = discardTransientRestorationPixels(page);
  if (result.route === 'local' || result.image === undefined || result.provider === null) {
    return {
      ...persistentPage,
      restoration: {
        kind: 'classified-local',
        classifierModel: result.classifierModel,
        warnings: result.warnings,
      },
    };
  }
  return {
    ...persistentPage,
    variant: {
      ...persistentPage.variant,
      image: result.image,
      engineVersion: `${page.variant.engineVersion}+local-ai:${result.provider}`,
      dewarp: result.stages.includes('dewarp')
        ? { kind: 'applied', modelVersion: result.provider }
        : persistentPage.variant.dewarp,
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
