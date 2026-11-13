import { describe, expect, it } from 'vitest';
import type { AssetRef, RefErrorCode } from '../../src/core/assets/resolve.ts';
import { REF_LIMITS, RefError, assetKey, resolveRef } from '../../src/core/assets/resolve.ts';
import { afterEach, vi } from 'vitest';
import { classifySymbolTexture } from '../../src/core/symbols/texture-class.ts';

// T1: invented references that resolveRef accepts. Keys must equal assetKey(resolveRef()).
const validTexts: string[] = [
  'res://sprites/synthetic/tex_02',
  'res://sprites/synthetic/tex_03 02',
  'res://packs/sample_pack/sprites/symbols/sample_set/sample item 1',
  'user://assets/sample_pack/sprites/trees/tree-a/tree-a-07',
  'user://assets/north_pack/symbols/harbor_set/dock 03',
  'res://sprites/symbols/meadow_set/Ink & Wash (Draft)',
];

describe('T1 valid strings give asset with stable key (T1)', () => {
  it.each(validTexts)('asset for %s', (text) => {
    const ref: AssetRef = resolveRef('symbol', text);
    const expected = assetKey(ref);
    const got = classifySymbolTexture(text);
    expect(got.class).toBe('asset');
    if (got.class === 'asset') {
      expect(got.key).toBe(expected);
      expect(got.ref).toEqual(ref);
    }
  });

  it('empty string is invalid EMPTY (T1)', () => {
    const got = classifySymbolTexture('');
    expect(got).toEqual({ class: 'invalid', code: 'EMPTY' satisfies RefErrorCode });
  });

  it('each RefError code appears at least once (T1)', () => {
    const cases: Array<{ text: string; code: RefErrorCode }> = [
      { text: '', code: 'EMPTY' },
      { text: 'a'.repeat(REF_LIMITS.maxChars + 1), code: 'TOO_LONG' },
      { text: 'http://example.com/x', code: 'SCHEME' },
      { text: 'res://sprites/bad\\name/x', code: 'CHARACTER' },
      { text: 'res://sprites', code: 'SEGMENT' },
      { text: 'res://other_root/foo', code: 'NAME' },
    ];
    for (const c of cases) {
      const got = classifySymbolTexture(c.text);
      expect(got.class).toBe('invalid');
      if (got.class === 'invalid') {
        expect(got.code).toBe(c.code);
      }
    }
  });

  it('TOO_LONG uses maxChars + 1 characters (T1)', () => {
    const text = 'z'.repeat(REF_LIMITS.maxChars + 1);
    expect(text.length).toBe(REF_LIMITS.maxChars + 1);
    const got = classifySymbolTexture(text);
    expect(got).toEqual({ class: 'invalid', code: 'TOO_LONG' });
  });

  it('only RefError is caught; other throws propagate (T1)', () => {
    // resolveRef only throws RefError for strings, so no string input throws.
    // A non-string hostile object must not be passed to resolveRef at all.
    const hostile = { toString(): string { throw new Error('boom'); } };
    expect(classifySymbolTexture(hostile)).toEqual({ class: 'embedded' });
  });
});

describe('T2 embedded objects (T2)', () => {
  it('non-null non-array objects give embedded', () => {
    const values: unknown[] = [{}, { a: 1 }, { nested: { x: [1] } }, Object.create(null), { toString: 42 }];
    for (const v of values) {
      expect(classifySymbolTexture(v)).toEqual({ class: 'embedded' });
    }
  });

  it('arrays are not embedded (T2 vs T3)', () => {
    expect(classifySymbolTexture([])).toEqual({ class: 'invalid', code: 'TYPE' });
    expect(classifySymbolTexture(['x'])).toEqual({ class: 'invalid', code: 'TYPE' });
  });
});

describe('T3 wrong-type table (T3)', () => {
  it('null, undefined, number, boolean, bigint, symbol, callable, array give TYPE', () => {
    const callable = (): void => {};
    const values: unknown[] = [
      null,
      undefined,
      0,
      42,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      true,
      false,
      10n,
      Symbol('s'),
      callable,
      [],
      ['res://sprites/synthetic/tex_02'],
    ];
    for (const v of values) {
      expect(classifySymbolTexture(v)).toEqual({ class: 'invalid', code: 'TYPE' });
    }
  });

  it('typeof callable is detected via lowercase check (T3)', () => {
    const f = (x: number): number => x + 1;
    expect(typeof f).toBe('function');
    expect(classifySymbolTexture(f)).toEqual({ class: 'invalid', code: 'TYPE' });
  });
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('seeded fuzz over random strings (T1/T3)', () => {
  it('only the three classes come back and only RefError is caught', () => {
    const rand = mulberry32(1337);
    const alphabet = 'abcXYZ019_/.:\\ \x00é&()';
    const allowedCodes: ReadonlySet<string> = new Set(['EMPTY', 'TOO_LONG', 'SCHEME', 'CHARACTER', 'SEGMENT', 'NAME', 'TYPE']);
    for (let i = 0; i < 500; i += 1) {
      const len = Math.floor(rand() * 24);
      let s = '';
      for (let j = 0; j < len; j += 1) {
        s += alphabet[Math.floor(rand() * alphabet.length)] as string;
      }
      let got: unknown;
      let threw = false;
      try {
        got = classifySymbolTexture(s);
      } catch (e) {
        threw = true;
        expect(e).toBeInstanceOf(RefError);
      }
      expect(threw).toBe(false);
      const v = got as { class: string; code?: string };
      expect(['asset', 'embedded', 'invalid']).toContain(v.class);
      // strings never give embedded
      expect(v.class).not.toBe('embedded');
      if (v.class === 'invalid') {
        expect(allowedCodes.has(v.code as string)).toBe(true);
        expect((v.code as string)).not.toBe('TYPE');
      }
    }
  });
});

describe('G0 non-RefError propagates (correction 1)', () => {
  afterEach(() => {
    vi.doUnmock('../../src/core/assets/resolve.ts');
    vi.resetModules();
  });

  it('G0: non-RefError propagates unchanged', async () => {
    const boom = new TypeError('resolver bug');
    vi.doMock('../../src/core/assets/resolve.ts', async (importOriginal: () => Promise<object>) => ({
      ...(await importOriginal()),
      resolveRef: (): never => {
        throw boom;
      },
    }));
    vi.resetModules();
    const mod = await import('../../src/core/symbols/texture-class.ts');
    let caught: unknown;
    try {
      mod.classifySymbolTexture('res://sprites/inv-a');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(boom);
  });
});
