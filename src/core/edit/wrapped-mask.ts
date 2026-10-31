/** Portable horizontal world-wrap painting on a binary row-major raster. */
export type WrappedMaskPaintOptions = Readonly<{
  width: number;
  height: number;
  mask: Uint8Array;
  /** Cell (0, 0) is centered at (0.5, 0.5). */
  centerX: number;
  centerY: number;
  radius: number;
  /** Set covered cells to 1, or erase them to 0. */
  value: 0 | 1;
}>;
export type WrappedMaskPaintResult =
  | Readonly<{ ok: true; mask: Uint8Array; changed: number }>
  | Readonly<{ ok: false; code: 'INPUT' | 'LIMIT' }>;

const MAX_CELLS = 1024 * 1024;
const MAX_DIMENSION = 4096;

/**
 * Paint a filled disc into a *new* binary mask, wrapping horizontally across
 * the map seam. Y is clipped, not wrapped. Cells are tested at their centers.
 * Radius zero paints only an exactly coincident cell center.
 * The result counts actually changed cells; the caller's mask is never mutated.
 * Work and output memory are capped independently of brush radius.
 */
export function paintWrappedMask(options: WrappedMaskPaintOptions): WrappedMaskPaintResult {
  if (!options || !Number.isSafeInteger(options.width) || !Number.isSafeInteger(options.height) ||
      options.width < 1 || options.height < 1 || !(options.mask instanceof Uint8Array) ||
      !Number.isFinite(options.centerX) || !Number.isFinite(options.centerY) ||
      !Number.isFinite(options.radius) || options.radius < 0 ||
      (options.value !== 0 && options.value !== 1)) return { ok: false, code: 'INPUT' };
  const { width, height, mask, centerX, centerY, radius, value } = options;
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_CELLS) {
    return { ok: false, code: 'LIMIT' };
  }
  if (mask.length !== width * height) return { ok: false, code: 'INPUT' };
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 0 && mask[i] !== 1) return { ok: false, code: 'INPUT' };
  }

  // Normalize negative and out-of-range centers to the periodic x coordinate.
  const wrappedX = ((centerX % width) + width) % width;
  // Always allocate independent storage: Node Buffer.slice() would alias the input.
  const painted = new Uint8Array(mask);
  let changed = 0;
  for (let y = 0; y < height; y++) {
    const dy = (y + 0.5) - centerY;
    for (let x = 0; x < width; x++) {
      const directX = Math.abs((x + 0.5) - wrappedX);
      const dx = Math.min(directX, width - directX);
      if (Math.hypot(dx, dy) <= radius) {
        const index = y * width + x;
        if (painted[index] !== value) {
          painted[index] = value;
          changed++;
        }
      }
    }
  }
  return { ok: true, mask: painted, changed };
}
