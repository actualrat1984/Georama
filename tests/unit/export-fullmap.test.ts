import { describe, expect, it } from 'vitest';
import { ExportError } from '../../src/core/export/errors.ts';
import { checkFullMapRasters, fullMapExtent } from '../../src/core/export/fullmap.ts';
import type { RgbaRaster } from '../../src/core/firstlight/layers.ts';

// Card 1.10 Stage C step 2a (detail v4): the full-map extent and the raster checks for the harness.
// Pure: no map file, no GPU, no window. Synthetic rasters only.

/** A raster with correct RGBA8 data for its own size. */
function raster(width: number, height: number): RgbaRaster {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

/** A raster that carries only its size (for checks that read no data). */
function bare(width: number, height: number): RgbaRaster {
  return { width, height, data: new Uint8Array(0) };
}

/** The error code thrown by fn, or 'none' when it returns, or 'other' for a non-export error. */
function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'none';
  } catch (error) {
    return error instanceof ExportError ? error.code : 'other';
  }
}

describe('fullMapExtent', () => {
  it('returns the full extent of a 2048 x 1024 mask, at the origin', () => {
    expect(fullMapExtent(bare(2048, 1024))).toEqual({ x0: 0, y0: 0, width: 2048, height: 1024 });
  });

  it('refuses a side above 8192 with code limit', () => {
    expect(codeOf(() => fullMapExtent(bare(8193, 1)))).toBe('limit');
  });

  it('refuses a non-integer size with code param', () => {
    expect(codeOf(() => fullMapExtent(bare(10.5, 10)))).toBe('param');
  });
});

describe('checkFullMapRasters', () => {
  it('accepts three rasters of the mask size', () => {
    const mask = raster(2048, 1024);
    expect(() => checkFullMapRasters(mask, raster(2048, 1024), raster(2048, 1024))).not.toThrow();
  });

  it('refuses a ground raster of another width with code param', () => {
    const mask = raster(2048, 1024);
    expect(codeOf(() => checkFullMapRasters(mask, raster(1024, 1024), raster(2048, 1024)))).toBe('param');
  });

  it('refuses a tint with a short buffer with code length', () => {
    const mask = raster(2048, 1024);
    const shortTint: RgbaRaster = { width: 2048, height: 1024, data: new Uint8Array(10) };
    expect(codeOf(() => checkFullMapRasters(mask, raster(2048, 1024), shortTint))).toBe('length');
  });

  it('refuses a mask above the side cap with code limit', () => {
    expect(codeOf(() => checkFullMapRasters(bare(8193, 1), bare(8193, 1), bare(8193, 1)))).toBe('limit');
  });
});
