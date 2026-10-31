import { describe, expect, it } from 'vitest';
import { paintWrappedMask } from '../../src/core/edit/wrapped-mask';

const blank = () => new Uint8Array(15);
const base = { width: 5, height: 3, centerX: 0.5, centerY: 1.5, radius: 1.01, value: 1 as const };

describe('D1 horizontally wrapped binary brush painting', () => {
  it('paints a circular brush across the left/right seam, with a fresh output mask', () => {
    const mask = blank();
    const r = paintWrappedMask({ ...base, mask });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(5);
    expect([...r.mask].flatMap((v, i) => v ? [i] : [])).toEqual([0, 5, 6, 9, 10]);
    expect(r.mask).not.toBe(mask);
    expect(mask).toEqual(blank());
  });

  it('normalizes negative and out-of-range horizontal centers', () => {
    const a = paintWrappedMask({ ...base, mask: blank(), centerX: -0.5 });
    const b = paintWrappedMask({ ...base, mask: blank(), centerX: 4.5 });
    const c = paintWrappedMask({ ...base, mask: blank(), centerX: 5.5 });
    const d = paintWrappedMask({ ...base, mask: blank(), centerX: 0.5 });
    expect(a).toEqual(b);
    expect(c).toEqual(d);
  });

  it('clips vertically instead of wrapping from the top into the bottom row', () => {
    const r = paintWrappedMask({ ...base, mask: blank(), centerY: 0.5 });
    expect(r.ok).toBe(true);
    if (r.ok) expect([...r.mask].flatMap((v, i) => v ? [i] : []))
      .toEqual([0, 1, 4, 5]);
  });

  it('does not mutate or alias a Node Buffer passed as its Uint8Array input', () => {
    // Buffer.slice() aliases the same memory; a typed-array copy must not.
    const mask = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const before = Buffer.from(mask);
    const result = paintWrappedMask({
      width: 3, height: 3, mask,
      centerX: 1.5, centerY: 1.5, radius: 1, value: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.mask]).toEqual([0, 1, 0, 1, 1, 1, 0, 1, 0]);
    expect(result.changed).toBe(5);
    expect(mask).toEqual(before);
    expect(result.mask).not.toBe(mask);
    result.mask[4] = 0;
    expect(mask).toEqual(before);
  });

  it('supports erasing a single pixel and returns the count of actual changes', () => {
    const mask = new Uint8Array(15).fill(1);
    const r = paintWrappedMask({ ...base, mask, centerX: 2.5, radius: 0, value: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(1);
    expect(r.mask[7]).toBe(0);
    expect(r.mask.reduce((sum, value) => sum + value, 0)).toBe(14);
    expect(mask.every(v => v === 1)).toBe(true);
    const repeat = paintWrappedMask({ ...base, mask: r.mask, centerX: 2.5, radius: 0, value: 0 });
    expect(repeat.ok).toBe(true);
    if (repeat.ok) {
      expect(repeat.changed).toBe(0);
      expect(repeat.mask).not.toBe(r.mask);
    }
  });

  it('supports one-column maps and very large brush radii without excess work', () => {
    const single = paintWrappedMask({ width: 1, height: 3, mask: new Uint8Array(3),
      centerX: 3.5, centerY: 0.5, radius: 0, value: 1 });
    expect(single).toEqual({ ok: true, mask: new Uint8Array([1, 0, 0]), changed: 1 });
    const huge = paintWrappedMask({ ...base, mask: blank(), radius: Number.MAX_VALUE });
    expect(huge.ok).toBe(true);
    if (huge.ok) {
      expect(huge.changed).toBe(15);
      expect(huge.mask.every(v => v === 1)).toBe(true);
    }
  });

  it('rejects malformed inputs and non-binary masks before allocating output', () => {
    expect(paintWrappedMask({ ...base, mask: new Uint8Array(3) })).toEqual({ ok: false, code: 'INPUT' });
    expect(paintWrappedMask({ ...base, mask: new Uint8Array([2, ...new Array(14).fill(0)]) }))
      .toEqual({ ok: false, code: 'INPUT' });
    expect(paintWrappedMask({ ...base, mask: [] as never })).toEqual({ ok: false, code: 'INPUT' });
    expect(paintWrappedMask({ ...base, mask: blank(), centerX: Infinity })).toEqual({ ok: false, code: 'INPUT' });
    expect(paintWrappedMask({ ...base, mask: blank(), centerY: NaN })).toEqual({ ok: false, code: 'INPUT' });
    expect(paintWrappedMask({ ...base, mask: blank(), radius: -1 })).toEqual({ ok: false, code: 'INPUT' });
    expect(paintWrappedMask({ ...base, mask: blank(), value: 2 as never }))
      .toEqual({ ok: false, code: 'INPUT' });
  });

  it('rejects oversized maps prior to cloning or scanning their input mask', () => {
    expect(paintWrappedMask({ ...base, mask: blank(), width: 4097 }))
      .toEqual({ ok: false, code: 'LIMIT' });
    expect(paintWrappedMask({ ...base, mask: blank(), width: 1024, height: 1025 }))
      .toEqual({ ok: false, code: 'LIMIT' });
  });
});
