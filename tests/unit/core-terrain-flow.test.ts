import { describe, expect, it } from 'vitest';
import { accumulateTerrainFlow } from '../../src/core/terrain/flow';

describe('D4 portable D8 terrain flow accumulation', () => {
  it('matches a known 3x3 synthetic drainage network and all contributing counts', () => {
    const heights = [9, 8, 7, 8, 5, 4, 7, 4, 0];
    expect(accumulateTerrainFlow({ width: 3, height: 3, heights })).toEqual({
      ok: true,
      downstream: new Int32Array([4, 4, 5, 4, 8, 8, 7, 8, -1]),
      accumulation: new Uint32Array([1, 1, 1, 1, 4, 2, 1, 2, 9]),
    });
  });

  it('leaves flat terrain as separate sinks and accumulates a central depression', () => {
    expect(accumulateTerrainFlow({ width: 2, height: 2, heights: [1, 1, 1, 1] }))
      .toEqual({ ok: true, downstream: new Int32Array([-1, -1, -1, -1]),
        accumulation: new Uint32Array([1, 1, 1, 1]) });
    const depression = accumulateTerrainFlow({
      width: 3, height: 3, heights: [2, 2, 2, 2, 0, 2, 2, 2, 2],
    });
    expect(depression.ok).toBe(true);
    if (!depression.ok) return;
    expect([...depression.downstream]).toEqual([4, 4, 4, 4, -1, 4, 4, 4, 4]);
    expect([...depression.accumulation]).toEqual([1, 1, 1, 1, 9, 1, 1, 1, 1]);
  });

  it('handles single-row chains and chooses the steepest slope, not simply the lowest neighbour', () => {
    expect(accumulateTerrainFlow({ width: 3, height: 1, heights: [3, 2, 1] }))
      .toEqual({ ok: true, downstream: new Int32Array([1, 2, -1]),
        accumulation: new Uint32Array([1, 2, 3]) });
    const diagonal = accumulateTerrainFlow({ width: 2, height: 2, heights: [10, 5, 7, 0] });
    const straight = accumulateTerrainFlow({ width: 2, height: 2, heights: [10, 2, 8, 1] });
    expect(diagonal.ok && straight.ok).toBe(true);
    if (diagonal.ok && straight.ok) {
      expect(diagonal.downstream[0]).toBe(3); // 10/sqrt(2) > 5
      expect(straight.downstream[0]).toBe(1); // 8 > 9/sqrt(2)
    }
  });

  it('resolves equal steepest slopes by the smallest row-major destination index', () => {
    const r = accumulateTerrainFlow({
      width: 3, height: 3, heights: [9, 1, 9, 1, 10, 1, 9, 1, 9],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.downstream[4]).toBe(1);
  });

  it('accepts frozen number arrays and Float64Array without mutating inputs', () => {
    const heights = Object.freeze([5, 4, 3, 2]);
    const first = accumulateTerrainFlow({ width: 2, height: 2, heights });
    const again = accumulateTerrainFlow({ width: 2, height: 2, heights });
    expect(first).toEqual(again);
    expect(heights).toEqual([5, 4, 3, 2]);
    const typed = new Float64Array(heights);
    expect(accumulateTerrainFlow({ width: 2, height: 2, heights: typed })).toEqual(first);
    expect([...typed]).toEqual([...heights]);
    expect(accumulateTerrainFlow({ width: 1, height: 1, heights: [42] }))
      .toEqual({ ok: true, downstream: new Int32Array([-1]), accumulation: new Uint32Array([1]) });
  });

  it('rejects malformed heights, dimensions and option objects', () => {
    expect(accumulateTerrainFlow(null as never)).toEqual({ ok: false, code: 'INPUT' });
    expect(accumulateTerrainFlow({ width: 0, height: 1, heights: [] }))
      .toEqual({ ok: false, code: 'INPUT' });
    expect(accumulateTerrainFlow({ width: 1.5, height: 1, heights: [] }))
      .toEqual({ ok: false, code: 'INPUT' });
    expect(accumulateTerrainFlow({ width: 2, height: 2, heights: [1] }))
      .toEqual({ ok: false, code: 'INPUT' });
    expect(accumulateTerrainFlow({ width: 1, height: 1, heights: [NaN] }))
      .toEqual({ ok: false, code: 'INPUT' });
    expect(accumulateTerrainFlow({ width: 1, height: 1, heights: [Infinity] }))
      .toEqual({ ok: false, code: 'INPUT' });
    expect(accumulateTerrainFlow({ width: 1, height: 1, heights: '3' as never }))
      .toEqual({ ok: false, code: 'INPUT' });
    expect(accumulateTerrainFlow({ width: 1, height: 1, heights: [1], maxCells: 0 }))
      .toEqual({ ok: false, code: 'INPUT' });
    expect(accumulateTerrainFlow({ width: 1, height: 1, heights: [1], maxCells: 1.5 }))
      .toEqual({ ok: false, code: 'INPUT' });
  });

  it('rejects oversized rasters and non-finite derived height differences', () => {
    expect(accumulateTerrainFlow({ width: 4097, height: 1, heights: [] }))
      .toEqual({ ok: false, code: 'LIMIT' });
    expect(accumulateTerrainFlow({ width: 1024, height: 1025, heights: [] }))
      .toEqual({ ok: false, code: 'LIMIT' });
    expect(accumulateTerrainFlow({ width: 1, height: 1, heights: [1], maxCells: 1048577 }))
      .toEqual({ ok: false, code: 'LIMIT' });
    expect(accumulateTerrainFlow({ width: 3, height: 1, heights: [3, 2, 1], maxCells: 2 }))
      .toEqual({ ok: false, code: 'LIMIT' });
    expect(accumulateTerrainFlow({
      width: 2, height: 1, heights: [Number.MAX_VALUE, -Number.MAX_VALUE],
    })).toEqual({ ok: false, code: 'LIMIT' });
  });

  it('agrees with an independent descending-elevation oracle for seeded synthetic grids', () => {
    let seed = 0x78bdea31;
    const random = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 4294967296;
    };
    for (let batch = 0; batch < 50; batch++) {
      const width = 5;
      const height = 4;
      const heights = Array.from({ length: width * height }, () => Math.floor(random() * 30));
      const expectedDownstream = new Int32Array(heights.length).fill(-1);
      for (let source = 0; source < heights.length; source++) {
        const sx = source % width;
        const sy = Math.floor(source / width);
        const neighbours: Array<{ index: number; slope: number }> = [];
        for (let target = 0; target < heights.length; target++) {
          const tx = target % width;
          const ty = Math.floor(target / width);
          const dx = Math.abs(sx - tx);
          const dy = Math.abs(sy - ty);
          if (Math.max(dx, dy) !== 1 || heights[target] >= heights[source]) continue;
          neighbours.push({ index: target,
            slope: (heights[source] - heights[target]) / (dx === 1 && dy === 1 ? Math.SQRT2 : 1) });
        }
        neighbours.sort((a, b) => b.slope - a.slope || a.index - b.index);
        if (neighbours.length > 0) expectedDownstream[source] = neighbours[0].index;
      }
      const expectedAccumulation = new Uint32Array(heights.length).fill(1);
      const highToLow = heights.map((_, i) => i).sort((a, b) => heights[b] - heights[a] || a - b);
      for (const i of highToLow) {
        const down = expectedDownstream[i];
        if (down !== -1) expectedAccumulation[down] += expectedAccumulation[i];
      }
      expect(accumulateTerrainFlow({ width, height, heights })).toEqual({
        ok: true, downstream: expectedDownstream, accumulation: expectedAccumulation,
      });
    }
  });
});
