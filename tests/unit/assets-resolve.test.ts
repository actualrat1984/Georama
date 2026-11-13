import { describe, expect, it } from 'vitest';
import type { AssetRef, RefErrorCode, RefKind } from '../../src/core/assets/resolve.ts';
import { REF_LIMITS, RefError, assetKey, imageBaseName, resolveRef, symbolSetRef } from '../../src/core/assets/resolve.ts';

function errOf(kind: RefKind, text: unknown): RefError {
  let caught: unknown;
  try {
    resolveRef(kind, text as string);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(RefError);
  const e = caught as RefError;
  expect(e.name).toBe('RefError');
  expect(e.kind).toBe(kind);
  return e;
}

describe('REF_LIMITS', () => {
  it('is frozen at 512/255/16', () => {
    expect(REF_LIMITS.maxChars).toBe(512);
    expect(REF_LIMITS.maxSegmentBytes).toBe(255);
    expect(REF_LIMITS.maxSegments).toBe(16);
    expect(Object.isFrozen(REF_LIMITS)).toBe(true);
  });
});

interface ValidCase {
  kind: RefKind;
  text: string;
  ref: AssetRef;
  key: string;
  setRef: AssetRef;
  base: string;
}

const seg255 = 'x'.repeat(255);
const seg255Bytes2 = 'é'.repeat(127) + 'a'; // 127*2+1 = 255 UTF-8 bytes
const segs16 = ['sprites', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o'].join('/');

const validCases: ValidCase[] = [
  {
    kind: 'symbol',
    text: 'res://sprites/trees/test_set/tree_01',
    ref: { source: 'pck', path: 'res://sprites/trees/test_set/tree_01.wonderdraft_image' },
    key: 'pck:res://sprites/trees/test_set/tree_01.wonderdraft_image',
    setRef: { source: 'pck', path: 'res://sprites/trees/test_set/.wonderdraft_symbols' },
    base: 'tree_01',
  },
  {
    kind: 'symbol',
    text: 'res://packs/Sample Pack/sprites/symbols/sample_set/sample item 1',
    ref: { source: 'pck', path: 'res://packs/Sample Pack/sprites/symbols/sample_set/sample item 1.wonderdraft_image' },
    key: 'pck:res://packs/Sample Pack/sprites/symbols/sample_set/sample item 1.wonderdraft_image',
    setRef: { source: 'pck', path: 'res://packs/Sample Pack/sprites/symbols/sample_set/.wonderdraft_symbols' },
    base: 'sample item 1',
  },
  {
    kind: 'symbol',
    text: 'user://assets/Sample Pack/sprites/trees/Pine-A/Pine-A-07',
    ref: { source: 'user', pack: 'Sample Pack', relPath: 'sprites/trees/Pine-A/Pine-A-07.png' },
    key: 'user:Sample Pack/sprites/trees/Pine-A/Pine-A-07.png',
    setRef: { source: 'user', pack: 'Sample Pack', relPath: 'sprites/trees/Pine-A/.wonderdraft_symbols' },
    base: 'Pine-A-07',
  },
  {
    kind: 'symbol',
    text: 'res://sprites/symbols/test_set/Ink & Wash (Draft)',
    ref: { source: 'pck', path: 'res://sprites/symbols/test_set/Ink & Wash (Draft).wonderdraft_image' },
    key: 'pck:res://sprites/symbols/test_set/Ink & Wash (Draft).wonderdraft_image',
    setRef: { source: 'pck', path: 'res://sprites/symbols/test_set/.wonderdraft_symbols' },
    base: 'Ink & Wash (Draft)',
  },
  {
    kind: 'symbol',
    text: 'res://sprites/trees/forêt_test/arbre_01',
    ref: { source: 'pck', path: 'res://sprites/trees/forêt_test/arbre_01.wonderdraft_image' },
    key: 'pck:res://sprites/trees/forêt_test/arbre_01.wonderdraft_image',
    setRef: { source: 'pck', path: 'res://sprites/trees/forêt_test/.wonderdraft_symbols' },
    base: 'arbre_01',
  },
  {
    kind: 'symbol',
    text: `res://sprites/trees/${seg255}/leaf_9`,
    ref: { source: 'pck', path: `res://sprites/trees/${seg255}/leaf_9.wonderdraft_image` },
    key: `pck:res://sprites/trees/${seg255}/leaf_9.wonderdraft_image`,
    setRef: { source: 'pck', path: `res://sprites/trees/${seg255}/.wonderdraft_symbols` },
    base: 'leaf_9',
  },
  {
    kind: 'symbol',
    text: `res://sprites/trees/${seg255Bytes2}/leaf_9`,
    ref: { source: 'pck', path: `res://sprites/trees/${seg255Bytes2}/leaf_9.wonderdraft_image` },
    key: `pck:res://sprites/trees/${seg255Bytes2}/leaf_9.wonderdraft_image`,
    setRef: { source: 'pck', path: `res://sprites/trees/${seg255Bytes2}/.wonderdraft_symbols` },
    base: 'leaf_9',
  },
  {
    kind: 'symbol',
    text: `res://${segs16}`,
    ref: { source: 'pck', path: `res://${segs16}.wonderdraft_image` },
    key: `pck:res://${segs16}.wonderdraft_image`,
    setRef: { source: 'pck', path: 'res://sprites/a/b/c/d/e/f/g/h/i/j/k/l/m/n/.wonderdraft_symbols' },
    base: 'o',
  },
  {
    kind: 'symbol',
    text: 'res://sprites/trees/a/%2e%2e',
    ref: { source: 'pck', path: 'res://sprites/trees/a/%2e%2e.wonderdraft_image' },
    key: 'pck:res://sprites/trees/a/%2e%2e.wonderdraft_image',
    setRef: { source: 'pck', path: 'res://sprites/trees/a/.wonderdraft_symbols' },
    base: '%2e%2e',
  },
  {
    kind: 'symbol',
    text: 'user://assets/Test Pack/sprites/a/b.png',
    ref: { source: 'user', pack: 'Test Pack', relPath: 'sprites/a/b.png.png' },
    key: 'user:Test Pack/sprites/a/b.png.png',
    setRef: { source: 'user', pack: 'Test Pack', relPath: 'sprites/a/.wonderdraft_symbols' },
    base: 'b.png',
  },
  {
    kind: 'symbol',
    text: 'res://sprites/a/b',
    ref: { source: 'pck', path: 'res://sprites/a/b.wonderdraft_image' },
    key: 'pck:res://sprites/a/b.wonderdraft_image',
    setRef: { source: 'pck', path: 'res://sprites/a/.wonderdraft_symbols' },
    base: 'b',
  },
  {
    kind: 'path-style',
    text: 'res://textures/paths/test_dashed_line',
    ref: { source: 'pck', path: 'res://textures/paths/test_dashed_line.wonderdraft_image' },
    key: 'pck:res://textures/paths/test_dashed_line.wonderdraft_image',
    setRef: { source: 'pck', path: 'res://textures/paths/.wonderdraft_symbols' },
    base: 'test_dashed_line',
  },
  {
    kind: 'border-style',
    text: 'res://textures/borders/test_soft_edge',
    ref: { source: 'pck', path: 'res://textures/borders/test_soft_edge.wonderdraft_image' },
    key: 'pck:res://textures/borders/test_soft_edge.wonderdraft_image',
    setRef: { source: 'pck', path: 'res://textures/borders/.wonderdraft_symbols' },
    base: 'test_soft_edge',
  },
  {
    kind: 'water-texture',
    text: 'Ink & Wash',
    ref: { source: 'pck', path: 'res://textures/water/Ink & Wash.wonderdraft_image' },
    key: 'pck:res://textures/water/Ink & Wash.wonderdraft_image',
    setRef: { source: 'pck', path: 'res://textures/water/.wonderdraft_symbols' },
    base: 'Ink & Wash',
  },
  {
    kind: 'ground-texture',
    text: 'Parchment Test',
    ref: { source: 'pck', path: 'res://textures/ground/Parchment Test.wonderdraft_image' },
    key: 'pck:res://textures/ground/Parchment Test.wonderdraft_image',
    setRef: { source: 'pck', path: 'res://textures/ground/.wonderdraft_symbols' },
    base: 'Parchment Test',
  },
  {
    kind: 'frame-texture',
    text: 'ring_dotted_test',
    ref: { source: 'pck', path: 'res://textures/frames/ring_dotted_test.wonderdraft_image' },
    key: 'pck:res://textures/frames/ring_dotted_test.wonderdraft_image',
    setRef: { source: 'pck', path: 'res://textures/frames/.wonderdraft_symbols' },
    base: 'ring_dotted_test',
  },
];

describe('resolveRef valid inputs', () => {
  it('covers all six kinds', () => {
    const kinds = new Set(validCases.map((c) => c.kind));
    expect([...kinds].sort()).toEqual(
      ['border-style', 'frame-texture', 'ground-texture', 'path-style', 'symbol', 'water-texture'].sort(),
    );
  });
  it.each(validCases)('$kind $text resolves exactly', (c) => {
    expect(resolveRef(c.kind, c.text)).toEqual(c.ref);
    expect(assetKey(c.ref)).toBe(c.key);
    expect(symbolSetRef(c.ref)).toEqual(c.setRef);
    expect(imageBaseName(c.ref)).toBe(c.base);
  });
  it('accepts exactly maxChars UTF-16 units', () => {
    const text = `res://sprites/${'a'.repeat(200)}/${'b'.repeat(200)}/${'c'.repeat(96)}`;
    expect(text.length).toBe(512);
    const ref = resolveRef('symbol', text);
    expect(ref.source).toBe('pck');
  });
  it('extension is always appended, never chosen by the text', () => {
    expect(resolveRef('symbol', 'user://assets/Pack/sprites/x/y.wonderdraft_image')).toEqual({
      source: 'user',
      pack: 'Pack',
      relPath: 'sprites/x/y.wonderdraft_image.png',
    });
  });
});

interface HostileCase {
  kind: RefKind;
  text: unknown;
  code: RefErrorCode;
}

const seg256 = 'y'.repeat(256);
const segs17 = ['sprites', ...Array<string>(16).fill('s')].join('/');

const hostileCases: HostileCase[] = [
  { kind: 'symbol', text: '', code: 'EMPTY' },
  { kind: 'frame-texture', text: '', code: 'EMPTY' },
  { kind: 'symbol', text: 'x'.repeat(513), code: 'TOO_LONG' },
  { kind: 'water-texture', text: 'w'.repeat(513), code: 'TOO_LONG' },
  { kind: 'symbol', text: 'http://example.com/x', code: 'SCHEME' },
  { kind: 'symbol', text: 'file:///etc/passwd', code: 'SCHEME' },
  { kind: 'symbol', text: '/etc/passwd', code: 'SCHEME' },
  { kind: 'symbol', text: 'C:\\x', code: 'CHARACTER' },
  { kind: 'symbol', text: '\\\\host\\share', code: 'CHARACTER' },
  { kind: 'symbol', text: 'assets/p/x', code: 'SCHEME' },
  { kind: 'symbol', text: 'user://other/p/x', code: 'SCHEME' },
  { kind: 'symbol', text: 'USER://assets/p/x', code: 'SCHEME' },
  { kind: 'symbol', text: 'user://assets/', code: 'SEGMENT' },
  { kind: 'symbol', text: 'user://assets/packname', code: 'SEGMENT' },
  { kind: 'symbol', text: 'user://assets/p/', code: 'SEGMENT' },
  { kind: 'symbol', text: 'res://', code: 'SEGMENT' },
  { kind: 'symbol', text: 'res://sprites', code: 'SEGMENT' },
  { kind: 'symbol', text: 'res://packs', code: 'SEGMENT' },
  { kind: 'symbol', text: 'res://packs/', code: 'SEGMENT' },
  { kind: 'symbol', text: 'res://sprites/', code: 'SEGMENT' },
  { kind: 'symbol', text: 'res://sprites/a/../b', code: 'SEGMENT' },
  { kind: 'symbol', text: 'res://sprites/./a', code: 'SEGMENT' },
  { kind: 'symbol', text: 'res://sprites//a', code: 'SEGMENT' },
  { kind: 'symbol', text: 'res://sprites/a/', code: 'SEGMENT' },
  { kind: 'symbol', text: 'res://sprites/.', code: 'SEGMENT' },
  { kind: 'symbol', text: 'res://sprites/..', code: 'SEGMENT' },
  { kind: 'symbol', text: 'res://sprites/.hidden', code: 'SEGMENT' },
  { kind: 'symbol', text: 'res://scripts/ui/dialog', code: 'NAME' },
  { kind: 'symbol', text: 'res://icons/x', code: 'NAME' },
  { kind: 'symbol', text: 'res://textures/paths/x', code: 'NAME' },
  { kind: 'symbol', text: 'user://assets/../../etc/passwd', code: 'SEGMENT' },
  { kind: 'symbol', text: 'user://assets/p/../../x', code: 'SEGMENT' },
  { kind: 'symbol', text: 'user://assets/p/.hidden/x', code: 'SEGMENT' },
  { kind: 'symbol', text: 'user://assets/.p/x', code: 'SEGMENT' },
  { kind: 'symbol', text: 'user://assets/p/./x', code: 'SEGMENT' },
  { kind: 'symbol', text: 'user://assets/p//x', code: 'SEGMENT' },
  { kind: 'symbol', text: 'res://sprites/a/b\0c', code: 'CHARACTER' },
  { kind: 'symbol', text: 'line1\nline2', code: 'CHARACTER' },
  { kind: 'symbol', text: 'a\tb', code: 'CHARACTER' },
  { kind: 'symbol', text: 'a\rb', code: 'CHARACTER' },
  { kind: 'symbol', text: 'a\x01b', code: 'CHARACTER' },
  { kind: 'symbol', text: 'a\x7fb', code: 'CHARACTER' },
  { kind: 'symbol', text: 'a\x80b', code: 'CHARACTER' },
  { kind: 'symbol', text: 'a\\b', code: 'CHARACTER' },
  { kind: 'symbol', text: 'a\u2028b', code: 'CHARACTER' },
  { kind: 'symbol', text: 'a\u2029b', code: 'CHARACTER' },
  { kind: 'symbol', text: 'a\u202ab', code: 'CHARACTER' },
  { kind: 'symbol', text: 'a\u202eb', code: 'CHARACTER' },
  { kind: 'symbol', text: 'a\u2066b', code: 'CHARACTER' },
  { kind: 'symbol', text: 'a\u2069b', code: 'CHARACTER' },
  { kind: 'symbol', text: '\ufeffres://sprites/a/b', code: 'CHARACTER' },
  { kind: 'symbol', text: 'a\ufffeb', code: 'CHARACTER' },
  { kind: 'symbol', text: 'a\uffffb', code: 'CHARACTER' },
  { kind: 'symbol', text: 'a\ud800b', code: 'CHARACTER' },
  { kind: 'symbol', text: 'a\udc00b', code: 'CHARACTER' },
  { kind: 'symbol', text: `res://sprites/trees/${seg256}`, code: 'SEGMENT' },
  { kind: 'symbol', text: `res://${segs17}`, code: 'SEGMENT' },
  { kind: 'path-style', text: 'res://sprites/trees/a/b', code: 'SCHEME' },
  { kind: 'path-style', text: 'res://textures/paths/a/b', code: 'SEGMENT' },
  { kind: 'path-style', text: 'res://textures/paths/', code: 'SEGMENT' },
  { kind: 'path-style', text: 'res://textures/borders/x', code: 'SCHEME' },
  { kind: 'path-style', text: 'res://Textures/paths/x', code: 'SCHEME' },
  { kind: 'path-style', text: 'res://textures/paths', code: 'SCHEME' },
  { kind: 'border-style', text: 'res://textures/borders/a/b', code: 'SEGMENT' },
  { kind: 'border-style', text: 'res://textures/paths/x', code: 'SCHEME' },
  { kind: 'border-style', text: 'test_soft_edge', code: 'SCHEME' },
  { kind: 'water-texture', text: 'a/b', code: 'NAME' },
  { kind: 'ground-texture', text: 'res://textures/ground/X', code: 'NAME' },
  { kind: 'frame-texture', text: 'a\\b', code: 'CHARACTER' },
  { kind: 'water-texture', text: '.hidden', code: 'SEGMENT' },
  { kind: 'water-texture', text: '..', code: 'SEGMENT' },
  { kind: 'symbol', text: null, code: 'NAME' },
  { kind: 'symbol', text: undefined, code: 'NAME' },
  { kind: 'symbol', text: 42, code: 'NAME' },
  { kind: 'symbol', text: {}, code: 'NAME' },
  { kind: 'symbol', text: ['a'], code: 'NAME' },
  { kind: 'path-style', text: null, code: 'NAME' },
];

describe('resolveRef hostile inputs', () => {
  it('has at least 60 cases', () => {
    expect(hostileCases.length).toBeGreaterThanOrEqual(60);
  });
  it.each(hostileCases)('$kind $code for %p', (c) => {
    expect(errOf(c.kind, c.text).code).toBe(c.code);
  });
  it('throws nothing but RefError', () => {
    for (const c of hostileCases) {
      let caught: unknown = null;
      try {
        resolveRef(c.kind, c.text as string);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(RefError);
    }
  });
  it('reports dot segments distinctly (pins the R6 dot rule)', () => {
    expect(errOf('symbol', 'res://sprites/a/../b').message).toBe('dot segment');
    expect(errOf('symbol', 'res://sprites/./a').message).toBe('dot segment');
    expect(errOf('symbol', 'user://assets/p/../../x').message).toBe('dot segment');
  });
});

/** Small seeded PRNG so the property test is deterministic. */
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

const kinds: RefKind[] = ['symbol', 'path-style', 'border-style', 'water-texture', 'ground-texture', 'frame-texture'];

function isCleanChar(code: number): boolean {
  if (code < 0x20) return false;
  if (code >= 0x7f && code <= 0x9f) return false;
  return true;
}

describe('resolveRef property test', () => {
  it('20,000 adversarial strings per kind: only RefError escapes, refs are well-formed', () => {
    const pieces = [
      '.', '/', '\\', '%', ':', 'a', ' ', '\0', 'é', '․', '．',
      'res://', 'user://assets/', 'sprites', 'packs', '..', 'textures/paths/',
      'textures/borders/', 'user://other/', '&', '(x)', '\u2028', '\ufeff',
    ];
    let valid = 0;
    let errors = 0;
    for (const kind of kinds) {
      const rand = mulberry32(0x0b6e5);
      for (let n = 0; n < 20000; n++) {
        const count = Math.floor(rand() * 8);
        let s = '';
        for (let i = 0; i < count; i++) s += pieces[Math.floor(rand() * pieces.length)];
        let ref: AssetRef | null = null;
        try {
          ref = resolveRef(kind, s);
          valid++;
        } catch (e) {
          expect(e).toBeInstanceOf(RefError);
          expect((e as RefError).kind).toBe(kind);
          errors++;
          continue;
        }
        if (ref.source === 'pck') {
          expect(ref.path.startsWith('res://')).toBe(true);
          expect(ref.path.endsWith('.wonderdraft_image')).toBe(true);
          const inner = ref.path.slice(6, ref.path.length - '.wonderdraft_image'.length);
          for (const seg of inner.split('/')) {
            expect(seg.length).toBeGreaterThan(0);
            expect(seg === '.' || seg === '..').toBe(false);
            expect(seg.startsWith('.')).toBe(false);
          }
          for (let i = 0; i < ref.path.length; i++) {
            const code = ref.path.charCodeAt(i);
            expect(ref.path[i]).not.toBe('\\');
            expect(isCleanChar(code)).toBe(true);
          }
        } else {
          expect(ref.pack.length).toBeGreaterThan(0);
          expect(ref.pack.includes('/')).toBe(false);
          expect(ref.relPath.endsWith('.png')).toBe(true);
          for (const seg of [...ref.pack.split('/'), ...ref.relPath.slice(0, ref.relPath.length - 4).split('/')]) {
            expect(seg.length).toBeGreaterThan(0);
            expect(seg === '.' || seg === '..').toBe(false);
            expect(seg.startsWith('.')).toBe(false);
          }
          for (const whole of [ref.pack, ref.relPath]) {
            for (let i = 0; i < whole.length; i++) {
              expect(whole[i]).not.toBe('\\');
              expect(isCleanChar(whole[i].charCodeAt(0))).toBe(true);
            }
          }
        }
      }
    }
    expect(valid).toBeGreaterThan(0);
    expect(errors).toBeGreaterThan(0);
  }, 120000);
});
