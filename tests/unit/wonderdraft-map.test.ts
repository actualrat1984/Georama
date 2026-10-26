import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  GdDict,
  GdMath,
  GdNodePath,
  GdObject,
  GdPool,
  encodeStoreVar,
} from '../../src/core/formats/godot-var.ts';
import type { GdValue } from '../../src/core/formats/godot-var.ts';
import {
  WD_LIMITS,
  WdSchemaError,
  wdMapFromGd,
  wdMapToGd,
} from '../../src/core/formats/wonderdraft-map.ts';
import type { WdMap } from '../../src/core/formats/wonderdraft-map.ts';
import {
  f,
  readBool,
  readRecordList,
  writeBool,
  writeRecordList,
} from '../../src/core/formats/wonderdraft-map-engine.ts';
import { makeSyntheticRoot } from '../helpers/wd-synthetic.ts';

type Entry = [GdValue, GdValue];

function getKey(dict: GdDict, key: string): GdValue {
  const pair = dict.entries.find(([k]) => k === key);
  if (!pair) throw new Error('test setup: missing key ' + key);
  return pair[1];
}

function withEntry(dict: GdDict, key: string, value: GdValue): GdDict {
  return new GdDict(
    dict.entries.map(([k, v]): Entry => (k === key ? [k, value] : [k, v])),
    dict.shared,
  );
}

function withoutKey(dict: GdDict, key: string): GdDict {
  return new GdDict(
    dict.entries.filter(([k]) => k !== key),
    dict.shared,
  );
}

function appendedEntry(dict: GdDict, key: GdValue, value: GdValue): GdDict {
  return new GdDict([...dict.entries, [key, value]], dict.shared);
}

function prependedEntry(dict: GdDict, key: GdValue, value: GdValue): GdDict {
  return new GdDict([[key, value], ...dict.entries], dict.shared);
}

function insertedEntry(dict: GdDict, at: number, key: GdValue, value: GdValue): GdDict {
  const entries = [...dict.entries];
  entries.splice(at, 0, [key, value]);
  return new GdDict(entries, dict.shared);
}

function reordered(dict: GdDict, order: string[]): GdDict {
  const byKey = new Map<string, GdValue>();
  for (const [k, v] of dict.entries) byKey.set(k as string, v);
  return new GdDict(order.map((k): Entry => [k, byKey.get(k) as GdValue]), dict.shared);
}

function withProp(obj: GdObject, prop: string, value: GdValue): GdObject {
  return new GdObject(
    obj.cls,
    obj.props.map(([k, v]): [string, GdValue] => (k === prop ? [k, value] : [k, v])),
  );
}

function rasterDataValue(root: GdDict, key: string): Uint8Array {
  const obj = getKey(root, key) as GdObject;
  const dataProp = obj.props.find(([k]) => k === 'data');
  if (!dataProp) throw new Error('test setup: no data prop');
  return getKey(dataProp[1] as GdDict, 'data') as Uint8Array;
}

function withoutRasterInner(root: GdDict, key: string, innerKey: string): GdDict {
  const obj = getKey(root, key) as GdObject;
  const inner = obj.props.find(([k]) => k === 'data');
  if (!inner) throw new Error('test setup: no data prop');
  const next = withoutKey(inner[1] as GdDict, innerKey);
  return withEntry(root, key, withProp(obj, 'data', next));
}

function withRasterInner(root: GdDict, key: string, innerKey: string, value: GdValue): GdDict {
  const obj = getKey(root, key) as GdObject;
  const inner = obj.props.find(([k]) => k === 'data');
  if (!inner) throw new Error('test setup: no data prop');
  const next = withEntry(inner[1] as GdDict, innerKey, value);
  return withEntry(root, key, withProp(obj, 'data', next));
}

function expectWdError(fn: () => unknown, code: string, path: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(WdSchemaError);
    expect((e as WdSchemaError).code).toBe(code);
    expect((e as WdSchemaError).path).toBe(path);
    return;
  }
  throw new Error(`expected WdSchemaError ${code} at ${path}, but nothing threw`);
}

function gdCanon(v: GdValue): unknown {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'bigint') return { i: v.toString() };
  if (typeof v === 'number') return Number.isNaN(v) ? { nan: true } : { f: v };
  if (v instanceof GdMath) return { m: v.kind, v: Array.from(v.v) };
  if (v instanceof GdNodePath) return { n: [v.names, v.subnames, v.flags] };
  if (v instanceof GdObject) {
    return { o: v.cls, p: v.props.map(([k, val]) => [k, gdCanon(val)]) };
  }
  if (v instanceof GdDict) {
    return { d: v.entries.map(([k, val]) => [gdCanon(k), gdCanon(val)]), s: v.shared };
  }
  if (Array.isArray(v)) return v.map(gdCanon);
  if (v instanceof Uint8Array) return { b: Array.from(v) };
  if (v instanceof Int32Array) return { i32: Array.from(v) };
  if (v instanceof Float32Array) return { f32: Array.from(v) };
  if (v instanceof GdPool) {
    return { pool: v.kind, data: Array.isArray(v.data) ? v.data : Array.from(v.data) };
  }
  throw new Error('test setup: unexpected GdValue');
}

function expectDeepGd(a: GdValue, b: GdValue): void {
  expect(JSON.stringify(gdCanon(a))).toBe(JSON.stringify(gdCanon(b)));
}

function expectBytesEqual(a: GdValue, b: GdValue): void {
  const ea = encodeStoreVar(a);
  const eb = encodeStoreVar(b);
  expect(eb.length).toBe(ea.length);
  expect(Buffer.from(eb).equals(Buffer.from(ea))).toBe(true);
}

function expectRoundTrip(x: GdDict): WdMap {
  const map = wdMapFromGd(x);
  const back = wdMapToGd(map);
  expectDeepGd(back, x);
  expectBytesEqual(back, x);
  return map;
}

function timed(fn: () => void, ms: number): void {
  const start = Date.now();
  fn();
  expect(Date.now() - start).toBeLessThan(ms);
}

const ROOT_KEYS = [
  'version', 'map_width', 'map_height', 'water_level', 'water_flip_x', 'water_flip_y',
  'water_offset', 'water_stain', 'windroses', 'theme', 'layers', 'paths', 'territories',
  'symbols', 'labels', 'sharpen_labels', 'mask', 'ground', 'water_tint', 'trace', 'grid',
  'frame', 'scale', 'boxes', 'load_default_symbols', 'load_default_not_symbols',
  'included_default_packs', 'included_packs',
];

describe('1. round trip of the synthetic map', () => {
  it('decodes typed fields for every record kind', () => {
    const map = wdMapFromGd(makeSyntheticRoot());
    expect(map.version).toBe(15);
    expect(map.mapWidth).toBe(320.5);
    expect(map.mapHeight).toBe(200.25);
    expect(map.waterOffset).toEqual({ x: 9, y: 10 });
    expect(map.theme.waterTexture).toBe('SynthWater');
    expect(map.theme.coastlineStyle).toBe(1);
    expect(map.layers.names).toEqual(['L0', 'L1']);
    expect(map.paths).toHaveLength(1);
    expect(map.paths[0].points).toBe('[ Vector2( 1, 2 ), Vector2( 3.5, -4 ) ]');
    expect(map.paths[0].noiseSeed).toBe(1234567);
    expect(map.territories.territories).toHaveLength(1);
    expect(map.territories.territories[0].style).toBe('synth/border');
    expect(map.symbols).toHaveLength(2);
    expect(map.symbols[0].texture).toBe('synth/tree');
    expect(map.labels).toHaveLength(2);
    expect(map.labels[0].text).toBe('Northmill');
    expect(map.mask.width).toBe(2);
    expect(map.mask.height).toBe(2);
    expect(map.mask.format).toBe('RGBA8');
    expect(map.mask.mipmaps).toBe(false);
    expect(map.grid).not.toBeNull();
    expect(map.grid?.pattern).toBe(1);
    expect(map.frame.texture).toBe('SynthFrame');
    expect(map.scale?.units).toBe('uu');
    expect(map.trace).toBeNull();
    expect(map.includedPacks).toEqual(['PackD']);
  });

  it('re-encodes deep-equal and byte-identical, NIL and null Object distinct', () => {
    const x = makeSyntheticRoot();
    expect(getKey(x, 'trace')).toBeNull();
    const maskObj = getKey(x, 'mask') as GdObject;
    const script = maskObj.props.find(([k]) => k === 'script');
    expect(script?.[1]).toBeInstanceOf(GdObject);
    expect((script?.[1] as GdObject).cls).toBe('');
    expectRoundTrip(x);
  });
});

describe('2. unions and nullables', () => {
  it('grid/scale records round-trip; both NIL round-trip as null', () => {
    const withRecords = expectRoundTrip(makeSyntheticRoot());
    expect(withRecords.grid).not.toBeNull();
    expect(withRecords.scale).not.toBeNull();
    const bothNil = expectRoundTrip(makeSyntheticRoot({ gridNull: true, scaleNull: true }));
    expect(bothNil.grid).toBeNull();
    expect(bothNil.scale).toBeNull();
  });

  it('symbol sample/custom variants and ImageTexture texture round-trip', () => {
    const map = expectRoundTrip(makeSyntheticRoot());
    expect(map.symbols[0].sample).toEqual({ r: 0.5, g: 0.5, b: 0.5, a: 1 });
    expect(map.symbols[0].customColors).toHaveLength(3);
    expect(map.symbols[0].customColorMode).toBe(2);
    expect(map.symbols[1].sample).toBeNull();
    expect(map.symbols[1].customColors).toBeNull();
    expect(map.symbols[1].customColorMode).toBeNull();
    expect(map.symbols[1].texture).toBeInstanceOf(GdObject);
    expect((map.symbols[1].texture as GdObject).cls).toBe('ImageTexture');
  });

  it('glow_size keeps its wire kind per label', () => {
    const map = expectRoundTrip(makeSyntheticRoot());
    expect(typeof map.labels[0].glowSize).toBe('bigint');
    expect(map.labels[0].glowSize).toBe(2n);
    expect(typeof map.labels[1].glowSize).toBe('number');
    expect(map.labels[1].glowSize).toBe(1.5);
  });
});

describe('3. unknown keys and key order', () => {
  it('unknown root keys at start, middle and end survive with exact order', () => {
    expectRoundTrip(prependedEntry(makeSyntheticRoot(), 'zz_first', 1n));
    expectRoundTrip(insertedEntry(makeSyntheticRoot(), 10, 'zz_mid', 'half'));
    expectRoundTrip(appendedEntry(makeSyntheticRoot(), 'zz_last', true));
  });

  it('unknown keys in theme, frame, a symbol and a raster data dict survive', () => {
    const x = makeSyntheticRoot();
    const theme = appendedEntry(appendedEntry(getKey(x, 'theme') as GdDict, 'zz_t', 9n), 'zz_t2', false);
    const frame = reordered(getKey(x, 'frame') as GdDict, ['tint', 'size', 'texture', 'enabled']);
    const symbols = getKey(x, 'symbols') as GdValue[];
    const sym0 = appendedEntry(symbols[0] as GdDict, 'zz_s', 3.5);
    let y = withEntry(x, 'theme', theme);
    y = withEntry(y, 'frame', appendedEntry(frame, 'bonus', 1n));
    y = withEntry(y, 'symbols', [sym0, symbols[1]]);
    const inner = (getKey(y, 'mask') as GdObject).props.find(([k]) => k === 'data')?.[1] as GdDict;
    const innerX = appendedEntry(insertedEntry(inner, 1, 'zz_r', 'raw'), 'zz_r2', 0n);
    const maskObj = getKey(y, 'mask') as GdObject;
    const z = withEntry(y, 'mask', withProp(maskObj, 'data', innerX));
    const map = wdMapFromGd(z);
    expect(map.theme.extra?.length).toBe(2);
    expect(map.frame.layout).toEqual(['tint', 'size', 'texture', 'enabled', 0]);
    const back = wdMapToGd(map);
    expectDeepGd(back, z);
    expectBytesEqual(back, z);
  });

  it('a non-string unknown key survives', () => {
    expectRoundTrip(appendedEntry(makeSyntheticRoot(), 7n, 'seven'));
  });

  it('two label_presets orders both re-encode byte-identically', () => {
    const a = makeSyntheticRoot();
    expectRoundTrip(a);
    const theme = getKey(a, 'theme') as GdDict;
    const presets = getKey(theme, 'label_presets') as GdDict;
    const region = new GdDict([['font_name', 'F9']]);
    const reorderedPresets = new GdDict([
      ['Town', getKey(presets, 'Town')],
      ['City', getKey(presets, 'City')],
      ['Water', getKey(presets, 'Water')],
      ['Region', region],
    ]);
    expectRoundTrip(withEntry(a, 'theme', withEntry(theme, 'label_presets', reorderedPresets)));
  });

  it('a canonical record carries neither layout nor extra', () => {
    const map = wdMapFromGd(makeSyntheticRoot());
    expect('layout' in map.frame).toBe(false);
    expect('extra' in map.frame).toBe(false);
    expect('layout' in map).toBe(false);
    expect('extra' in map).toBe(false);
  });

  it('a tampered layout makes the writer throw FORMAT', () => {
    const good = wdMapFromGd(makeSyntheticRoot());
    const missingKey = wdMapFromGd(makeSyntheticRoot());
    missingKey.frame = { ...good.frame, layout: ['enabled', 'texture', 'tint'], extra: [] };
    expectWdError(() => wdMapToGd(missingKey), 'FORMAT', '/frame');
    const badIndex = wdMapFromGd(makeSyntheticRoot());
    badIndex.frame = { ...good.frame, layout: ['enabled', 'texture', 'size', 'tint', 99], extra: [] };
    expectWdError(() => wdMapToGd(badIndex), 'FORMAT', '/frame');
    const badName = wdMapFromGd(makeSyntheticRoot());
    badName.frame = { ...good.frame, layout: ['enabled', 'texture', 'size', 'nope'], extra: [] };
    expectWdError(() => wdMapToGd(badName), 'FORMAT', '/frame');
  });
});

describe('4. kind discipline, exact code and path', () => {
  it('rejects wrong wire kinds with TYPE at the field path', () => {
    expectWdError(() => wdMapFromGd(withEntry(makeSyntheticRoot(), 'map_width', 5n)), 'TYPE', '/map_width');
    const symReal = getKey(makeSyntheticRoot(), 'symbols') as GdValue[];
    const badZ = withEntry(symReal[0] as GdDict, 'z_index', 1.5);
    expectWdError(
      () => wdMapFromGd(withEntry(makeSyntheticRoot(), 'symbols', [badZ, symReal[1]])),
      'TYPE', '/symbols[0]/z_index',
    );
    const badBool = withEntry(symReal[0] as GdDict, 'z_index', true);
    expectWdError(
      () => wdMapFromGd(withEntry(makeSyntheticRoot(), 'symbols', [badBool, symReal[1]])),
      'TYPE', '/symbols[0]/z_index',
    );
    const badNil = withEntry(symReal[1] as GdDict, 'position', null);
    expectWdError(
      () => wdMapFromGd(withEntry(makeSyntheticRoot(), 'symbols', [symReal[0], badNil])),
      'TYPE', '/symbols[1]/position',
    );
    expectWdError(() => wdMapFromGd(withEntry(makeSyntheticRoot(), 'grid', new GdObject('', []))), 'TYPE', '/grid');
    const badStr = withEntry(symReal[1] as GdDict, 'position', 'oops');
    expectWdError(
      () => wdMapFromGd(withEntry(makeSyntheticRoot(), 'symbols', [symReal[0], badStr])),
      'TYPE', '/symbols[1]/position',
    );
  });

  it('rejects bad model values on write', () => {
    const nonInt = wdMapFromGd(makeSyntheticRoot());
    nonInt.symbols[0].zIndex = 1.5;
    expectWdError(() => wdMapToGd(nonInt), 'TYPE', '/symbols[0]/z_index');
    const nanReal = wdMapFromGd(makeSyntheticRoot());
    nanReal.mapWidth = NaN;
    expectWdError(() => wdMapToGd(nanReal), 'FORMAT', '/map_width');
  });
});

describe('5. presence: MISSING, duplicates, VERSION', () => {
  it.each(ROOT_KEYS)('missing root key %s', (key) => {
    expectWdError(() => wdMapFromGd(withoutKey(makeSyntheticRoot(), key)), 'MISSING', `/${key}`);
  });

  it('missing keys inside records -> MISSING at the key path', () => {
    const x = makeSyntheticRoot();
    expectWdError(
      () => wdMapFromGd(withEntry(x, 'theme', withoutKey(getKey(x, 'theme') as GdDict, 'water_texture'))),
      'MISSING', '/theme/water_texture',
    );
    expectWdError(
      () => wdMapFromGd(withEntry(x, 'layers', withoutKey(getKey(x, 'layers') as GdDict, 'names'))),
      'MISSING', '/layers/names',
    );
    expectWdError(
      () => wdMapFromGd(withEntry(x, 'frame', withoutKey(getKey(x, 'frame') as GdDict, 'tint'))),
      'MISSING', '/frame/tint',
    );
    expectWdError(
      () => wdMapFromGd(withEntry(x, 'grid', withoutKey(getKey(x, 'grid') as GdDict, 'color'))),
      'MISSING', '/grid/color',
    );
    expectWdError(
      () => wdMapFromGd(withEntry(x, 'scale', withoutKey(getKey(x, 'scale') as GdDict, 'units'))),
      'MISSING', '/scale/units',
    );
    const paths = getKey(x, 'paths') as GdValue[];
    expectWdError(
      () => wdMapFromGd(withEntry(x, 'paths', [withoutKey(paths[0] as GdDict, 'points')])),
      'MISSING', '/paths[0]/points',
    );
    expectWdError(
      () => wdMapFromGd(withEntry(x, 'territories', withoutKey(getKey(x, 'territories') as GdDict, 'territories'))),
      'MISSING', '/territories/territories',
    );
    const terr = getKey(getKey(x, 'territories') as GdDict, 'territories') as GdValue[];
    const terrInner = withoutKey(terr[0] as GdDict, 'points');
    const terrOuter = withEntry(getKey(x, 'territories') as GdDict, 'territories', [terrInner]);
    expectWdError(
      () => wdMapFromGd(withEntry(x, 'territories', terrOuter)),
      'MISSING', '/territories/territories[0]/points',
    );
    const syms = getKey(x, 'symbols') as GdValue[];
    expectWdError(
      () => wdMapFromGd(withEntry(x, 'symbols', [withoutKey(syms[0] as GdDict, 'position'), syms[1]])),
      'MISSING', '/symbols[0]/position',
    );
    const labels = getKey(x, 'labels') as GdValue[];
    expectWdError(
      () => wdMapFromGd(withEntry(x, 'labels', [labels[0], withoutKey(labels[1] as GdDict, 'text')])),
      'MISSING', '/labels[1]/text',
    );
    expectWdError(() => wdMapFromGd(withoutRasterInner(x, 'mask', 'width')), 'MISSING', '/mask/data/width');
  });

  it('a duplicate known key -> FORMAT', () => {
    const x = makeSyntheticRoot();
    const dup = new GdDict([...x.entries, ['version', 15n]], x.shared);
    expectWdError(() => wdMapFromGd(dup), 'FORMAT', '/version');
  });

  it('wrong versions -> VERSION, real version -> TYPE', () => {
    expectWdError(() => wdMapFromGd(withEntry(makeSyntheticRoot(), 'version', 16n)), 'VERSION', '/version');
    expectWdError(() => wdMapFromGd(withEntry(makeSyntheticRoot(), 'version', 14n)), 'VERSION', '/version');
    expectWdError(() => wdMapFromGd(withEntry(makeSyntheticRoot(), 'version', 15.0)), 'TYPE', '/version');
  });
});

describe('6. hostile structure', () => {
  it('non-dictionary root and non-array symbols', () => {
    timed(() => expectWdError(() => wdMapFromGd([1n, 2n]), 'TYPE', '/'), 200);
    timed(() => expectWdError(() => wdMapFromGd(withEntry(makeSyntheticRoot(), 'symbols', 'nope')), 'TYPE', '/symbols'), 200);
  });

  it('a symbol whose position is a String', () => {
    timed(() => {
      const syms = getKey(makeSyntheticRoot(), 'symbols') as GdValue[];
      const bad = withEntry(syms[0] as GdDict, 'position', 'here');
      expectWdError(() => wdMapFromGd(withEntry(makeSyntheticRoot(), 'symbols', [bad, syms[1]])), 'TYPE', '/symbols[0]/position');
    }, 200);
  });

  it('map_width NaN -> FORMAT', () => {
    timed(() => expectWdError(() => wdMapFromGd(withEntry(makeSyntheticRoot(), 'map_width', NaN)), 'FORMAT', '/map_width'), 200);
  });

  it('a 10M sparse symbols array -> LIMIT without iterating', () => {
    // Building a 10M-slot fixture can trigger allocation and GC pauses. Keep
    // that work outside the timed operation and forbid reading any array slot.
    const huge = new Proxy(new Array<GdValue>(10_000_000), {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^[0-9]+$/.test(property)) {
          throw new Error('oversized symbols array was indexed before its length was rejected');
        }
        return Reflect.get(target, property, receiver);
      },
      ownKeys() {
        throw new Error('oversized symbols array was enumerated before its length was rejected');
      },
    });
    const invalid = withEntry(makeSyntheticRoot(), 'symbols', huge);
    timed(() => expectWdError(() => wdMapFromGd(invalid), 'LIMIT', '/symbols'), 200);
  });

  it('a 50MB points string -> LIMIT', () => {
    timed(() => {
      const x = makeSyntheticRoot();
      const paths = getKey(x, 'paths') as GdValue[];
      const bad = withEntry(paths[0] as GdDict, 'points', 'x'.repeat(50_000_000));
      expectWdError(() => wdMapFromGd(withEntry(x, 'paths', [bad])), 'LIMIT', '/paths[0]/points');
    }, 200);
  });

  it('an Int outside the safe range -> LIMIT', () => {
    timed(() => {
      const syms = getKey(makeSyntheticRoot(), 'symbols') as GdValue[];
      const bad = withEntry(syms[0] as GdDict, 'z_index', 2n ** 60n);
      expectWdError(() => wdMapFromGd(withEntry(makeSyntheticRoot(), 'symbols', [bad, syms[1]])), 'LIMIT', '/symbols[0]/z_index');
    }, 200);
  });

  it('raster defects carry code and path', () => {
    timed(() => {
      expectWdError(() => wdMapFromGd(withRasterInner(makeSyntheticRoot(), 'mask', 'data', new Uint8Array(3))), 'FORMAT', '/mask/data/data');
    }, 200);
    timed(() => {
      expectWdError(() => wdMapFromGd(withRasterInner(makeSyntheticRoot(), 'mask', 'mipmaps', true)), 'FORMAT', '/mask/data/mipmaps');
    }, 200);
    timed(() => {
      expectWdError(() => wdMapFromGd(withRasterInner(makeSyntheticRoot(), 'mask', 'format', 'R8')), 'FORMAT', '/mask/data/format');
    }, 200);
    timed(() => {
      expectWdError(() => wdMapFromGd(withRasterInner(makeSyntheticRoot(), 'mask', 'width', 0n)), 'FORMAT', '/mask/data/width');
    }, 200);
    timed(() => {
      expectWdError(() => wdMapFromGd(withRasterInner(makeSyntheticRoot(), 'mask', 'width', -5n)), 'FORMAT', '/mask/data/width');
    }, 200);
    timed(() => {
      const x = makeSyntheticRoot();
      const mask = getKey(x, 'mask') as GdObject;
      const wrong = new GdObject('ImageTexture', mask.props);
      expectWdError(() => wdMapFromGd(withEntry(x, 'mask', wrong)), 'TYPE', '/mask');
    }, 200);
    timed(() => {
      expectWdError(() => wdMapFromGd(withRasterInner(makeSyntheticRoot(), 'mask', 'width', 70000n)), 'LIMIT', '/mask/data/width');
    }, 200);
  });
});

describe('7. zero-copy rasters and RAW identity', () => {
  it('raster bytes are the same object through both directions', () => {
    const x = makeSyntheticRoot();
    const map = wdMapFromGd(x);
    const rasters = [map.mask, map.ground, map.waterTint] as const;
    const keys = ['mask', 'ground', 'water_tint'] as const;
    for (let i = 0; i < rasters.length; i++) {
      expect(rasters[i].data).toBe(rasterDataValue(x, keys[i]));
    }
    const back = wdMapToGd(map);
    for (let i = 0; i < keys.length; i++) {
      expect(rasterDataValue(back, keys[i])).toBe(rasterDataValue(x, keys[i]));
    }
  });

  it('RAW values keep object identity', () => {
    const x = makeSyntheticRoot();
    const presets = getKey(getKey(x, 'theme') as GdDict, 'label_presets');
    const map = wdMapFromGd(x);
    expect(map.theme.labelPresets).toBe(presets);
    expect(map.trace).toBeNull();
    expect(map.boxes).toBe(getKey(x, 'boxes'));
    const back = wdMapToGd(map);
    expect(getKey(getKey(back, 'theme') as GdDict, 'label_presets')).toBe(presets);
  });
});

describe('8. throughput sanity', () => {
  it('20,000 synthetic symbols convert both ways in under 1000 ms each', () => {
    const x = makeSyntheticRoot();
    const syms = getKey(x, 'symbols') as GdValue[];
    const template = syms[0];
    const many: GdValue[] = new Array(20_000);
    for (let i = 0; i < many.length; i++) many[i] = template;
    const big = withEntry(x, 'symbols', many);
    let map: WdMap | undefined;
    timed(() => {
      map = wdMapFromGd(big);
    }, 1000);
    expect(map?.symbols.length).toBe(20_000);
    timed(() => {
      const back = wdMapToGd(map as WdMap);
      expect((getKey(back, 'symbols') as GdValue[]).length).toBe(20_000);
    }, 1000);
  });
});

describe('limits table', () => {
  it('exports the documented WD_LIMITS', () => {
    expect(WD_LIMITS).toEqual({
      maxSymbols: 2_000_000,
      maxLabels: 100_000,
      maxPaths: 100_000,
      maxTerritories: 100_000,
      maxBoxes: 64,
      maxListLength: 4_096,
      maxStringLength: 16_777_216,
      maxRasterSide: 65_536,
    });
  });
});

// Findings of the independent reviews of 4120332. All of them are one defect class: the reader and the writer must
// accept exactly the same files, otherwise a map that opens cannot be saved or a saved map cannot be opened.
describe('9. reader and writer agree (review follow-ups)', () => {
  it('the writer rejects a malformed extra entry instead of returning a corrupt dictionary', () => {
    for (const bad of [5, [1], null, [1, 2, 3], 'ab', undefined]) {
      const entry = bad as unknown as [GdValue, GdValue];
      const noLayout = wdMapFromGd(makeSyntheticRoot());
      noLayout.frame = { ...noLayout.frame, extra: [entry] };
      expectWdError(() => wdMapToGd(noLayout), 'FORMAT', '/frame');
      const withLayout = wdMapFromGd(makeSyntheticRoot());
      withLayout.frame = { ...withLayout.frame, layout: ['enabled', 'texture', 0, 'size', 'tint'], extra: [entry] };
      expectWdError(() => wdMapToGd(withLayout), 'FORMAT', '/frame');
    }
  });

  it('the writer rejects an extra key that shadows a known field', () => {
    const m = wdMapFromGd(makeSyntheticRoot());
    m.frame = { ...m.frame, extra: [['enabled', false]] };
    expectWdError(() => wdMapToGd(m), 'FORMAT', '/frame');
    const ok = wdMapFromGd(makeSyntheticRoot());
    ok.frame = { ...ok.frame, extra: [['bonus', 7n]] };
    expect(getKey(wdMapToGd(ok).entries.find(([k]) => k === 'frame')?.[1] as GdDict, 'bonus')).toBe(7n);
  });

  it('property: whatever the writer accepts, the reader reads back to the same bytes', () => {
    let seed = 0x1234abcd;
    const rand = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
    const extras: unknown[] = [
      [['bonus', 7n]], [], [['bonus', 7n], [5n, 'k']], [5], [[1]], [null], [['enabled', true]],
      [['x', 1n], ['y', 2n], ['z', 3n]], 'nope', undefined,
    ];
    const layouts: unknown[] = [
      undefined, ['enabled', 'texture', 0, 'size', 'tint'], ['enabled', 'texture', 'size', 'tint', 0],
      [0, 'enabled', 'texture', 'size', 'tint'], ['tint', 'size', 'texture', 'enabled'],
      ['enabled', 'texture', 'size', 'tint'], ['enabled', 'enabled', 'size', 'tint', 0],
      ['enabled', 'texture', 1, 'size', 'tint'], ['enabled', 'texture', -1, 'size', 'tint'], 'nope',
    ];
    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < 600; i++) {
      const m = wdMapFromGd(makeSyntheticRoot());
      m.frame = {
        ...m.frame,
        extra: pick(extras) as never,
        layout: pick(layouts) as never,
        shared: rand() < 0.3 ? true : undefined,
      };
      let written: GdDict;
      try {
        written = wdMapToGd(m);
      } catch (e) {
        expect(e).toBeInstanceOf(WdSchemaError);
        rejected++;
        continue;
      }
      accepted++;
      const back = wdMapFromGd(written);
      expectBytesEqual(wdMapToGd(back), written);
    }
    expect(accepted).toBeGreaterThan(50);
    expect(rejected).toBeGreaterThan(50);
  });

  it('the reader rejects an Image with two data props, which the writer could not write back', () => {
    const x = makeSyntheticRoot();
    const mask = getKey(x, 'mask') as GdObject;
    const dataProp = mask.props.find(([k]) => k === 'data') as [string, GdValue];
    const twice = new GdObject(mask.cls, [...mask.props, ['data', dataProp[1]]]);
    expectWdError(() => wdMapFromGd(withEntry(x, 'mask', twice)), 'FORMAT', '/mask/data');
  });

  it('the reader rejects an Image prop whose name is not a string', () => {
    const x = makeSyntheticRoot();
    const mask = getKey(x, 'mask') as GdObject;
    const odd = new GdObject(mask.cls, [...mask.props, [5 as unknown as string, 1n]]);
    expectWdError(() => wdMapFromGd(withEntry(x, 'mask', odd)), 'TYPE', '/mask');
    const notPair = new GdObject(mask.cls, [...mask.props, null as unknown as [string, GdValue]]);
    expectWdError(() => wdMapFromGd(withEntry(x, 'mask', notPair)), 'TYPE', '/mask');
  });

  it('judges the version before any other key, whatever the order of the keys', () => {
    const x = makeSyntheticRoot();
    // map_width (an Int where a Real is declared) comes first; the version problem must still win.
    const brokenFirst = prependedEntry(withoutKey(x, 'map_width'), 'map_width', 5n);
    expectWdError(() => wdMapFromGd(withEntry(brokenFirst, 'version', 16n)), 'VERSION', '/version');
    expectWdError(() => wdMapFromGd(withEntry(brokenFirst, 'version', 14n)), 'VERSION', '/version');
    expectWdError(() => wdMapFromGd(withEntry(brokenFirst, 'version', 15)), 'TYPE', '/version');
    expectWdError(() => wdMapFromGd(withoutKey(brokenFirst, 'version')), 'MISSING', '/version');
    // Without the version problem the other error is reported as before.
    expectWdError(() => wdMapFromGd(brokenFirst), 'TYPE', '/map_width');
  });

  it('rejects a non-finite Vector2 or Color component on read, as it does for a Real', () => {
    const x = makeSyntheticRoot();
    const theme = getKey(x, 'theme') as GdDict;
    for (const bad of [NaN, Infinity, -Infinity]) {
      for (let at = 0; at < 2; at++) {
        const v = [1, 2];
        v[at] = bad;
        expectWdError(
          () => wdMapFromGd(withEntry(x, 'water_offset', new GdMath('Vector2', new Float32Array(v)))),
          'FORMAT', '/water_offset',
        );
      }
      for (let at = 0; at < 4; at++) {
        const c = [0.1, 0.2, 0.3, 1];
        c[at] = bad;
        expectWdError(
          () => wdMapFromGd(withEntry(x, 'theme', withEntry(theme, 'path_color', new GdMath('Color', new Float32Array(c))))),
          'FORMAT', '/theme/path_color',
        );
      }
    }
    const syms = getKey(x, 'symbols') as GdValue[];
    const badSym = withEntry(syms[0] as GdDict, 'position', new GdMath('Vector2', new Float32Array([NaN, 0])));
    expectWdError(() => wdMapFromGd(withEntry(x, 'symbols', [badSym, syms[1]])), 'FORMAT', '/symbols[0]/position');
    const colors = [new GdMath('Color', new Float32Array([0, 0, 0, 1])), new GdMath('Color', new Float32Array([0, Infinity, 0, 1]))];
    expectWdError(
      () => wdMapFromGd(withEntry(x, 'theme', withEntry(theme, 'ground_colors', colors))),
      'FORMAT', '/theme/ground_colors[1]',
    );
  });

  it('accepts only a string or an ImageTexture object as a symbol texture', () => {
    const x = makeSyntheticRoot();
    const syms = getKey(x, 'symbols') as GdValue[];
    const withTexture = (value: GdValue): GdDict =>
      withEntry(x, 'symbols', [withEntry(syms[0] as GdDict, 'texture', value), syms[1]]);
    expectWdError(() => wdMapFromGd(withTexture(new GdObject('', []))), 'TYPE', '/symbols[0]/texture');
    expectWdError(() => wdMapFromGd(withTexture(new GdObject('Image', []))), 'TYPE', '/symbols[0]/texture');
    expectWdError(() => wdMapFromGd(withTexture(null)), 'TYPE', '/symbols[0]/texture');
    expectWdError(() => wdMapFromGd(withTexture(5n)), 'TYPE', '/symbols[0]/texture');
    const m = wdMapFromGd(x);
    m.symbols[0].texture = new GdObject('', []);
    expectWdError(() => wdMapToGd(m), 'TYPE', '/symbols[0]/texture');
    m.symbols[0].texture = new GdObject('Image', []);
    expectWdError(() => wdMapToGd(m), 'TYPE', '/symbols[0]/texture');
    const embedded = wdMapFromGd(withTexture(new GdObject('ImageTexture', [['resource_name', 'T']])));
    expect(embedded.symbols[0].texture).toBeInstanceOf(GdObject);
    expectBytesEqual(wdMapToGd(embedded), withTexture(new GdObject('ImageTexture', [['resource_name', 'T']])));
  });
});

// Second follow-up: the survivors of the quality review's 28 mutants were all test gaps, and the delta review found
// one more reader/writer asymmetry (an Image prop with three elements). Boundaries are pinned on both sides.
describe('10. boundaries and residual cases (second review follow-up)', () => {
  it('the Int range is inclusive at plus and minus Number.MAX_SAFE_INTEGER, on read and on write', () => {
    const x = makeSyntheticRoot();
    const syms = getKey(x, 'symbols') as GdValue[];
    const withZ = (z: bigint): GdDict => withEntry(x, 'symbols', [withEntry(syms[0] as GdDict, 'z_index', z), syms[1]]);
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    expect(wdMapFromGd(withZ(max)).symbols[0].zIndex).toBe(Number.MAX_SAFE_INTEGER);
    expect(wdMapFromGd(withZ(-max)).symbols[0].zIndex).toBe(-Number.MAX_SAFE_INTEGER);
    expectWdError(() => wdMapFromGd(withZ(max + 1n)), 'LIMIT', '/symbols[0]/z_index');
    expectWdError(() => wdMapFromGd(withZ(-max - 1n)), 'LIMIT', '/symbols[0]/z_index');
    const m = wdMapFromGd(x);
    m.symbols[0].zIndex = Number.MAX_SAFE_INTEGER;
    expect(getKey((getKey(wdMapToGd(m), 'symbols') as GdValue[])[0] as GdDict, 'z_index')).toBe(max);
    m.symbols[0].zIndex = Number.MAX_SAFE_INTEGER + 1;
    expectWdError(() => wdMapToGd(m), 'TYPE', '/symbols[0]/z_index');
  });

  it('rejects a Vector2 or Color with the wrong number of components', () => {
    const x = makeSyntheticRoot();
    const theme = getKey(x, 'theme') as GdDict;
    for (const n of [1, 3]) {
      expectWdError(
        () => wdMapFromGd(withEntry(x, 'water_offset', new GdMath('Vector2', new Float32Array(n)))),
        'TYPE', '/water_offset',
      );
    }
    for (const n of [3, 5]) {
      expectWdError(
        () => wdMapFromGd(withEntry(x, 'theme', withEntry(theme, 'path_color', new GdMath('Color', new Float32Array(n))))),
        'TYPE', '/theme/path_color',
      );
    }
  });

  it('applies the string limit with a strict greater-than, on read and on write', () => {
    const x = makeSyntheticRoot();
    const layers = getKey(x, 'layers') as GdDict;
    const atLimit = 'x'.repeat(WD_LIMITS.maxStringLength);
    const withName = (s: string): GdDict => withEntry(x, 'layers', withEntry(layers, 'names', [s]));
    expect(wdMapFromGd(withName(atLimit)).layers.names[0].length).toBe(WD_LIMITS.maxStringLength);
    expectWdError(() => wdMapFromGd(withName(atLimit + 'x')), 'LIMIT', '/layers/names[0]');
    const m = wdMapFromGd(x);
    m.layers.names = [atLimit];
    expect(() => wdMapToGd(m)).not.toThrow();
    m.layers.names = [atLimit + 'x'];
    expectWdError(() => wdMapToGd(m), 'LIMIT', '/layers/names[0]');
  });

  it('applies every list limit with a strict greater-than, on read and on write', () => {
    const x = makeSyntheticRoot();
    const layers = getKey(x, 'layers') as GdDict;
    const theme = getKey(x, 'theme') as GdDict;
    const color = (): GdValue => new GdMath('Color', new Float32Array([0, 0, 0, 1]));
    const lists: Array<{
      path: string;
      limit: number;
      read: (n: number) => GdDict;
      write: (m: WdMap, n: number) => void;
    }> = [
      {
        path: '/layers/names',
        limit: WD_LIMITS.maxListLength,
        read: (n) => withEntry(x, 'layers', withEntry(layers, 'names', new Array<GdValue>(n).fill('x'))),
        write: (m, n) => {
          m.layers.names = new Array<string>(n).fill('x');
        },
      },
      {
        path: '/layers/visibility',
        limit: WD_LIMITS.maxListLength,
        read: (n) => withEntry(x, 'layers', withEntry(layers, 'visibility', new Array<GdValue>(n).fill(false))),
        write: (m, n) => {
          m.layers.visibility = new Array<boolean>(n).fill(false);
        },
      },
      {
        path: '/theme/ground_colors',
        limit: WD_LIMITS.maxListLength,
        read: (n) => withEntry(x, 'theme', withEntry(theme, 'ground_colors', Array.from({ length: n }, color))),
        write: (m, n) => {
          m.theme.groundColors = Array.from({ length: n }, () => ({ r: 0, g: 0, b: 0, a: 1 }));
        },
      },
      {
        path: '/windroses',
        limit: WD_LIMITS.maxListLength,
        read: (n) => withEntry(x, 'windroses', new Array<GdValue>(n).fill(null)),
        write: (m, n) => {
          m.windroses = new Array<GdValue>(n).fill(null);
        },
      },
      {
        path: '/boxes',
        limit: WD_LIMITS.maxBoxes,
        read: (n) => withEntry(x, 'boxes', new Array<GdValue>(n).fill(null)),
        write: (m, n) => {
          m.boxes = new Array<GdValue>(n).fill(null);
        },
      },
    ];
    for (const list of lists) {
      expect(() => wdMapFromGd(list.read(list.limit)), `read ${list.path} at the limit`).not.toThrow();
      expectWdError(() => wdMapFromGd(list.read(list.limit + 1)), 'LIMIT', list.path);
      const m = wdMapFromGd(makeSyntheticRoot());
      list.write(m, list.limit);
      expect(() => wdMapToGd(m), `write ${list.path} at the limit`).not.toThrow();
      list.write(m, list.limit + 1);
      expectWdError(() => wdMapToGd(m), 'LIMIT', list.path);
    }
  });

  it('applies a record list limit with a strict greater-than, on read and on write', () => {
    const table = [f('a', readBool, writeBool)];
    const rec = (): GdDict => new GdDict([['a', true]]);
    expect(readRecordList([rec(), rec()], '/p', table, 2)).toHaveLength(2);
    expectWdError(() => readRecordList([rec(), rec(), rec()], '/p', table, 2), 'LIMIT', '/p');
    expect(writeRecordList([{ a: true }, { a: false }], '/p', table, 2)).toHaveLength(2);
    expectWdError(() => writeRecordList([{ a: true }, { a: true }, { a: true }], '/p', table, 2), 'LIMIT', '/p');
  });

  it('rejects a layout that uses an extra index twice', () => {
    const m = wdMapFromGd(makeSyntheticRoot());
    // The length is right (4 known keys + 2 extras) and every known key appears once; only the index repeats.
    m.frame = { ...m.frame, layout: [0, 0, 'enabled', 'texture', 'size', 'tint'], extra: [['a', 1n], ['b', 2n]] };
    expectWdError(() => wdMapToGd(m), 'FORMAT', '/frame');
  });

  it('writes the shared flag of a dictionary, and only for the value true', () => {
    const m = wdMapFromGd(makeSyntheticRoot());
    expect((getKey(wdMapToGd(m), 'frame') as GdDict).shared).toBe(false);
    m.frame = { ...m.frame, shared: true };
    expect((getKey(wdMapToGd(m), 'frame') as GdDict).shared).toBe(true);
    m.shared = true;
    expect(wdMapToGd(m).shared).toBe(true);
    m.frame = { ...m.frame, shared: 1 as unknown as boolean };
    expect((getKey(wdMapToGd(m), 'frame') as GdDict).shared).toBe(false);
  });

  it('the writer holds the version line: only 15 is written', () => {
    const m = wdMapFromGd(makeSyntheticRoot());
    for (const bad of [16, 14, 0, -1, 15.5, NaN]) {
      m.version = bad as 15;
      expectWdError(() => wdMapToGd(m), 'VERSION', '/version');
    }
    m.version = 15n as unknown as 15;
    expectWdError(() => wdMapToGd(m), 'VERSION', '/version');
    m.version = 15;
    expect(getKey(wdMapToGd(m), 'version')).toBe(15n);
  });

  it('a raster one byte too long or too short is a FORMAT error on read and on write', () => {
    const x = makeSyntheticRoot();
    const size = rasterDataValue(x, 'mask').length;
    const longer = new Uint8Array(size + 1);
    const shorter = new Uint8Array(size - 1);
    expectWdError(() => wdMapFromGd(withRasterInner(x, 'mask', 'data', longer)), 'FORMAT', '/mask/data/data');
    expectWdError(() => wdMapFromGd(withRasterInner(x, 'mask', 'data', shorter)), 'FORMAT', '/mask/data/data');
    const m = wdMapFromGd(x);
    m.mask = { ...m.mask, data: longer };
    expectWdError(() => wdMapToGd(m), 'FORMAT', '/mask/data/data');
    m.mask = { ...m.mask, data: shorter };
    expectWdError(() => wdMapToGd(m), 'FORMAT', '/mask/data/data');
  });

  it('rejects an Image prop that is not a name and value pair', () => {
    const x = makeSyntheticRoot();
    const mask = getKey(x, 'mask') as GdObject;
    for (const bad of [[], ['x'], ['x', 1n, 2n]]) {
      const odd = new GdObject(mask.cls, [...mask.props, bad as unknown as [string, GdValue]]);
      expectWdError(() => wdMapFromGd(withEntry(x, 'mask', odd)), 'TYPE', '/mask');
    }
  });

  it('freezes the limits table so that no importer can raise a limit at run time', () => {
    expect(Object.isFrozen(WD_LIMITS)).toBe(true);
  });
});

describe('11. kind discipline residuals (final review follow-up)', () => {
  it('rejects an Int where a bool is declared', () => {
    expectWdError(() => wdMapFromGd(withEntry(makeSyntheticRoot(), 'water_flip_x', 1n)), 'TYPE', '/water_flip_x');
  });
  it('rejects a typed array that is not a Uint8Array where PoolByteArray is declared', () => {
    const x = makeSyntheticRoot();
    const size = rasterDataValue(x, 'mask').length;
    expectWdError(
      () => wdMapFromGd(withRasterInner(x, 'mask', 'data', new Uint16Array(size / 2) as unknown as GdValue)),
      'TYPE', '/mask/data/data',
    );
  });
});
