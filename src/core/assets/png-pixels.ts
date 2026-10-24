import { crc32 } from './png.ts';

export type PngPixelErrorCode =
  | 'signature'
  | 'chunk'
  | 'crc'
  | 'header'
  | 'unsupported'
  | 'zlib'
  | 'inflate'
  | 'adler'
  | 'filter'
  | 'size'
  | 'limit';

export class PngPixelError extends Error {
  readonly code: PngPixelErrorCode;

  constructor(code: PngPixelErrorCode, message: string) {
    super(message);
    this.name = 'PngPixelError';
    this.code = code;
  }
}

export interface PngPixelLimits {
  maxWidth: number;
  maxHeight: number;
  maxPixels: number;
  maxInputBytes: number;
}

const DEFAULT_MAX_WIDTH = 16384;
const DEFAULT_MAX_HEIGHT = 16384;
const DEFAULT_MAX_PIXELS = 16777216;
const DEFAULT_MAX_INPUT_BYTES = 67108864;

const LENGTH_BASE = new Uint16Array([
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
]);
const LENGTH_EXTRA = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
]);
const DIST_BASE = new Uint16Array([
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
]);
const DIST_EXTRA = new Uint8Array([
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]);
const CODE_LENGTH_ORDER = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);

function fail(code: PngPixelErrorCode, message: string): never {
  throw new PngPixelError(code, message);
}

// A cap is a number. Undefined takes the default. NaN and non-number values
// (a string, a boolean, null) are typed limit errors, before the input is read.
// Negative caps keep their fail-closed path (main pins its message), and
// +Infinity is the documented "no explicit cap".
function limitCap(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || Number.isNaN(value)) {
    fail('limit', 'Invalid limit value');
  }
  return Math.floor(value);
}

function allocBytes(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) fail('limit', 'Invalid allocation size');
  try {
    return new Uint8Array(n);
  } catch (error) {
    if (error instanceof RangeError) fail('limit', 'Image too large to allocate');
    throw error;
  }
}

function u32be(bytes: Uint8Array, pos: number): number {
  return (bytes[pos] * 0x1000000 + (bytes[pos + 1] << 16) + (bytes[pos + 2] << 8) + bytes[pos + 3]) >>> 0;
}

function typeIs(bytes: Uint8Array, pos: number, a: number, b: number, c: number, d: number): boolean {
  return bytes[pos] === a && bytes[pos + 1] === b && bytes[pos + 2] === c && bytes[pos + 3] === d;
}

interface HuffmanTable {
  maxLen: number;
  counts: Uint16Array;
  firstCode: Int32Array;
  firstSym: Int32Array;
  symbols: Int32Array;
}

function buildHuffman(lengths: Uint8Array, count: number, allowUnusedCodes: boolean): HuffmanTable {
  let maxLen = 0;
  let used = 0;
  for (let i = 0; i < count; i++) {
    if (lengths[i] > maxLen) maxLen = lengths[i];
    if (lengths[i] !== 0) used += 1;
  }
  const counts = new Uint16Array(maxLen + 1);
  for (let i = 0; i < count; i++) {
    if (lengths[i] !== 0) counts[lengths[i]] += 1;
  }
  let left = 1;
  for (let len = 1; len <= maxLen; len++) {
    left <<= 1;
    left -= counts[len];
    if (left < 0) fail('inflate', 'Over-subscribed Huffman code');
  }
  if (left > 0 && !allowUnusedCodes && !(used === 1 && counts[1] === 1)) {
    fail('inflate', 'Incomplete Huffman code');
  }
  const offsets = new Int32Array(maxLen + 1);
  for (let len = 1; len <= maxLen; len++) {
    offsets[len] = len === 1 ? 0 : offsets[len - 1] + counts[len - 1];
  }
  const symbols = new Int32Array(used);
  const next = offsets.slice();
  for (let sym = 0; sym < count; sym++) {
    const len = lengths[sym];
    if (len !== 0) symbols[next[len]++] = sym;
  }
  const firstCode = new Int32Array(maxLen + 1);
  const firstSym = new Int32Array(maxLen + 1);
  let code = 0;
  let index = 0;
  for (let len = 1; len <= maxLen; len++) {
    firstCode[len] = code;
    firstSym[len] = index;
    index += counts[len];
    code = (code + counts[len]) << 1;
  }
  return { maxLen, counts, firstCode, firstSym, symbols };
}

function fixedLiteralLengths(): Uint8Array {
  const lengths = new Uint8Array(288);
  for (let i = 0; i < 144; i++) lengths[i] = 8;
  for (let i = 144; i < 256; i++) lengths[i] = 9;
  for (let i = 256; i < 280; i++) lengths[i] = 7;
  for (let i = 280; i < 288; i++) lengths[i] = 8;
  return lengths;
}

function fixedDistanceLengths(): Uint8Array {
  const lengths = new Uint8Array(30);
  for (let i = 0; i < 30; i++) lengths[i] = 5;
  return lengths;
}

export function decodePngRgba8(
  bytes: Uint8Array,
  limits?: Partial<PngPixelLimits>,
): { width: number; height: number; rgba: Uint8Array } {
  const maxWidth = limitCap(limits?.maxWidth, DEFAULT_MAX_WIDTH);
  const maxHeight = limitCap(limits?.maxHeight, DEFAULT_MAX_HEIGHT);
  const maxPixels = limitCap(limits?.maxPixels, DEFAULT_MAX_PIXELS);
  const maxInputBytes = limitCap(limits?.maxInputBytes, DEFAULT_MAX_INPUT_BYTES);
  // A negative width, height or pixel cap admits no image: reject before the input is read.
  if (maxWidth < 0 || maxHeight < 0 || maxPixels < 0) fail('limit', 'Image past the limit');
  if (!(bytes instanceof Uint8Array)) fail('chunk', 'Expected bytes');
  if (bytes.length > maxInputBytes) fail('limit', 'Input past the limit');
  if (
    bytes.length < 8
    || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71
    || bytes[4] !== 13 || bytes[5] !== 10 || bytes[6] !== 26 || bytes[7] !== 10
  ) {
    fail('signature', 'Bad PNG signature');
  }

  let width = 0;
  let height = 0;
  let colorType = 0;
  let seenIhdr = false;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  let transparencySeen = false;
  const idatParts: Uint8Array[] = [];
  let idatLength = 0;
  // Once any non-IDAT follows image data, another IDAT is forbidden.
  let idatSequenceEnded = false;
  let seenIend = false;

  let pos = 8;
  if (pos >= bytes.length) fail('header', 'First chunk is not IHDR');
  let first = true;
  while (pos < bytes.length) {
    if (bytes.length - pos < 12) fail('chunk', 'Chunk runs past the input');
    const length = u32be(bytes, pos);
    if (pos + 12 + length > bytes.length) fail('chunk', 'Chunk runs past the input');
    const typePos = pos + 4;
    const dataPos = pos + 8;
    const crcPos = pos + 8 + length;
    if (crc32(bytes, typePos, crcPos) !== u32be(bytes, crcPos)) fail('crc', 'Chunk CRC mismatch');
    const isIdat = typeIs(bytes, typePos, 73, 68, 65, 84);
    if (!isIdat && idatParts.length > 0) idatSequenceEnded = true;
    if (typeIs(bytes, typePos, 73, 72, 68, 82)) {
      if (!first) fail('header', 'Duplicate IHDR');
      if (length !== 13) fail('header', 'First chunk is not IHDR');
      width = u32be(bytes, dataPos);
      height = u32be(bytes, dataPos + 4);
      const bitDepth = bytes[dataPos + 8];
      colorType = bytes[dataPos + 9];
      const compression = bytes[dataPos + 10];
      const filterMethod = bytes[dataPos + 11];
      const interlace = bytes[dataPos + 12];
      if (width < 1 || height < 1 || width > 2147483647 || height > 2147483647) {
        fail('header', 'Bad image size');
      }
      if (width > maxWidth || height > maxHeight || height > Math.floor(maxPixels / width)) {
        fail('limit', 'Image past the limit');
      }
      if (bitDepth !== 8) fail('unsupported', 'Unsupported bit depth');
      if (colorType !== 0 && colorType !== 2 && colorType !== 3 && colorType !== 4 && colorType !== 6) {
        fail('header', 'Bad colour type');
      }
      if (compression !== 0 || filterMethod !== 0) fail('header', 'Bad method byte');
      if (interlace !== 0) fail('unsupported', 'Unsupported interlace');
      seenIhdr = true;
      first = false;
    } else if (typeIs(bytes, typePos, 80, 76, 84, 69)) {
      if (!seenIhdr) fail('header', 'First chunk is not IHDR');
      if (palette) fail('header', 'Duplicate PLTE');
      if (idatParts.length > 0) fail('chunk', 'PLTE must precede IDAT');
      palette = bytes.subarray(dataPos, dataPos + length);
      first = false;
    } else if (isIdat) {
      if (!seenIhdr) fail('header', 'First chunk is not IHDR');
      if (idatSequenceEnded) fail('chunk', 'IDAT chunks are not consecutive');
      idatParts.push(bytes.subarray(dataPos, dataPos + length));
      idatLength += length;
      first = false;
    } else if (typeIs(bytes, typePos, 73, 69, 78, 68)) {
      if (!seenIhdr) fail('header', 'First chunk is not IHDR');
      if (seenIend) fail('chunk', 'Second IEND');
      if (length !== 0) fail('chunk', 'IEND is not empty');
      if (crcPos + 4 !== bytes.length) fail('chunk', 'IEND is not the last chunk');
      seenIend = true;
      pos = bytes.length;
      continue;
    } else if (typeIs(bytes, typePos, 116, 82, 78, 83)) {
      if (!seenIhdr) fail('header', 'First chunk is not IHDR');
      if (transparencySeen) fail('header', 'Duplicate tRNS');
      transparency = bytes.subarray(dataPos, dataPos + length);
      transparencySeen = true;
      first = false;
    } else if (bytes[typePos] >= 97 && bytes[typePos] <= 122) {
      if (!seenIhdr) fail('header', 'First chunk is not IHDR');
      first = false;
    } else {
      fail('unsupported', 'Unknown critical chunk');
    }
    pos = crcPos + 4;
  }
  if (!seenIhdr) fail('header', 'First chunk is not IHDR');
  if (!seenIend) fail('chunk', 'Missing IEND');

  let entries = 0;
  if (colorType === 3) {
    if (!palette || palette.length % 3 !== 0 || palette.length < 3 || palette.length > 768) {
      fail('header', 'Bad PLTE');
    }
    entries = (palette as Uint8Array).length / 3;
  }
  const paletteBytes = palette as Uint8Array | null;
  let keyR = 0;
  let keyG = 0;
  let keyB = 0;
  let hasKey = false;
  if (transparency) {
    const trns = transparency as Uint8Array;
    if (colorType === 3) {
      if (trns.length < 1 || trns.length > entries) fail('header', 'Bad tRNS');
    } else if (colorType === 0) {
      if (trns.length !== 2) fail('header', 'Bad tRNS');
      keyG = trns[0] * 256 + trns[1];
      hasKey = true;
    } else if (colorType === 2) {
      if (trns.length !== 6) fail('header', 'Bad tRNS');
      keyR = trns[0] * 256 + trns[1];
      keyG = trns[2] * 256 + trns[3];
      keyB = trns[4] * 256 + trns[5];
      hasKey = true;
    }
  }
  const trnsBytes = transparency as Uint8Array | null;

  if (idatParts.length === 0) fail('chunk', 'Missing IDAT');
  const stream = allocBytes(idatLength);
  let streamPos = 0;
  for (const part of idatParts) {
    stream.set(part, streamPos);
    streamPos += part.length;
  }

  if (stream.length < 2) fail('zlib', 'Short zlib stream');
  const cmf = stream[0];
  const flg = stream[1];
  if ((cmf & 15) !== 8 || (cmf >>> 4) > 7 || (cmf * 256 + flg) % 31 !== 0 || (flg & 32) !== 0) {
    fail('zlib', 'Bad zlib header');
  }

  const channels = colorType === 0 || colorType === 3 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
  const stride = width * channels;
  const expected = height * (1 + stride);
  if (!Number.isSafeInteger(stride) || !Number.isSafeInteger(expected)) {
    fail('limit', 'Image past the limit');
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels)) fail('limit', 'Image past the limit');
  if (!Number.isSafeInteger(pixels * 4)) fail('limit', 'Image past the limit');

  const out = allocBytes(expected);
  let outPos = 0;
  let bitPos = 16;
  const bitEnd = stream.length * 8;
  const readBit = (): number => {
    if (bitPos >= bitEnd) fail('inflate', 'Truncated DEFLATE stream');
    const bit = (stream[bitPos >>> 3] >>> (bitPos & 7)) & 1;
    bitPos += 1;
    return bit;
  };
  const readBits = (n: number): number => {
    let value = 0;
    for (let i = 0; i < n; i++) value |= readBit() << i;
    return value >>> 0;
  };
  const decodeSymbol = (table: HuffmanTable): number => {
    let code = 0;
    for (let len = 1; len <= table.maxLen; len++) {
      code = (code << 1) | readBit();
      if (code - table.firstCode[len] < table.counts[len]) {
        return table.symbols[table.firstSym[len] + (code - table.firstCode[len])];
      }
    }
    return fail('inflate', 'Bad Huffman code');
  };

  const fixedLit = buildHuffman(fixedLiteralLengths(), 288, false);
  // The fixed distance code leaves two 5-bit codes unused by definition; using
  // one of them fails at decode time instead.
  const fixedDist = buildHuffman(fixedDistanceLengths(), 30, true);

  let end = false;
  while (!end) {
    end = readBit() === 1;
    const blockType = readBits(2);
    if (blockType === 0) {
      bitPos = (bitPos + 7) & ~7;
      if (bitPos + 32 > bitEnd) fail('inflate', 'Truncated stored block');
      const bytePos = bitPos >>> 3;
      const len = stream[bytePos] | (stream[bytePos + 1] << 8);
      const nlen = stream[bytePos + 2] | (stream[bytePos + 3] << 8);
      if ((len ^ nlen) !== 0xffff) fail('inflate', 'Bad stored lengths');
      bitPos += 32;
      if (outPos + len > expected) fail('size', 'Output past the expected size');
      const dataStart = bitPos >>> 3;
      if (dataStart + len > stream.length) fail('inflate', 'Truncated stored data');
      out.set(stream.subarray(dataStart, dataStart + len), outPos);
      outPos += len;
      bitPos += len * 8;
    } else if (blockType === 1 || blockType === 2) {
      let lit: HuffmanTable;
      let dist: HuffmanTable;
      if (blockType === 1) {
        lit = fixedLit;
        dist = fixedDist;
      } else {
        const hlit = readBits(5) + 257;
        const hdist = readBits(5) + 1;
        const hclen = readBits(4) + 4;
        if (hlit > 286 || hdist > 30) fail('inflate', 'Bad dynamic header');
        const clLens = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) clLens[CODE_LENGTH_ORDER[i]] = readBits(3);
        const cl = buildHuffman(clLens, 19, false);
        const total = hlit + hdist;
        const lens = new Uint8Array(total);
        let k = 0;
        let prev = 0;
        while (k < total) {
          const sym = decodeSymbol(cl);
          if (sym <= 15) {
            lens[k++] = sym;
            prev = sym;
          } else if (sym === 16) {
            if (k === 0) fail('inflate', 'Bad length repeat');
            const rep = 3 + readBits(2);
            if (k + rep > total) fail('inflate', 'Too many lengths');
            for (let j = 0; j < rep; j++) lens[k++] = prev;
          } else if (sym === 17) {
            const rep = 3 + readBits(3);
            if (k + rep > total) fail('inflate', 'Too many lengths');
            for (let j = 0; j < rep; j++) lens[k++] = 0;
            prev = 0;
          } else {
            const rep = 11 + readBits(7);
            if (k + rep > total) fail('inflate', 'Too many lengths');
            for (let j = 0; j < rep; j++) lens[k++] = 0;
            prev = 0;
          }
        }
        lit = buildHuffman(lens.subarray(0, hlit), hlit, false);
        const distLens = lens.subarray(hlit);
        let distCodes = 0;
        for (let i = 0; i < distLens.length; i++) {
          if (distLens[i] !== 0) distCodes += 1;
        }
        dist = distCodes === 0
          ? buildHuffman(distLens, hdist, true)
          : buildHuffman(distLens, hdist, false);
      }
      for (;;) {
        const sym = decodeSymbol(lit);
        if (sym < 256) {
          if (outPos >= expected) fail('size', 'Output past the expected size');
          out[outPos++] = sym;
        } else if (sym === 256) {
          break;
        } else {
          if (sym === 286 || sym === 287) fail('inflate', 'Invalid length code');
          const li = sym - 257;
          let len = LENGTH_BASE[li];
          const lextra = LENGTH_EXTRA[li];
          if (lextra !== 0) len += readBits(lextra);
          const dsym = decodeSymbol(dist);
          if (dsym > 29) fail('inflate', 'Bad distance code');
          let distance = DIST_BASE[dsym];
          const dextra = DIST_EXTRA[dsym];
          if (dextra !== 0) distance += readBits(dextra);
          if (distance > outPos) fail('inflate', 'Distance past the start');
          if (outPos + len > expected) fail('size', 'Output past the expected size');
          for (let j = 0; j < len; j++) {
            out[outPos] = out[outPos - distance];
            outPos += 1;
          }
        }
      }
    } else {
      fail('inflate', 'Bad block type');
    }
  }

  bitPos = (bitPos + 7) & ~7;
  const adlerPos = bitPos >>> 3;
  if (adlerPos + 4 > stream.length) fail('zlib', 'Missing Adler-32');
  const want = u32be(stream, adlerPos);
  let s1 = 1;
  let s2 = 0;
  for (let i = 0; i < outPos; i++) {
    s1 += out[i];
    s2 += s1;
    if ((i & 4095) === 4095) {
      s1 %= 65521;
      s2 %= 65521;
    }
  }
  s1 %= 65521;
  s2 %= 65521;
  if (((s2 * 65536 + s1) >>> 0) !== want) fail('adler', 'Adler-32 mismatch');
  if (adlerPos + 4 !== stream.length) fail('zlib', 'Trailing bytes after Adler-32');
  if (outPos !== expected) fail('size', 'Output size mismatch');

  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = out[rowStart];
    if (filter > 4) fail('filter', 'Bad filter type');
    const upStart = y === 0 ? 0 : rowStart - stride - 1;
    for (let i = 0; i < stride; i++) {
      const raw = out[rowStart + 1 + i];
      const left = i >= channels ? out[rowStart + 1 + i - channels] : 0;
      const up = y === 0 ? 0 : out[upStart + 1 + i];
      const upLeft = i >= channels && y !== 0 ? out[upStart + 1 + i - channels] : 0;
      let value: number;
      if (filter === 0) {
        value = raw;
      } else if (filter === 1) {
        value = raw + left;
      } else if (filter === 2) {
        value = raw + up;
      } else if (filter === 3) {
        value = raw + ((left + up) >>> 1);
      } else {
        const p = left + up - upLeft;
        let pa = p - left;
        if (pa < 0) pa = -pa;
        let pb = p - up;
        if (pb < 0) pb = -pb;
        let pc = p - upLeft;
        if (pc < 0) pc = -pc;
        value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      }
      out[rowStart + 1 + i] = value & 255;
    }
  }

  const rgba = allocBytes(pixels * 4);
  let r = 0;
  if (colorType === 0) {
    for (let y = 0; y < height; y++) {
      const rowStart = y * (stride + 1) + 1;
      for (let x = 0; x < width; x++) {
        const g = out[rowStart + x];
        rgba[r++] = g;
        rgba[r++] = g;
        rgba[r++] = g;
        rgba[r++] = hasKey && g === keyG ? 0 : 255;
      }
    }
  } else if (colorType === 2) {
    for (let y = 0; y < height; y++) {
      const rowStart = y * (stride + 1) + 1;
      for (let x = 0; x < width; x++) {
        const rr = out[rowStart + x * 3];
        const gg = out[rowStart + x * 3 + 1];
        const bb = out[rowStart + x * 3 + 2];
        rgba[r++] = rr;
        rgba[r++] = gg;
        rgba[r++] = bb;
        rgba[r++] = hasKey && rr === keyR && gg === keyG && bb === keyB ? 0 : 255;
      }
    }
  } else if (colorType === 3) {
    const pal = paletteBytes as Uint8Array;
    for (let y = 0; y < height; y++) {
      const rowStart = y * (stride + 1) + 1;
      for (let x = 0; x < width; x++) {
        const index = out[rowStart + x];
        if (index >= entries) fail('header', 'Palette index past the palette');
        rgba[r++] = pal[index * 3];
        rgba[r++] = pal[index * 3 + 1];
        rgba[r++] = pal[index * 3 + 2];
        rgba[r++] = trnsBytes && index < trnsBytes.length ? trnsBytes[index] : 255;
      }
    }
  } else if (colorType === 4) {
    for (let y = 0; y < height; y++) {
      const rowStart = y * (stride + 1) + 1;
      for (let x = 0; x < width; x++) {
        const g = out[rowStart + x * 2];
        rgba[r++] = g;
        rgba[r++] = g;
        rgba[r++] = g;
        rgba[r++] = out[rowStart + x * 2 + 1];
      }
    }
  } else {
    for (let y = 0; y < height; y++) {
      const rowStart = y * (stride + 1) + 1;
      for (let x = 0; x < width; x++) {
        rgba[r++] = out[rowStart + x * 4];
        rgba[r++] = out[rowStart + x * 4 + 1];
        rgba[r++] = out[rowStart + x * 4 + 2];
        rgba[r++] = out[rowStart + x * 4 + 3];
      }
    }
  }
  return { width, height, rgba };
}
