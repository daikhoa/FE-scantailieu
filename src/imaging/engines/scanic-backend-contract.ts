import type { LocalRestorationAnalysis } from '../restoration/local-restoration-client';
import type {
  DocumentCorners,
  FilterMode,
  ImageDimensions,
  QuarterTurn,
} from '../../domain/document';

export { ScannerEngineError } from './scanner-engine-error';

export interface RgbaBackendInput {
  readonly dimensions: ImageDimensions;
  readonly pixels: Uint8ClampedArray<ArrayBuffer>;
  readonly timings?: { readonly warp3000: number; readonly restorationFilter: number };
}

/** Internal adapter seam: no vendor/DOM image types escape the backend. */
export interface ClassicalBackend {
  initialize: () => Promise<void>;
  detect: (input: RgbaBackendInput) => Promise<unknown>;
  warp: (
    input: RgbaBackendInput,
    corners: DocumentCorners,
    rotation: QuarterTurn,
    filter: FilterMode,
    maximumOutputLongSide?: number,
    analysis?: LocalRestorationAnalysis,
  ) => Promise<RgbaBackendInput>;
  /** Must settle outstanding work, including termination of its owned worker. */
  dispose: () => Promise<void>;
}
