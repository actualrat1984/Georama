import { crc32 as nodeCrc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PngError, validatePng } from '../../src/core/assets/png.ts';
import { PngPixelError, decodePngRgba8 } from '../../src/core/assets/png-pixels.ts';
import { makePng } from '../helpers/pck-synthetic.ts';

// Manipulate complete chunks, not compressed bytes: every malformed layout
// still carries valid CRCs and independently decodable image data.
const SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunksOf(png: Uint8Array): Uint8Array[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: Uint8Array[] = [];
  for (let pos = 8; pos < png.length;) {
    if (pos + 12 > png.length) throw new Error('incomplete test fixture chunk');
    const end = pos + 12 + view.getUint32(pos, false);
    if (end > png.length) throw new Error('invalid test fixture chunk length');
    chunks.push(png.slice(pos, end));
    pos = end;
  }
  return chunks;
}

function kind(chunk: Uint8Array): string {
  return String.fromCharCode(chunk[4], chunk[5], chunk[6], chunk[7]);
}

function chunkOf(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, nodeCrc32(chunk.subarray(4, 8 + data.length)) >>> 0, false);
  return chunk;
}

function reassemble(chunks: Uint8Array[]): Uint8Array {
  const length = SIGNATURE.length + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const png = new Uint8Array(length);
  png.set(SIGNATURE);
  let pos = SIGNATURE.length;
  for (const chunk of chunks) {
    png.set(chunk, pos);
    pos += chunk.length;
  }
  return png;
}

function expectChunkRejection(bytes: Uint8Array): void {
  let pixelError: unknown;
  try {
    decodePngRgba8(bytes);
  } catch (error) {
    pixelError = error;
  }
  expect(pixelError).toBeInstanceOf(PngPixelError);
  expect((pixelError as PngPixelError).code).toBe('chunk');

  let structuralError: unknown;
  try {
    validatePng(bytes);
  } catch (error) {
    structuralError = error;
  }
  expect(structuralError).toBeInstanceOf(PngError);
  expect((structuralError as PngError).code).toBe('CHUNK');
}

describe('PNG pixel-decoder critical chunk ordering', () => {
  it('accepts consecutive IDAT chunks, including a zero-length IDAT, and ancillary text before and after them', () => {
    const chunks = chunksOf(makePng({ width: 2, height: 1, colorType: 2, bitDepth: 8, idatChunks: 2 }));
    const firstIdat = chunks.findIndex((chunk) => kind(chunk) === 'IDAT');
    chunks.splice(firstIdat, 0, chunkOf('tEXt', Uint8Array.from([65, 0, 66])));
    const secondIdat = chunks.map(kind).lastIndexOf('IDAT');
    chunks.splice(secondIdat, 0, chunkOf('IDAT', new Uint8Array(0)));
    const lastIdat = chunks.map(kind).lastIndexOf('IDAT');
    chunks.splice(lastIdat + 1, 0, chunkOf('tEXt', Uint8Array.from([67, 0, 68])));

    const png = reassemble(chunks);
    expect(validatePng(png).idatBytes).toBeGreaterThan(0);
    expect(Array.from(decodePngRgba8(png).rgba)).toEqual([0, 0, 0, 255, 0, 0, 0, 255]);
  });

  it('accepts an optional PLTE before IDAT in truecolor PNG', () => {
    const chunks = chunksOf(makePng({ width: 1, height: 1, colorType: 2, bitDepth: 8 }));
    chunks.splice(1, 0, chunkOf('PLTE', Uint8Array.from([12, 34, 56])));
    const png = reassemble(chunks);
    expect(validatePng(png).colorType).toBe(2);
    expect(Array.from(decodePngRgba8(png).rgba)).toEqual([0, 0, 0, 255]);
  });

  it('rejects an ancillary chunk inserted between two IDAT chunks', () => {
    const chunks = chunksOf(makePng({ width: 2, height: 1, colorType: 2, bitDepth: 8, idatChunks: 2 }));
    const secondIdat = chunks.map(kind).lastIndexOf('IDAT');
    chunks.splice(secondIdat, 0, chunkOf('tEXt', Uint8Array.from([65, 0, 66])));
    expectChunkRejection(reassemble(chunks));
  });

  it('rejects an indexed-color PLTE moved after image data', () => {
    const chunks = chunksOf(makePng({ width: 2, height: 1, colorType: 3, bitDepth: 8 }));
    const paletteIndex = chunks.findIndex((chunk) => kind(chunk) === 'PLTE');
    const palette = chunks.splice(paletteIndex, 1)[0];
    const iendIndex = chunks.findIndex((chunk) => kind(chunk) === 'IEND');
    chunks.splice(iendIndex, 0, palette);
    expectChunkRejection(reassemble(chunks));
  });

  it('rejects IEND with data despite its correct CRC and final position', () => {
    const chunks = chunksOf(makePng({ width: 1, height: 1, colorType: 2, bitDepth: 8 }));
    chunks[chunks.length - 1] = chunkOf('IEND', Uint8Array.of(1));
    expectChunkRejection(reassemble(chunks));
  });
});
