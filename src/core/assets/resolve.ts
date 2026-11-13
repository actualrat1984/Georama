/** Pure reference resolver: untrusted texture strings from map files become
 * validated asset references or typed errors. No file access, no existence
 * check. Every string passes R1 (size), R2 (characters) and then the
 * kind-specific prefix rules R3-R5 with the segment gate R6; the file
 * extension is always appended by the resolver (R7), never chosen by the
 * text. Names are opaque otherwise: spaces, `&`, parentheses and non-ASCII
 * letters pass through unchanged; nothing is decoded, normalised or
 * case-folded.
 */
export type RefKind = 'symbol' | 'path-style' | 'border-style' | 'water-texture' | 'ground-texture' | 'frame-texture';

export type RefErrorCode = 'EMPTY' | 'TOO_LONG' | 'SCHEME' | 'CHARACTER' | 'SEGMENT' | 'NAME';

export class RefError extends Error {
  readonly code: RefErrorCode;
  readonly kind: RefKind;
  constructor(code: RefErrorCode, kind: RefKind, message: string) {
    super(message);
    this.name = 'RefError';
    this.code = code;
    this.kind = kind;
  }
}

export type AssetRef =
  | Readonly<{ source: 'pck'; path: string }>
  | Readonly<{ source: 'user'; pack: string; relPath: string }>;

export const REF_LIMITS: Readonly<{ maxChars: number; maxSegmentBytes: number; maxSegments: number }> =
  Object.freeze({ maxChars: 512, maxSegmentBytes: 255, maxSegments: 16 });

const encoder = new TextEncoder();

const PCK_IMAGE_SUFFIX = '.wonderdraft_image';
const USER_IMAGE_SUFFIX = '.png';
const SYMBOL_META_NAME = '.wonderdraft_symbols';
const RES_PREFIX = 'res://';
const USER_PREFIX = 'user://assets/';
const PATHS_PREFIX = 'res://textures/paths/';
const BORDERS_PREFIX = 'res://textures/borders/';
const WATER_DIR = 'res://textures/water/';
const GROUND_DIR = 'res://textures/ground/';
const FRAMES_DIR = 'res://textures/frames/';

/** R2: true when every code point of the string is allowed. */
function hasOnlyAllowedChars(text: string): boolean {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 < n) {
        const d = text.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          i += 2;
          continue;
        }
      }
      return false;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return false;
    if (c < 0x20) return false;
    if (c >= 0x7f && c <= 0x9f) return false;
    if (c === 0x5c) return false;
    if (c === 0x2028 || c === 0x2029) return false;
    if (c >= 0x202a && c <= 0x202e) return false;
    if (c >= 0x2066 && c <= 0x2069) return false;
    if (c === 0xfeff || c === 0xfffe || c === 0xffff) return false;
    i += 1;
  }
  return true;
}

/** R6: the remainder split on `/` holds at most maxSegments segments and every
 * segment is non-empty, is not `.` or `..`, does not start with `.` and fits
 * in maxSegmentBytes UTF-8 bytes.
 */
function checkSegments(segments: readonly string[], kind: RefKind): void {
  if (segments.length > REF_LIMITS.maxSegments) throw new RefError('SEGMENT', kind, 'too many segments');
  for (const seg of segments) {
    if (seg.length === 0) throw new RefError('SEGMENT', kind, 'empty segment');
    if (seg === '.' || seg === '..') throw new RefError('SEGMENT', kind, 'dot segment');
    if (seg.charCodeAt(0) === 0x2e) throw new RefError('SEGMENT', kind, 'leading-dot segment');
    if (encoder.encode(seg).length > REF_LIMITS.maxSegmentBytes) {
      throw new RefError('SEGMENT', kind, 'segment exceeds maxSegmentBytes');
    }
  }
}

/** R3: symbol textures from `res://sprites|packs/...` (PCK) or
 * `user://assets/<pack>/...` (user packs). Anything else is SCHEME.
 */
function resolveSymbol(text: string): AssetRef {
  const kind: RefKind = 'symbol';
  if (text.startsWith(RES_PREFIX)) {
    const rest = text.slice(RES_PREFIX.length);
    if (rest.length === 0) throw new RefError('SEGMENT', kind, 'nothing after res://');
    const segments = rest.split('/');
    const first = segments[0] as string;
    if (first !== 'sprites' && first !== 'packs') throw new RefError('NAME', kind, 'res:// root is not sprites or packs');
    if (segments.length < 2) throw new RefError('SEGMENT', kind, 'res:// reference names no image');
    checkSegments(segments, kind);
    return { source: 'pck', path: RES_PREFIX + rest + PCK_IMAGE_SUFFIX };
  }
  if (text.startsWith(USER_PREFIX)) {
    const after = text.slice(USER_PREFIX.length);
    if (after.length === 0) throw new RefError('SEGMENT', kind, 'nothing after user://assets/');
    const segments = after.split('/');
    if (segments.length < 2) throw new RefError('SEGMENT', kind, 'user pack names no file');
    checkSegments(segments, kind);
    const pack = segments[0] as string;
    const rel = segments.slice(1).join('/');
    return { source: 'user', pack, relPath: rel + USER_IMAGE_SUFFIX };
  }
  throw new RefError('SCHEME', kind, 'symbol reference must start with res:// or user://assets/');
}

/** R4: styles accept exactly one name below a fixed `res://textures/...` prefix. */
function resolveStyle(kind: RefKind, text: string, prefix: string): AssetRef {
  if (!text.startsWith(prefix)) throw new RefError('SCHEME', kind, `style reference must start with ${prefix}`);
  const name = text.slice(prefix.length);
  if (name.length === 0 || name.includes('/')) throw new RefError('SEGMENT', kind, 'style reference names no single image');
  checkSegments([name], kind);
  return { source: 'pck', path: prefix + name + PCK_IMAGE_SUFFIX };
}

/** R5: theme/frame textures are bare names (no `/`) below a fixed directory. */
function resolveBare(kind: RefKind, text: string, dir: string): AssetRef {
  if (text.includes('/')) throw new RefError('NAME', kind, 'bare texture name must not contain /');
  checkSegments([text], kind);
  return { source: 'pck', path: dir + text + PCK_IMAGE_SUFFIX };
}

export function resolveRef(kind: RefKind, text: string): AssetRef {
  if (typeof text !== 'string') throw new RefError('NAME', kind, 'reference is not a string');
  if (text.length === 0) throw new RefError('EMPTY', kind, 'reference is empty');
  if (text.length > REF_LIMITS.maxChars) throw new RefError('TOO_LONG', kind, 'reference exceeds maxChars');
  if (!hasOnlyAllowedChars(text)) throw new RefError('CHARACTER', kind, 'reference holds a disallowed character');
  switch (kind) {
    case 'symbol':
      return resolveSymbol(text);
    case 'path-style':
      return resolveStyle(kind, text, PATHS_PREFIX);
    case 'border-style':
      return resolveStyle(kind, text, BORDERS_PREFIX);
    case 'water-texture':
      return resolveBare(kind, text, WATER_DIR);
    case 'ground-texture':
      return resolveBare(kind, text, GROUND_DIR);
    case 'frame-texture':
      return resolveBare(kind, text, FRAMES_DIR);
    default:
      throw new RefError('NAME', kind, 'unknown reference kind');
  }
}

/** A stable cache and de-duplication key for a resolved reference. */
export function assetKey(ref: AssetRef): string {
  if (ref.source === 'pck') return 'pck:' + ref.path;
  return 'user:' + ref.pack + '/' + ref.relPath;
}

/** The `.wonderdraft_symbols` file of the image's folder (same source, same folder). */
export function symbolSetRef(image: AssetRef): AssetRef {
  if (image.source === 'pck') {
    const cut = image.path.lastIndexOf('/');
    return { source: 'pck', path: image.path.slice(0, cut + 1) + SYMBOL_META_NAME };
  }
  const cut = image.relPath.lastIndexOf('/');
  return { source: 'user', pack: image.pack, relPath: image.relPath.slice(0, cut + 1) + SYMBOL_META_NAME };
}

/** The image name without the appended extension, e.g. `sample item 1`. */
export function imageBaseName(image: AssetRef): string {
  if (image.source === 'pck') {
    const last = image.path.slice(image.path.lastIndexOf('/') + 1);
    return last.slice(0, last.length - PCK_IMAGE_SUFFIX.length);
  }
  const last = image.relPath.slice(image.relPath.lastIndexOf('/') + 1);
  return last.slice(0, last.length - USER_IMAGE_SUFFIX.length);
}
