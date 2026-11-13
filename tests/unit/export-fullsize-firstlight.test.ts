import { describe, expect, it } from 'vitest';
import { buildFirstLightLayers, type RgbaRaster } from '../../src/core/firstlight/layers.ts';

// Card 1.10 Stage C step 1 (detail v3, P19): the first-light builder must accept a full map size above
// WINDOW_SIZE (1024). This is a characterization test on synthetic inputs (no map data). It is expected to
// pass on the existing builder; it is not a RED test. A failure would show a size limit that the detail
// does not know about.

const W = 2048;
const H = 1024;
const THRESHOLD = 156;

function raster(width: number, height: number, at: (x: number, y: number) => number[]): RgbaRaster {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = at(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { width, height, data };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

describe('first-light builder at a full map size (above WINDOW_SIZE)', () => {
  it('accepts a 2048 x 1024 window at the origin and returns rasters of the same size', () => {
    // Land (alpha 255) on the left 1024 columns, water (alpha 0) on the right.
    const mask = raster(W, H, (x) => [0, 0, 0, x < 1024 ? 255 : 0]);
    const ground = raster(W, H, () => [120, 100, 80, 255]);
    const tint = raster(W, H, () => [255, 255, 255, 255]);

    const out = buildFirstLightLayers({
      mask,
      ground,
      tint,
      threshold: THRESHOLD,
      x0: 0,
      y0: 0,
      width: W,
      height: H,
    });

    for (const layer of [out.mask, out.ground, out.water]) {
      expect(layer.width).toBe(W);
      expect(layer.height).toBe(H);
      expect(layer.data.length).toBe(W * H * 4);
    }
    // A full-map window copies the input mask, byte for byte.
    expect(sameBytes(out.mask.data, mask.data)).toBe(true);
    // Every texel is land or water, and the split follows the threshold rule (alpha >= 156 is land).
    expect(out.stats.land).toBe(1024 * H);
    expect(out.stats.land + out.stats.water).toBe(W * H);
  });
});
