import type { DocumentCorners, ImageAsset, RenderedVariant } from '../../domain/document';
import type { ComparisonFailureCode, ComparisonStage } from './comparison-error';

export type ComparisonEngine = 'web' | 'cpp';
export const COMPARISON_WASM_BASE = '/docscan-wasm/v8/';
export const COMPARISON_IMPLEMENTATIONS = {
  web: 'web-warp+adaptive-js-v1',
  cpp: 'custom-cpp-warp+adaptive-cpp-wasm-v8',
} as const;
export const COMPARISON_LABELS = {
  web: 'Web hiện tại',
  cpp: 'C++ tự viết',
} as const;
export type ComparisonFilter = 'original' | 'enhanced-color' | 'shadow-removal';
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
  | {
      readonly type: 'done';
      readonly image: ImageAsset;
      readonly enhancement?: RenderedVariant['enhancement'];
      readonly enhancementFailure?: RenderedVariant['enhancementFailure'];
    }
  | {
      readonly type: 'error';
      readonly code: ComparisonFailureCode;
      readonly stage?: ComparisonStage;
    };
export interface ComparisonResult {
  readonly enhancementFailure?: RenderedVariant['enhancementFailure'];
  readonly enhancement?: RenderedVariant['enhancement'];
  readonly engine: ComparisonEngine;
  readonly setupMs: number;
  readonly wallMs: number;
  readonly samples: readonly ComparisonSample[];
  readonly image: ImageAsset;
  readonly filter: ComparisonFilter;
  readonly implementation: string;
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
    !['original', 'enhanced-color', 'shadow-removal'].includes(input.filter) ||
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
