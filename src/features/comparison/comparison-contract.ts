import type { DocumentCorners, ImageAsset } from '../../domain/document';

export type ComparisonEngine = 'web' | 'cpp' | 'opencv';
export type OpenCvPreset = 'gentle' | 'balanced' | 'text';
export const COMPARISON_WASM_BASE = '/docscan-wasm/v3/';
export const COMPARISON_IMPLEMENTATIONS = {
  web: 'web-filter-v10',
  cpp: 'custom-cpp-wasm-v3',
  opencv: 'opencv-adaptive-v2-wasm-v3',
} as const;
export const COMPARISON_LABELS = {
  web: 'Web hiện tại',
  cpp: 'C++ tự viết',
  opencv: 'C++ OpenCV',
} as const;
export const OPENCV_PRESET_LABELS = {
  gentle: 'Nhẹ',
  balanced: 'Cân bằng',
  text: 'Rõ chữ',
} as const;
export const COMPARISON_PAIRS = {
  'web-opencv': ['web', 'opencv'],
  'cpp-opencv': ['cpp', 'opencv'],
  'web-cpp': ['web', 'cpp'],
} as const;
export type ComparisonFilter = 'original' | 'enhanced-color';
// Typical "48 MP" files can contain 8064 × 6048 pixels. Never resize to fit.
export const MAX_COMPARISON_INPUT_PIXELS = 50_000_000;
export interface ComparisonInput {
  readonly asset: ImageAsset;
  readonly corners: DocumentCorners;
  readonly filter: ComparisonFilter;
  readonly repetitions: number;
  readonly opencvPreset?: OpenCvPreset;
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
  readonly filter: ComparisonFilter;
  readonly implementation: string;
  readonly opencvPreset?: OpenCvPreset;
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
    (input.opencvPreset !== undefined &&
      !Object.hasOwn(OPENCV_PRESET_LABELS, input.opencvPreset)) ||
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
