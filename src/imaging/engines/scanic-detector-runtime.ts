import { Scanner, type DetectionOptions, type ScannerResult } from 'scanic';

export type ScanicDetectorKind = 'ml' | 'classical';

export const SCANIC_ML_MIN_SCORE = 0.5;
export const SCANIC_CLASSICAL_MIN_CONFIDENCE = 0.72;

const COMMON_OPTIONS = {
  mode: 'detect',
  output: 'imagedata',
  debug: false,
  maxProcessingDimension: 8192,
} as const satisfies DetectionOptions;

function detectorOptions(detector: ScanicDetectorKind): DetectionOptions {
  if (detector === 'ml') {
    return {
      ...COMMON_OPTIONS,
      detector,
      ml: {
        assetBaseUrl: '/scanic-ml/',
        minScore: SCANIC_ML_MIN_SCORE,
        modelFetchTimeoutMs: 30_000,
      },
    };
  }
  return {
    ...COMMON_OPTIONS,
    detector,
    minDetectionConfidence: SCANIC_CLASSICAL_MIN_CONFIDENCE,
  };
}

export interface ScanicDetectorResult extends ScannerResult {
  readonly detector: ScanicDetectorKind;
}

type ScanicScanner = Pick<Scanner, 'initialize' | 'scan'>;
type ScanicScannerFactory = (options: DetectionOptions) => ScanicScanner;

/** Uses Scanic ML first, retries once, then falls back to classical only on runtime failure. */
export class ScanicDetectorRuntime {
  private detector: ScanicDetectorKind = 'ml';
  private scanner: ScanicScanner;

  constructor(
    private readonly createScanner: ScanicScannerFactory = (options) => new Scanner(options),
  ) {
    this.scanner = createScanner(detectorOptions('ml'));
  }

  async initialize(): Promise<void> {
    await this.scanner.initialize();
  }

  async scan(image: ImageData): Promise<ScanicDetectorResult> {
    try {
      return {
        ...(await this.scanner.scan(image, detectorOptions(this.detector))),
        detector: this.detector,
      };
    } catch (error) {
      if (this.detector !== 'ml') throw error;
      try {
        const recovered = this.createScanner(detectorOptions('ml'));
        await recovered.initialize();
        const result = await recovered.scan(image, detectorOptions('ml'));
        this.scanner = recovered;
        return { ...result, detector: 'ml' };
      } catch {
        // Two independent ML runtimes failed consecutively; use the bounded classical fallback.
      }
      this.detector = 'classical';
      this.scanner = this.createScanner(detectorOptions('classical'));
      await this.scanner.initialize();
      return {
        ...(await this.scanner.scan(image, detectorOptions('classical'))),
        detector: 'classical',
      };
    }
  }
}
