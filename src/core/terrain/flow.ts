/** Portable D8 steepest-descent flow accumulation on a height grid. */
export type TerrainFlowOptions = Readonly<{
  width: number;
  height: number;
  /** Finite, row-major elevations; higher cells drain to strictly lower cells. */
  heights: readonly number[] | Float64Array;
  maxCells?: number;
}>;
export type TerrainFlowResult =
  | Readonly<{ ok: true; downstream: Int32Array; accumulation: Uint32Array }>
  | Readonly<{ ok: false; code: 'INPUT' | 'LIMIT' }>;

const MAX_DIMENSION = 4096;
const MAX_CELLS = 1024 * 1024;

/**
 * For each cell, choose its steepest strictly lower neighbour among the
 * eight adjacent cells. Cardinal distance is 1; diagonal distance is sqrt(2).
 * Exact ties choose the smallest row-major neighbour index. Flat areas and
 * local minima remain sinks (-1). No depression filling or erosion occurs.
 *
 * Each cell contributes exactly one unit of flow to itself and all downstream
 * cells. The directed flow network is acyclic (strict downhill), so a Kahn
 * indegree traversal accumulates contributions in O(width * height) work.
 * Caller-provided heights are not mutated. All output arrays are bounded.
 */
export function accumulateTerrainFlow(options: TerrainFlowOptions): TerrainFlowResult {
  if (!options || !Number.isSafeInteger(options.width) ||
      !Number.isSafeInteger(options.height) || options.width < 1 || options.height < 1 ||
      !(Array.isArray(options.heights) || options.heights instanceof Float64Array)) {
    return { ok: false, code: 'INPUT' };
  }
  const { width, height, heights } = options;
  const maxCells = options.maxCells ?? MAX_CELLS;
  if (!Number.isSafeInteger(maxCells) || maxCells < 1) return { ok: false, code: 'INPUT' };
  if (width > MAX_DIMENSION || height > MAX_DIMENSION ||
      width * height > MAX_CELLS || maxCells > MAX_CELLS ||
      width * height > maxCells) return { ok: false, code: 'LIMIT' };

  const count = width * height;
  if (heights.length !== count) return { ok: false, code: 'INPUT' };
  for (let i = 0; i < count; i++) {
    if (!Number.isFinite(heights[i])) return { ok: false, code: 'INPUT' };
  }

  const downstream = new Int32Array(count).fill(-1);
  const indegree = new Uint32Array(count);
  for (let index = 0; index < count; index++) {
    const x = index % width;
    const y = Math.floor(index / width);
    const elevation = heights[index];
    let bestSlope = 0;
    let bestIndex = -1;

    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        const neighbour = ny * width + nx;
        const lower = heights[neighbour];
        if (lower >= elevation) continue;

        const drop = elevation - lower;
        if (!Number.isFinite(drop)) return { ok: false, code: 'LIMIT' };
        const slope = drop / (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1);
        if (slope > bestSlope || (slope > 0 && slope === bestSlope && neighbour < bestIndex)) {
          bestSlope = slope;
          bestIndex = neighbour;
        }
      }
    }
    if (bestIndex >= 0) {
      downstream[index] = bestIndex;
      indegree[bestIndex]++;
    }
  }

  const accumulation = new Uint32Array(count).fill(1);
  const queue = new Int32Array(count);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < count; i++) {
    if (indegree[i] === 0) queue[tail++] = i;
  }
  while (head < tail) {
    const index = queue[head++];
    const destination = downstream[index];
    if (destination === -1) continue;
    accumulation[destination] += accumulation[index];
    indegree[destination]--;
    if (indegree[destination] === 0) queue[tail++] = destination;
  }

  // This cannot happen for strictly descending finite elevations.
  if (head !== count) return { ok: false, code: 'LIMIT' };
  return { ok: true, downstream, accumulation };
}
