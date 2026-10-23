import { SCANIC_ML_ASSET_BASE } from './scanic-ml-assets';
import { Scanner, type DetectionOptions, type ScannerResult } from 'scanic';

export type ScanicDetectorKind = 'ml';

export const SCANIC_ML_MIN_SCORE = 0.5;
export const SCANIC_CLASSICAL_MIN_CONFIDENCE = 0.72;

const COMMON_OPTIONS = {
  mode: 'detect',
  output: 'imagedata',
  debug: false,
  maxProcessingDimension: 8192,
} as const satisfies DetectionOptions;

function detectorOptions(): DetectionOptions {
  return {
    ...COMMON_OPTIONS,
    detector: 'ml',
    ml: {
      assetBaseUrl: SCANIC_ML_ASSET_BASE,
      numThreads: 1,
      minScore: SCANIC_ML_MIN_SCORE,
      modelFetchTimeoutMs: 30_000,
    },
  };
}

export interface ScanicDetectorResult extends ScannerResult {
  readonly detector: ScanicDetectorKind;
}

type ScanicScanner = Pick<Scanner, 'initialize' | 'scan'>;
type ScanicScannerFactory = (options: DetectionOptions) => ScanicScanner;

/** One ML session per realm. Recovery must destroy the worker: Scanic caches ONNX globally. */
export class ScanicDetectorRuntime {
  private readonly scanner: ScanicScanner;

  constructor(createScanner: ScanicScannerFactory = (options) => new Scanner(options)) {
    this.scanner = createScanner(detectorOptions());
  }

  async initialize(): Promise<void> {
    await this.scanner.initialize();
  }

  async scan(image: ImageData): Promise<ScanicDetectorResult> {
    return { ...(await this.scanner.scan(image, detectorOptions())), detector: 'ml' };
  }
}
