import { describe, expect, it } from 'vitest';
import {
  GRADE_MAX_PIXELS,
  GRADE_VIGNETTE_INNER,
  GRADE_VIGNETTE_OUTER,
  GradeError,
  gradeRgba8,
  type GradeErrorCode,
  type GradeParams,
} from '../../src/core/color/grade.ts';

const IDENTITY: GradeParams = { hueDeg: 0, sat: 1, val: 1, vignette: 0 };

function grade(data: Uint8Array, width: number, height: number, overrides: Partial<GradeParams> = {}): Uint8Array {
  return gradeRgba8(data, width, height, { ...IDENTITY, ...overrides });
}

function expectCode(run: () => unknown, code: GradeErrorCode): void {
  let thrown: unknown;
  try { run(); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(GradeError);
  expect((thrown as GradeError).code).toBe(code);
}

describe('portable RGBA8 colour grade — B1 contract', () => {
  it('copies identity bytes exactly without changing the input or sharing storage', () => {
    const source = new Uint8Array([0, 128, 255, 0, 90, 110, 150, 233, 255, 0, 10, 255]);
    const before = source.slice();
    const result = grade(source, 3, 1);
    expect(result).toEqual(before);
    expect(result).not.toBe(source);
    expect(source).toEqual(before);
  });

  it('does not alias inputs whose Uint8Array slice method returns a view', () => {
    class AliasingBytes extends Uint8Array {
      override slice(): this { return this; }
    }
    const input = new AliasingBytes([1, 2, 3, 4]);
    const result = grade(input, 1, 1);
    result[0] = 99;
    expect(input[0]).toBe(1);
  });

  it('accepts contract parameter names and returns independent RGBA8 bytes', () => {
    const red = new Uint8Array([255, 0, 0, 17]);
    const result = gradeRgba8(red, 1, 1, { hueDeg: 120, sat: 1, val: 1, vignette: 0 });
    expect(result).toEqual(new Uint8Array([0, 255, 0, 17]));
    expect(result).toBeInstanceOf(Uint8Array);
    expect(red).toEqual(new Uint8Array([255, 0, 0, 17]));
  });

  it('wraps hue by 360 degrees and preserves source alpha', () => {
    const red = new Uint8Array([255, 0, 0, 17]);
    const green = new Uint8Array([0, 255, 0, 17]);
    expect(grade(red, 1, 1, { hueDeg: 120 })).toEqual(green);
    expect(grade(red, 1, 1, { hueDeg: -240 })).toEqual(green);
    expect(grade(red, 1, 1, { hueDeg: 360 })).toEqual(red);
    expect(grade(red, 1, 1, { hueDeg: -360 })).toEqual(red);
    expect(grade(red, 1, 1, { hueDeg: 180 })).toEqual(new Uint8Array([0, 255, 255, 17]));
  });

  it('rejects hue outside [-360, 360], including non-finite values', () => {
    for (const hueDeg of [-361, 361, NaN, Infinity, -Infinity]) {
      expectCode(() => grade(new Uint8Array(4), 1, 1, { hueDeg }), 'param');
    }
  });

  it('applies saturation and value as bounded multipliers, preserving alpha', () => {
    const red = new Uint8Array([255, 0, 0, 50]);
    expect(grade(red, 1, 1, { sat: 0 })).toEqual(new Uint8Array([255, 255, 255, 50]));
    expect(grade(red, 1, 1, { val: 0 })).toEqual(new Uint8Array([0, 0, 0, 50]));
    expect(grade(new Uint8Array([40, 80, 100, 7]), 1, 1, { val: 4 }))
      .toEqual(new Uint8Array([102, 204, 255, 7]));
  });

  it('uses degree-first hue arithmetic at whole-sextant rounding edges', () => {
    // Synthetic half-byte counterexamples. These lock the proposed arithmetic
    // ordering; independent owner reference-grid parity is still required.
    expect(grade(new Uint8Array([0, 22, 26, 53]), 1, 1, {
      hueDeg: 60, sat: 0.5, val: 0.5,
    })).toEqual(new Uint8Array([8, 7, 13, 53]));
    expect(grade(new Uint8Array([0, 11, 143, 97]), 1, 1, {
      hueDeg: 120, sat: 0.5, val: 0.5,
    })).toEqual(new Uint8Array([72, 36, 39, 97]));
  });

  it('rounds the HSV stage before applying vignette (B2 second rounding stage)', () => {
    const pixels = new Uint8Array(3 * 3 * 4);
    pixels.set([1, 0, 0, 71], 0); // corner: vignette shade is exactly 0.5
    const both = grade(pixels, 3, 3, { val: 0.5, vignette: 0.5 });
    // The HSV stage rounds 0.5 to 1, then vignette rounds 1 * 0.5 to 1.
    // Single rounding of 0.5 * 0.5 incorrectly produces 0.
    expect(Array.from(both.slice(0, 4))).toEqual([1, 0, 0, 71]);
    expect(pixels[0]).toBe(1);
  });

  it('matches separately quantized HSV and vignette stages on mixed pixels', () => {
    const pixels = new Uint8Array(5 * 5 * 4);
    for (let p = 0; p < 25; p++) {
      pixels.set([(17 + p * 31) % 256, (43 + p * 53) % 256, (139 + p * 19) % 256, (p * 29) % 256], p * 4);
    }
    const hsv = { hueDeg: 73, sat: 1.3, val: 0.83 };
    const combined = grade(pixels, 5, 5, { ...hsv, vignette: 0.72 });
    const afterHsv = grade(pixels, 5, 5, hsv);
    const afterVignette = grade(afterHsv, 5, 5, { vignette: 0.72 });
    expect(combined).toEqual(afterVignette);
    expect(pixels[0]).toBe(17);
  });

  it('uses floor(channel + 0.5) byte rounding, clamped to the RGBA8 interval', () => {
    const red = new Uint8Array([255, 0, 0, 99]);
    // Pure red's value factor gives precisely half an output byte.
    expect(grade(red, 1, 1, { val: 0.5 / 255 }))
      .toEqual(new Uint8Array([Math.floor(0.5 + 0.5), 0, 0, 99]));
    const fullyClamped = grade(red, 1, 1, { val: 4 });
    expect(fullyClamped).toEqual(red);
    for (const ch of fullyClamped) expect(ch).toBeGreaterThanOrEqual(0);
  });

  it('exports the agreed vignette radii and applies full strength at the corners', () => {
    expect(GRADE_VIGNETTE_INNER).toBe(0.5);
    expect(GRADE_VIGNETTE_OUTER).toBe(1);
    const source = new Uint8Array(5 * 5 * 4);
    for (let p = 0; p < 25; p++) source.set([120, 90, 60, 200], p * 4);
    const result = grade(source, 5, 5, { vignette: 1 });
    expect(Array.from(result.slice(12 * 4, 12 * 4 + 4))).toEqual([120, 90, 60, 200]);
    expect(Array.from(result.slice(7 * 4, 7 * 4 + 4))).toEqual([120, 90, 60, 200]);
    expect(Array.from(result.slice(0, 4))).toEqual([0, 0, 0, 200]);
    const mid = result[(1 * 5 + 0) * 4];
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(120);
    expect(source[0]).toBe(120);
  });

  it('uses smoothstep half-strength at the midpoint vignette radius', () => {
    const source = new Uint8Array(9 * 4);
    for (let i = 0; i < 9; i++) source.set([100, 50, 20, 99], i * 4);
    const result = grade(source, 1, 9, { vignette: 1 });
    expect(Array.from(result.slice(4, 8))).toEqual([50, 25, 10, 99]);
  });

  it('is deterministic on non-square images with combined adjustments', () => {
    const data = new Uint8Array([13, 250, 80, 0, 120, 60, 240, 255, 240, 120, 60, 127, 2, 3, 4, 22, 50, 50, 50, 255, 200, 0, 20, 16]);
    const params = { hueDeg: -167, sat: 2.5, val: 1.75, vignette: 0.4 };
    const a = grade(data, 3, 2, params);
    const b = grade(data, 3, 2, params);
    expect(a).toEqual(b);
    for (let i = 3; i < data.length; i += 4) expect(a[i]).toBe(data[i]);
  });

  it.each([
    { sat: -0.01 }, { sat: 4.01 },
    { val: -0.01 }, { val: 4.01 },
    { vignette: -0.01 }, { vignette: 1.01 },
    { hueDeg: -360.01 }, { hueDeg: 360.01 },
  ])('throws a typed param error for invalid grade parameters %j', (overrides) => {
    expectCode(() => grade(new Uint8Array(4), 1, 1, overrides), 'param');
  });

  it('accepts both endpoints of the B1 parameter ranges', () => {
    const source = new Uint8Array([200, 120, 30, 255]);
    expect(grade(source, 1, 1, { hueDeg: -360, sat: 4, val: 4, vignette: 1 }))
      .toBeInstanceOf(Uint8Array);
    expect(grade(source, 1, 1, { hueDeg: 360, sat: 0, val: 0, vignette: 0 }))
      .toBeInstanceOf(Uint8Array);
  });

  it('throws a typed param or length error for invalid containers and dimensions', () => {
    expectCode(() => gradeRgba8(new Uint8Array(4), 1, 1, null as never), 'param');
    expectCode(() => gradeRgba8([0, 0, 0, 0] as never, 1, 1, IDENTITY), 'length');
    expectCode(() => gradeRgba8(null as never, 1, 1, IDENTITY), 'length');
    expectCode(() => grade(new Uint8Array(3), 1, 1), 'length');
    expectCode(() => grade(new Uint8Array(4), 0, 1), 'length');
    expectCode(() => grade(new Uint8Array(4), 1.5, 1), 'length');
  });

  it('uses 64 Mi pixels as the exact cap and rejects excess before allocating output', () => {
    expect(GRADE_MAX_PIXELS).toBe(64 * 1024 * 1024);
    expectCode(() => grade(new Uint8Array(0), GRADE_MAX_PIXELS + 1, 1), 'limit');
    expectCode(() => grade(new Uint8Array(0), 65536, 65536), 'limit');
    // A missing buffer exactly at the cap reports length, not limit.
    expectCode(() => grade(new Uint8Array(0), GRADE_MAX_PIXELS, 1), 'length');
  });

  it('reports errors as GradeError instances exposing the required code', () => {
    expectCode(() => grade(new Uint8Array(0), 1, 1), 'length');
    expectCode(() => grade(new Uint8Array(4), 1, 1, { hueDeg: 361 }), 'param');
    expectCode(() => grade(new Uint8Array(0), GRADE_MAX_PIXELS + 1, 1), 'limit');
  });
});
