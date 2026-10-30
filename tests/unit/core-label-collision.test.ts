import { describe, expect, it } from 'vitest';
import { selectNonOverlappingLabels, type LabelBox } from '../../src/core/labels/collision';

const box = (x: number, y: number, width: number, height: number): LabelBox =>
  ({ x, y, width, height });

describe('D3 portable collision filtering for synthetic label boxes', () => {
  it('keeps earlier labels and rejects overlap in stable input order', () => {
    expect(selectNonOverlappingLabels([
      box(0, 0, 10, 10), box(5, 5, 10, 10), box(10, 0, 10, 10),
    ])).toEqual({ ok: true, accepted: [0, 2], rejected: [1] });
  });

  it('allows touching sides and corners but rejects fractional interior overlap', () => {
    expect(selectNonOverlappingLabels([
      box(0, 0, 2, 2), box(2, 0, 2, 2), box(0, 2, 2, 2),
      box(2, 2, 1, 1), box(1.99, 1.99, 0.1, 0.1),
    ])).toEqual({ ok: true, accepted: [0, 1, 2, 3], rejected: [4] });
  });

  it('does not let a rejected candidate block a later independent label', () => {
    expect(selectNonOverlappingLabels([
      box(0, 0, 10, 2), box(8, 0, 10, 2), box(12, 0, 5, 2),
    ])).toEqual({ ok: true, accepted: [0, 2], rejected: [1] });
  });

  it('accepts the first of duplicate boxes and can return an empty selection', () => {
    expect(selectNonOverlappingLabels([
      box(3, 4, 2, 3), box(3, 4, 2, 3), box(100, 100, 1, 1),
    ])).toEqual({ ok: true, accepted: [0, 2], rejected: [1] });
    expect(selectNonOverlappingLabels([])).toEqual({ ok: true, accepted: [], rejected: [] });
  });

  it('supports negative fractional coordinates and remains immutable', () => {
    const labels = Object.freeze([
      Object.freeze(box(-1.5, -0.5, 0.5, 1)),
      Object.freeze(box(-1, -0.5, 0.5, 1)),
      Object.freeze(box(-1.25, 0, 0.5, 0.25)),
    ]);
    const expected = { ok: true, accepted: [0, 1], rejected: [2] };
    expect(selectNonOverlappingLabels(labels)).toEqual(expected);
    expect(selectNonOverlappingLabels(labels)).toEqual(expected);
    expect(labels[0]).toEqual(box(-1.5, -0.5, 0.5, 1));
  });

  it('rejects malformed boxes and input containers, without throwing', () => {
    expect(selectNonOverlappingLabels(null as never))
      .toEqual({ ok: false, code: 'INPUT' });
    expect(selectNonOverlappingLabels([null as never]))
      .toEqual({ ok: false, code: 'INPUT' });
    expect(selectNonOverlappingLabels([box(0, 0, 0, 1)]))
      .toEqual({ ok: false, code: 'INPUT' });
    expect(selectNonOverlappingLabels([box(0, 0, 1, -1)]))
      .toEqual({ ok: false, code: 'INPUT' });
    expect(selectNonOverlappingLabels([box(NaN, 0, 1, 1)]))
      .toEqual({ ok: false, code: 'INPUT' });
    expect(selectNonOverlappingLabels([box(0, Infinity, 1, 1)]))
      .toEqual({ ok: false, code: 'INPUT' });
    expect(selectNonOverlappingLabels([box(0, 0, 1, 1)], 0))
      .toEqual({ ok: false, code: 'INPUT' });
    expect(selectNonOverlappingLabels([box(0, 0, 1, 1)], 1.5))
      .toEqual({ ok: false, code: 'INPUT' });
  });

  it('rejects derived-coordinate overflow and excessive input counts', () => {
    expect(selectNonOverlappingLabels([box(Number.MAX_VALUE, 0, Number.MAX_VALUE, 1)]))
      .toEqual({ ok: false, code: 'LIMIT' });
    // Finite additions may round a positive width down to zero at extreme x/y.
    expect(selectNonOverlappingLabels([box(Number.MAX_VALUE, 0, 1, 1)]))
      .toEqual({ ok: false, code: 'LIMIT' });
    expect(selectNonOverlappingLabels([box(0, Number.MAX_VALUE, 1, 1)]))
      .toEqual({ ok: false, code: 'LIMIT' });
    expect(selectNonOverlappingLabels([box(0, -Number.MAX_VALUE, 1, Number.MAX_VALUE)]).ok)
      .toBe(true);
    expect(selectNonOverlappingLabels([box(0, 0, 1, 1)], 4097))
      .toEqual({ ok: false, code: 'LIMIT' });
    expect(selectNonOverlappingLabels(Array(4097).fill(box(0, 0, 1, 1))))
      .toEqual({ ok: false, code: 'LIMIT' });
    expect(selectNonOverlappingLabels([box(0, 0, 1, 1)], 1))
      .toEqual({ ok: true, accepted: [0], rejected: [] });
    expect(selectNonOverlappingLabels([box(0, 0, 1, 1), box(2, 0, 1, 1)], 1))
      .toEqual({ ok: false, code: 'LIMIT' });
  });

  it('agrees with an independent pairwise-oracle on fixed-seed synthetic boxes', () => {
    let seed = 0x19a0b4d3;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let batch = 0; batch < 100; batch++) {
      const boxes = Array.from({ length: 12 }, () =>
        box(Math.floor(random() * 13) - 6, Math.floor(random() * 13) - 6,
          1 + Math.floor(random() * 4), 1 + Math.floor(random() * 4)));
      const accepted: number[] = [];
      const rejected: number[] = [];
      for (let i = 0; i < boxes.length; i++) {
        const candidate = boxes[i];
        const isFree = accepted.every(j => {
          const chosen = boxes[j];
          return candidate.x >= chosen.x + chosen.width ||
            chosen.x >= candidate.x + candidate.width ||
            candidate.y >= chosen.y + chosen.height ||
            chosen.y >= candidate.y + candidate.height;
        });
        (isFree ? accepted : rejected).push(i);
      }
      expect(selectNonOverlappingLabels(boxes)).toEqual({ ok: true, accepted, rejected });
    }
  });
});
