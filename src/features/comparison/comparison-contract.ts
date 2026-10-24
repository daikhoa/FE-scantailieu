import type { DocumentCorners, ImageAsset } from '../../domain/document';

export type ComparisonEngine = 'web' | 'cpp';
export type ComparisonFilter = 'original' | 'enhanced-color';
// Typical "48 MP" files can contain 8064 × 6048 pixels. Never resize to fit.
export const MAX_COMPARISON_INPUT_PIXELS = 50_000_000;
export interface ComparisonInput {
  readonly asset: ImageAsset;
  readonly corners: DocumentCorners;
  readonly filter: ComparisonFilter;
  readonly repetitions: number;
}
export interface ComparisonSample {
  readonly decodeMs: number;
  readonly processMs: number;
  readonly encodeMs: number;
  readonly totalMs: number;
  readonly inputPixelBytes: number;
  readonly outputPixelBytes: number;
  readonly wasmReservedBytes: number | null;
}
export type ComparisonCommand =
  | { readonly type: 'initialize'; readonly engine: ComparisonEngine }
  | { readonly type: 'run'; readonly input: ComparisonInput };
export type ComparisonReply =
  | { readonly type: 'ready' }
  | { readonly type: 'sample'; readonly sample: ComparisonSample }
  | { readonly type: 'done'; readonly image: ImageAsset }
  | { readonly type: 'error'; readonly code: 'invalid-input' | 'unavailable' | 'failed' };
export interface ComparisonResult {
  readonly engine: ComparisonEngine;
  readonly setupMs: number;
  readonly wallMs: number;
  readonly samples: readonly ComparisonSample[];
  readonly image: ImageAsset;
}

export function validateComparisonInput(input: ComparisonInput): void {
  const { width, height } = input.asset.dimensions;
  if (
    !(input.asset.blob instanceof Blob) ||
    input.asset.blob.size === 0 ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 16384 ||
    height > 16384 ||
    width * height > MAX_COMPARISON_INPUT_PIXELS ||
    !Number.isInteger(input.repetitions) ||
    input.repetitions < 1 ||
    input.repetitions > 20 ||
    !['original', 'enhanced-color'].includes(input.filter) ||
    // Structured-cloned messages still require runtime tuple validation.
    (input.corners as readonly unknown[]).length !== 4 ||
    input.corners.some(
      (p) =>
        !Number.isFinite(p.x) ||
        !Number.isFinite(p.y) ||
        p.x < 0 ||
        p.y < 0 ||
        p.x > width ||
        p.y > height,
    )
  )
    throw new Error('invalid-input');
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) return null;
  return sorted.length % 2 ? upper : ((sorted[middle - 1] ?? upper) + upper) / 2;
}
