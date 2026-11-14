import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_LIMITS, ConfigError, checkAbsolutePath, parseConfig } from '../../electron/assets/config.ts';

function nativePath(suffix: string): string {
  return process.platform === 'win32' ? path.win32.join('C:/', suffix) : path.posix.join('/', suffix);
}

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

describe('portable config absolute path validation', () => {
  it('returns normalized native absolute paths unchanged', () => {
    const valid = [
      nativePath(''), nativePath('a'), nativePath('a/b'), nativePath('with spaces/x'),
      nativePath('non-ascii-é-ü-ß'), nativePath('a b/c-d_e.f'),
    ];
    for (const candidate of valid) expect(checkAbsolutePath(candidate, 'k')).toBe(candidate);
    if (process.platform !== 'win32') {
      const exact = '/' + 'a'.repeat(4095);
      expect(checkAbsolutePath(exact, 'k')).toBe(exact);
    }
  });

  it('rejects malformed, ambiguous or non-native paths with typed PATH errors', () => {
    const bad: unknown[] = [
      '', 'relative/x', 'C:relative', '//a', '/a//b', '/a/./b', '/a/../b', '/..',
      '/a/b//', '/a/\0b', '/a/\nb', '/a/\tb', '/a/\x7fb',
      '/' + 'a'.repeat(4096), 123, null,
    ];
    if (process.platform !== 'win32') bad.push('C:' + String.fromCharCode(92) + 'win');
    for (const candidate of bad) {
      expect(() => checkAbsolutePath(candidate as string, 'k'), String(candidate))
        .toThrowError(ConfigError);
      try {
        checkAbsolutePath(candidate as string, 'k');
        expect.unreachable('accepted malformed path');
      } catch (e) {
        expect(e).toMatchObject({ code: 'PATH', key: 'k' });
      }
    }
  });
});

describe('portable config JSON parsing', () => {
  it('returns a frozen plain object and frozen native map roots', () => {
    const expected = {
      wonderdraftInstall: nativePath('a'),
      wonderdraftUserData: nativePath('b'),
      mapRoots: [nativePath('c')],
    };
    const cfg = parseConfig(JSON.stringify(expected));
    expect(cfg).toEqual(expected);
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.getPrototypeOf(cfg)).toBe(Object.prototype);
    expect(Object.isFrozen(cfg.mapRoots)).toBe(true);
  });

  it('parses an empty object without undefined properties', () => {
    const cfg = parseConfig('{}');
    expect(cfg).toEqual({});
    expect('wonderdraftInstall' in cfg).toBe(false);
    expect('wonderdraftUserData' in cfg).toBe(false);
    expect('mapRoots' in cfg).toBe(false);
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it('drops unknown and prototype-polluting properties', () => {
    const cfg = parseConfig('{"x":1,"__proto__":{"x":1},"constructor":2,"mapRoots":[]}') as Record<string, unknown>;
    expect(Object.hasOwn(cfg, '__proto__')).toBe(false);
    expect(Object.hasOwn(cfg, 'x')).toBe(false);
    expect(Object.hasOwn(cfg, 'constructor')).toBe(false);
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
    expect(cfg).toEqual({ mapRoots: [] });
  });

  it('reports exact keys and codes for wrong kinds, malformed paths and shapes', () => {
    const cases: Array<[string, string, string]> = [
      ['{"wonderdraftInstall":7}', 'TYPE', 'wonderdraftInstall'],
      ['{"wonderdraftInstall":null}', 'TYPE', 'wonderdraftInstall'],
      ['{"wonderdraftInstall":["x"]}', 'TYPE', 'wonderdraftInstall'],
      ['{"wonderdraftUserData":{}}', 'TYPE', 'wonderdraftUserData'],
      ['{"wonderdraftInstall":"relative/x"}', 'PATH', 'wonderdraftInstall'],
      ['{"wonderdraftUserData":"/a/../b"}', 'PATH', 'wonderdraftUserData'],
      ['{"mapRoots":"x"}', 'TYPE', 'mapRoots'],
      ['{"mapRoots":7}', 'TYPE', 'mapRoots'],
      ['{"mapRoots":null}', 'TYPE', 'mapRoots'],
      [JSON.stringify({ mapRoots: [nativePath('ok'), 7] }), 'TYPE', 'mapRoots[1]'],
      ['{"mapRoots":["relative"]}', 'PATH', 'mapRoots[0]'],
      [JSON.stringify({ mapRoots: Array(65).fill(nativePath('a')) }), 'SHAPE', 'mapRoots'],
      ['{oops', 'SYNTAX', ''],
      ['[]', 'SHAPE', ''],
      ['null', 'SHAPE', ''],
      ['42', 'SHAPE', ''],
      ['"s"', 'SHAPE', ''],
    ];
    for (const [text, code, key] of cases) {
      try {
        parseConfig(text);
        expect.unreachable('accepted malformed config');
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        expect(e).toMatchObject({ code, key });
      }
    }
  });

  it('enforces a UTF-8 byte limit and accepts an exact-boundary JSON', () => {
    expect(CONFIG_LIMITS.maxBytes).toBe(65_536);
    expect(() => parseConfig('x'.repeat(65_537))).toThrowError(ConfigError);
    try {
      parseConfig('x'.repeat(65_537));
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ code: 'TOO_LARGE' });
    }
    const pad = 'p'.repeat(65_536 - Buffer.byteLength('{"pad":""}'));
    const exact = JSON.stringify({ pad });
    expect(Buffer.byteLength(exact, 'utf8')).toBe(65_536);
    expect(parseConfig(exact)).toEqual({});
  });

  it('rejects non-string source input as SYNTAX', () => {
    expect(() => parseConfig(123 as unknown as string)).toThrowError(ConfigError);
    try {
      parseConfig(123 as unknown as string);
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ code: 'SYNTAX' });
    }
  });

  it('seeded 1,000-mutation fuzz never escapes the typed config error boundary', () => {
    const rand = mulberry32(0xc0ffee);
    const alphabet = 'abZ019 /\\.":{}[],_-~é&()\0\n\t\x7f"{}\\';
    const valid = JSON.stringify({
      wonderdraftInstall: nativePath('opt/Wonderdraft'),
      wonderdraftUserData: nativePath('home/u/wd'),
      mapRoots: [nativePath('m1'), nativePath('m2')],
    });
    const codes = ['TOO_LARGE', 'SYNTAX', 'SHAPE', 'TYPE', 'PATH', 'IO'];
    for (let n = 0; n < 1000; n++) {
      let mutated = valid;
      const edits = 1 + Math.floor(rand() * 3);
      for (let k = 0; k < edits; k++) {
        const pos = Math.floor(rand() * (mutated.length + 1));
        const op = rand();
        const ch = alphabet[Math.floor(rand() * alphabet.length)] as string;
        if (op < 0.4) mutated = mutated.slice(0, pos) + ch + mutated.slice(pos);
        else if (op < 0.7 && mutated.length > 0) mutated = mutated.slice(0, pos) + mutated.slice(pos + 1);
        else if (mutated.length > 0) mutated = mutated.slice(0, pos) + ch + mutated.slice(pos + 1);
      }
      try {
        parseConfig(mutated);
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        expect(codes).toContain((e as ConfigError).code);
        expect(typeof (e as ConfigError).key).toBe('string');
      }
    }
  });
});
