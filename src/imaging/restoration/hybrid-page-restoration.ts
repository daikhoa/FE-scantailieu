import type { ProcessedScanPage } from '../../features/scanner/background-page-processor';
import type { HybridRestorationClient } from './hybrid-restoration-client';

export async function restoreProcessedPage(
  page: ProcessedScanPage,
  client: HybridRestorationClient,
  signal: AbortSignal,
): Promise<ProcessedScanPage> {
  const result = await client.restore(page.variant.image.blob, signal);
  if (result.route === 'local') {
    return {
      ...page,
      restoration: {
        kind: 'classified-local',
        classifierModel: result.classifierModel,
      },
    };
  }
  if (result.provider === null) throw new Error('GPU restoration result is missing its provider');
  return {
    ...page,
    variant: {
      ...page.variant,
      image: result.image,
      engineVersion: `${page.variant.engineVersion}+hybrid:${result.provider}`,
      dewarp: result.stages.includes('dewarp')
        ? { kind: 'applied', modelVersion: result.provider }
        : page.variant.dewarp,
    },
    restoration: {
      kind: 'applied',
      stages: result.stages,
      classifierModel: result.classifierModel,
      provider: result.provider,
    },
  };
}
