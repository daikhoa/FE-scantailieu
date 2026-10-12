import type { ImageAsset, ImageDimensions } from '../../domain/document';
import { MAX_ENCODED_INPUT_BYTES } from '../../imaging/codecs/browser-rgba-codec';
import { isValidImageDimensions } from '../../imaging/geometry/coordinates';
import {
  MAX_WORKING_IMAGE_PIXELS,
  MAX_WORKING_IMAGE_SIDE,
} from '../../imaging/working-image-limits';

export type ImageImportFailureCode =
  | 'unsupported-type'
  | 'too-large'
  | 'invalid-file'
  | 'image-too-large'
  | 'decode-failed'
  | 'unavailable';

const SAFE_MESSAGES: Readonly<Record<ImageImportFailureCode, string>> = {
  'unsupported-type': 'The image type is not supported.',
  'too-large': 'The encoded image is too large.',
  'invalid-file': 'The file is not a valid supported image.',
  'image-too-large': 'The decoded image dimensions are too large.',
  'decode-failed': 'The image could not be decoded.',
  unavailable: 'Image decoding is unavailable in this browser.',
};

const HEADER_READ_LIMIT = 1024 * 1024;
const SUPPORTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
type SupportedType = 'image/jpeg' | 'image/png' | 'image/webp';

export class ImageImportError extends Error {
  override readonly name = 'ImageImportError';

  constructor(readonly code: ImageImportFailureCode) {
    super(SAFE_MESSAGES[code]);
  }
}

export interface ImportedImage {
  readonly original: ImageAsset;
}

export type ImageImporter = (source: Blob, signal: AbortSignal) => Promise<ImportedImage>;

function abortError(): Error {
  const error = new Error('Image import cancelled.');
  error.name = 'AbortError';
  return error;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function matches(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function detectedType(bytes: Uint8Array): SupportedType | null {
  if (matches(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (matches(bytes, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (matches(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && matches(bytes, 8, [0x57, 0x45, 0x42, 0x50])) {
    return 'image/webp';
  }
  return null;
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.byteLength < 24 || !matches(bytes, 12, [0x49, 0x48, 0x44, 0x52])) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const JPEG_START_OF_FRAME = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function jpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  let offset = 2;
  while (offset + 3 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset];
    offset++;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    const lengthHigh = bytes[offset];
    const lengthLow = bytes[offset + 1];
    if (lengthHigh === undefined || lengthLow === undefined) return null;
    const segmentLength = (lengthHigh << 8) | lengthLow;
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) return null;
    if (JPEG_START_OF_FRAME.has(marker)) {
      if (segmentLength < 7) return null;
      const heightHigh = bytes[offset + 3];
      const heightLow = bytes[offset + 4];
      const widthHigh = bytes[offset + 5];
      const widthLow = bytes[offset + 6];
      if (
        heightHigh === undefined ||
        heightLow === undefined ||
        widthHigh === undefined ||
        widthLow === undefined
      ) {
        return null;
      }
      return {
        width: (widthHigh << 8) | widthLow,
        height: (heightHigh << 8) | heightLow,
      };
    }
    offset += segmentLength;
  }
  return null;
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number): number | null {
  const first = bytes[offset];
  const second = bytes[offset + 1];
  const third = bytes[offset + 2];
  return first === undefined || second === undefined || third === undefined
    ? null
    : first | (second << 8) | (third << 16);
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.byteLength < 30) return null;
  if (matches(bytes, 12, [0x56, 0x50, 0x38, 0x58])) {
    const width = readUint24LittleEndian(bytes, 24);
    const height = readUint24LittleEndian(bytes, 27);
    return width === null || height === null ? null : { width: width + 1, height: height + 1 };
  }
  if (matches(bytes, 12, [0x56, 0x50, 0x38, 0x4c]) && bytes[20] === 0x2f) {
    const first = bytes[21];
    const second = bytes[22];
    const third = bytes[23];
    const fourth = bytes[24];
    if (
      first === undefined ||
      second === undefined ||
      third === undefined ||
      fourth === undefined
    ) {
      return null;
    }
    return {
      width: 1 + first + ((second & 0x3f) << 8),
      height: 1 + (second >> 6) + (third << 2) + ((fourth & 0x0f) << 10),
    };
  }
  if (matches(bytes, 12, [0x56, 0x50, 0x38, 0x20]) && matches(bytes, 23, [0x9d, 0x01, 0x2a])) {
    const widthLow = bytes[26];
    const widthHigh = bytes[27];
    const heightLow = bytes[28];
    const heightHigh = bytes[29];
    if (
      widthLow === undefined ||
      widthHigh === undefined ||
      heightLow === undefined ||
      heightHigh === undefined
    ) {
      return null;
    }
    return {
      width: (widthLow | (widthHigh << 8)) & 0x3fff,
      height: (heightLow | (heightHigh << 8)) & 0x3fff,
    };
  }
  return null;
}

function headerDimensions(bytes: Uint8Array, type: SupportedType): ImageDimensions | null {
  switch (type) {
    case 'image/png':
      return pngDimensions(bytes);
    case 'image/jpeg':
      return jpegDimensions(bytes);
    case 'image/webp':
      return webpDimensions(bytes);
  }
}

function validateDimensions(dimensions: ImageDimensions): void {
  if (!isValidImageDimensions(dimensions)) throw new ImageImportError('invalid-file');
  if (
    Math.max(dimensions.width, dimensions.height) > MAX_WORKING_IMAGE_SIDE ||
    dimensions.width * dimensions.height > MAX_WORKING_IMAGE_PIXELS
  ) {
    throw new ImageImportError('image-too-large');
  }
}

async function readHeader(source: Blob, signal: AbortSignal): Promise<Uint8Array> {
  try {
    const bytes = await source.slice(0, HEADER_READ_LIMIT).arrayBuffer();
    checkAbort(signal);
    return new Uint8Array(bytes);
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (error instanceof ImageImportError) throw error;
    throw new ImageImportError('invalid-file');
  }
}

/** Validates encoded bytes and decoded dimensions without uploading or mutating the source. */
export async function importImage(source: Blob, signal: AbortSignal): Promise<ImportedImage> {
  checkAbort(signal);
  if (!(source instanceof Blob) || source.size <= 0) throw new ImageImportError('invalid-file');
  if (source.size > MAX_ENCODED_INPUT_BYTES) throw new ImageImportError('too-large');
  if (source.type !== '' && !SUPPORTED_TYPES.has(source.type)) {
    throw new ImageImportError('unsupported-type');
  }

  const header = await readHeader(source, signal);
  const type = detectedType(header);
  if (type === null || (source.type !== '' && source.type !== type)) {
    throw new ImageImportError('invalid-file');
  }
  const dimensions = headerDimensions(header, type);
  if (dimensions === null) throw new ImageImportError('invalid-file');
  validateDimensions(dimensions);
  const normalized = source.type === '' ? source.slice(0, source.size, type) : source;
  if (typeof createImageBitmap !== 'function') throw new ImageImportError('unavailable');

  let decoded: ImageBitmap | null = null;
  try {
    decoded = await createImageBitmap(normalized, { imageOrientation: 'none' });
    checkAbort(signal);
    const decodedDimensions = { width: decoded.width, height: decoded.height };
    validateDimensions(decodedDimensions);
    const exactMatch =
      decodedDimensions.width === dimensions.width &&
      decodedDimensions.height === dimensions.height;
    const orientationSwap =
      decodedDimensions.width === dimensions.height &&
      decodedDimensions.height === dimensions.width;
    if (!exactMatch && !orientationSwap) {
      throw new ImageImportError('invalid-file');
    }
    return {
      original: {
        blob: normalized,
        dimensions: decodedDimensions,
      },
    };
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (error instanceof ImageImportError) throw error;
    throw new ImageImportError('decode-failed');
  } finally {
    decoded?.close();
  }
}
