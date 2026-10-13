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

/** Uses ML by default and falls back once only when that runtime cannot execute. */
export class ScanicDetectorRuntime {
  private detector: ScanicDetectorKind = 'ml';
  private scanner = new Scanner(detectorOptions('ml'));

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
      this.detector = 'classical';
      this.scanner = new Scanner(detectorOptions('classical'));
      await this.scanner.initialize();
      return {
        ...(await this.scanner.scan(image, detectorOptions('classical'))),
        detector: 'classical',
      };
    }
  }
}
