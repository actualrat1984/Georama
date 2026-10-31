/** Maximum RGBA8 input/output pixels (256 MiB per full-size image). */
export const GRADE_MAX_PIXELS = 64 * 1024 * 1024;
/** Radii are fractions of the center-to-corner distance; the transition is smoothstep. */
export const GRADE_VIGNETTE_INNER = 0.5;
export const GRADE_VIGNETTE_OUTER = 1;

export interface GradeParams {
  readonly hueDeg: number;
  readonly sat: number;
  readonly val: number;
  readonly vignette: number;
}

export type GradeErrorCode = 'param' | 'length' | 'limit';

export class GradeError extends Error {
  readonly code: GradeErrorCode;
  constructor(code: GradeErrorCode, message: string) {
    super(message);
    this.name = 'GradeError';
    this.code = code;
  }
}

/** Floor-based byte quantization shared with the B2 shader reference. */
function roundByte(channel: number): number {
  return Math.max(0, Math.min(255, Math.floor(channel + 0.5)));
}

/**
 * Grade RGBA8 in row-major order, retaining alpha and never modifying the input.
 * Hue is a degree offset in HSV; saturation and value multiply their HSV
 * components and clamp to 1. RGB uses floor(channel + 0.5) rounding, clamped to RGBA8 range.
 * Vignette darkens RGB by (1 - strength * smoothstep(inner, outer, radius)).
 * A successful call always returns independent output storage.
 */
export function gradeRgba8(rgba: Uint8Array, width: number, height: number, params: GradeParams): Uint8Array {
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new GradeError('length', 'dimensions must be positive safe integers');
  }
  const count = width * height;
  if (count > GRADE_MAX_PIXELS) {
    throw new GradeError('limit', 'pixel count exceeds grade limit');
  }
  if (!(rgba instanceof Uint8Array) || rgba.length !== count * 4) {
    throw new GradeError('length', 'RGBA8 data must be a Uint8Array of width * height * 4 bytes');
  }
  if (typeof params !== 'object' || params === null ||
      (!Number.isFinite(params.hueDeg) || params.hueDeg < -360 || params.hueDeg > 360) ||
      !Number.isFinite(params.sat) || params.sat < 0 || params.sat > 4 ||
      !Number.isFinite(params.val) || params.val < 0 || params.val > 4 ||
      !Number.isFinite(params.vignette) || params.vignette < 0 || params.vignette > 1) {
    throw new GradeError('param', 'invalid hue, saturation, value or vignette strength');
  }

  // Construct the standard typed array explicitly: Uint8Array subclasses may
  // override slice() to return an alias (for example, Node's Buffer).
  const out = new Uint8Array(rgba);
  const hueOffsetDeg = params.hueDeg % 360;
  const adjustHsv = hueOffsetDeg !== 0 || params.sat !== 1 || params.val !== 1;
  const vignette = params.vignette;
  if (!adjustHsv && vignette === 0) return out;

  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;
  const cornerRadius = Math.hypot(centerX, centerY);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = 4 * (y * width + x);
      let shade = 1;
      if (vignette !== 0 && cornerRadius !== 0) {
        const radius = Math.hypot(x - centerX, y - centerY) / cornerRadius;
        const t = Math.max(0, Math.min(1,
          (radius - GRADE_VIGNETTE_INNER) / (GRADE_VIGNETTE_OUTER - GRADE_VIGNETTE_INNER)));
        shade = 1 - vignette * t * t * (3 - 2 * t);
      }
      if (!adjustHsv) {
        out[i] = roundByte(rgba[i] * shade);
        out[i + 1] = roundByte(rgba[i + 1] * shade);
        out[i + 2] = roundByte(rgba[i + 2] * shade);
        continue;
      }

      const r = rgba[i] / 255;
      const g = rgba[i + 1] / 255;
      const b = rgba[i + 2] / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const delta = max - min;
      let hue = 0;
      if (delta > 0) {
        if (max === r) hue = (g - b) / delta;
        else if (max === g) hue = (b - r) / delta + 2;
        else hue = (r - g) / delta + 4;
      }
      // Preserve the reference's degree-domain arithmetic until after
      // applying the hue offset. Dividing the offset by 60 before adding
      // changes some exact half-byte results at whole-sextant boundaries.
      hue = (hue * 60 + hueOffsetDeg) % 360;
      if (hue < 0) hue += 360;
      hue /= 60;
      const value = Math.min(1, max * params.val);
      const saturation = max === 0 ? 0 : Math.min(1, delta / max * params.sat);
      const chroma = value * saturation;
      const second = chroma * (1 - Math.abs(hue % 2 - 1));
      const offset = value - chroma;
      let rr = 0;
      let gg = 0;
      let bb = 0;
      if (hue < 1) { rr = chroma; gg = second; }
      else if (hue < 2) { rr = second; gg = chroma; }
      else if (hue < 3) { gg = chroma; bb = second; }
      else if (hue < 4) { gg = second; bb = chroma; }
      else if (hue < 5) { rr = second; bb = chroma; }
      else { rr = chroma; bb = second; }
      // The GPU/reference grade quantizes twice: first the HSV RGB result
      // into RGBA8, then vignette-darkens those bytes and quantizes again.
      // Fusing the products before rounding changes many channels by one LSB.
      const gradedR = roundByte((rr + offset) * 255);
      const gradedG = roundByte((gg + offset) * 255);
      const gradedB = roundByte((bb + offset) * 255);
      out[i] = roundByte(gradedR * shade);
      out[i + 1] = roundByte(gradedG * shade);
      out[i + 2] = roundByte(gradedB * shade);
    }
  }
  return out;
}
