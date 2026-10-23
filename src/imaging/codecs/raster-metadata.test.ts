import { describe, expect, it } from 'vitest';
import { readRasterMetadata } from './raster-metadata';

function box(kind: string, ...parts: Uint8Array[]) {
  const size = 8 + parts.reduce((total, p) => total + p.length, 0);
  const result = new Uint8Array(size);
  new DataView(result.buffer).setUint32(0, size);
  result.set(new TextEncoder().encode(kind), 4);
  let offset = 8;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
function iso(brand: string, compatible = '') {
  const extents = new Uint8Array(12);
  const view = new DataView(extents.buffer);
  view.setUint32(4, 8000);
  view.setUint32(8, 6000);
  const ftyp = box(
    'ftyp',
    new TextEncoder().encode(brand),
    new Uint8Array(4),
    new TextEncoder().encode(compatible),
  );
  const meta = box('meta', new Uint8Array(4), box('iprp', box('ipco', box('ispe', extents))));
  return new Uint8Array([...ftyp, ...meta]);
}
describe('phone image metadata', () => {
  it.each([
    ['heic', 'image/heic'],
    ['mif1', 'image/heif'],
    ['avif', 'image/avif'],
  ])('reads bounded %s dimensions without decoding pixels', (brand, type) => {
    expect(readRasterMetadata(iso(brand))).toEqual({
      type,
      dimensions: { width: 8000, height: 6000 },
    });
  });
  it('prioritizes AVIF compatible brands over generic HEIF major brands', () => {
    expect(readRasterMetadata(iso('mif1', 'miafavif'))?.type).toBe('image/avif');
    expect(readRasterMetadata(iso('mif1', 'heic'))?.type).toBe('image/heic');
  });
  it('rejects ftyp boxes whose brands extend beyond the bounded header', () => {
    const bytes = iso('mif1', 'avif');
    new DataView(bytes.buffer).setUint32(0, bytes.length + 4);
    expect(readRasterMetadata(bytes)).toBeNull();
  });
  it('reads compatible brands after a 64-bit ftyp header', () => {
    const source = iso('mif1', 'avif');
    const sourceSize = new DataView(source.buffer).getUint32(0);
    const bytes = new Uint8Array(source.length + 8);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 1);
    bytes.set(new TextEncoder().encode('ftyp'), 4);
    view.setBigUint64(8, BigInt(sourceSize + 8));
    bytes.set(source.subarray(8), 16);
    expect(readRasterMetadata(bytes)).toEqual({
      type: 'image/avif',
      dimensions: { width: 8000, height: 6000 },
    });
  });
  it('rejects missing dimensions and truncated/invalid ISO boxes', () => {
    const valid = iso('heic');
    expect(readRasterMetadata(valid.slice(0, valid.length - 8))).toBeNull();
    new DataView(valid.buffer).setUint32(16, 2);
    expect(readRasterMetadata(valid)).toBeNull();
  });
});
