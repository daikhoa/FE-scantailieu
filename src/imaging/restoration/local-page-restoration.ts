import type { ProcessedScanPage } from '../../features/scanner/background-page-processor';
import type { LocalRestorationClient } from './local-restoration-client';

export async function restoreProcessedPage(
  page: ProcessedScanPage,
  client: LocalRestorationClient,
  signal: AbortSignal,
): Promise<ProcessedScanPage> {
  const result = await client.restore(page.variant.image.blob, signal);
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
