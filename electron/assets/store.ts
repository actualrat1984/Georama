import { isNativeAbsolutePath } from '../native-path.ts';
import { openPckFile } from './pck-file.ts';
import type { PckFile } from './pck-file.ts';
import { readAssetFile } from './open.ts';
import { assetKey, resolveRef, symbolSetRef } from '../../src/core/assets/resolve.ts';
import type { AssetRef, RefKind } from '../../src/core/assets/resolve.ts';
import { resolveThemeRef } from '../../src/core/assets/theme-ref.ts';
import type { ThemeRef } from '../../src/core/assets/theme-ref.ts';
import { ASSET_JSON_LIMITS, decodeAssetText, parseSymbolSet, parseThemeFile } from '../../src/core/assets/asset-json.ts';
import type { SymbolSetFile, ThemeFile } from '../../src/core/assets/asset-json.ts';
import { validatePng } from '../../src/core/assets/png.ts';
import type { PngInfo } from '../../src/core/assets/png.ts';

export const ASSET_STORE_LIMITS = Object.freeze({
  maxReadBytes: 64 * 1024 * 1024,
  maxConcurrentReads: 4,
});

export const SYMBOL_STORE_LIMITS = Object.freeze({
  maxReadBytes: ASSET_JSON_LIMITS.maxChars,
});

export const THEME_STORE_LIMITS = Object.freeze({
  maxReadBytes: ASSET_JSON_LIMITS.maxChars,
});

export type AssetStoreErrorCode = 'ROOT' | 'LIMIT' | 'BUSY' | 'CLOSED';

export class AssetStoreError extends Error {
  readonly code: AssetStoreErrorCode;
  constructor(code: AssetStoreErrorCode, message: string) {
    super(message);
    this.name = 'AssetStoreError';
    this.code = code;
  }
}

export interface AssetStoreOptions {
  readonly installRoot?: string;
  readonly userDataRoot?: string;
}

export interface ImageAsset {
  readonly key: string;
  readonly ref: AssetRef;
  readonly info: PngInfo;
  readonly bytes: Uint8Array;
}

export interface SymbolSetAsset {
  readonly key: string;
  readonly ref: AssetRef;
  readonly file: SymbolSetFile;
}

export interface ThemeAsset {
  readonly key: string;
  readonly ref: ThemeRef;
  readonly file: ThemeFile;
}

export interface AssetStore {
  readImage(kind: RefKind, reference: string, maxBytes?: number): Promise<ImageAsset>;
  readSymbolSet(reference: string, maxBytes?: number): Promise<SymbolSetAsset>;
  readTheme(reference: string, maxBytes?: number): Promise<ThemeAsset>;
  close(): Promise<void>;
}

function fail(code: AssetStoreErrorCode, message: string): never {
  throw new AssetStoreError(code, message);
}

function checkRoot(value: unknown): string {
  if (typeof value !== 'string') fail('ROOT', 'Asset root must be a normalized absolute directory');
  const root = value as string;
  if (!isNativeAbsolutePath(root)) {
    fail('ROOT', 'Asset root must be a normalized absolute directory');
  }
  return root;
}

function checkCap(maxBytes: unknown): number {
  if (maxBytes === undefined) return ASSET_STORE_LIMITS.maxReadBytes;
  if (typeof maxBytes !== 'number') fail('LIMIT', 'Invalid read byte limit');
  const cap = maxBytes as number;
  if (!Number.isSafeInteger(cap) || cap < 0 || cap > ASSET_STORE_LIMITS.maxReadBytes) {
    fail('LIMIT', 'Invalid read byte limit');
  }
  return cap;
}

function checkSymbolCap(maxBytes: unknown): number {
  if (maxBytes === undefined) return SYMBOL_STORE_LIMITS.maxReadBytes;
  if (typeof maxBytes !== 'number') fail('LIMIT', 'Invalid symbol read byte limit');
  const cap = maxBytes as number;
  if (!Number.isSafeInteger(cap) || cap < 0 || cap > SYMBOL_STORE_LIMITS.maxReadBytes) {
    fail('LIMIT', 'Invalid symbol read byte limit');
  }
  return cap;
}

function checkThemeCap(maxBytes: unknown): number {
  if (maxBytes === undefined) return THEME_STORE_LIMITS.maxReadBytes;
  if (typeof maxBytes !== 'number') fail('LIMIT', 'Invalid theme read byte limit');
  const cap = maxBytes as number;
  if (!Number.isSafeInteger(cap) || cap < 0 || cap > THEME_STORE_LIMITS.maxReadBytes) {
    fail('LIMIT', 'Invalid theme read byte limit');
  }
  return cap;
}

export async function createAssetStore(options: AssetStoreOptions = {}): Promise<AssetStore> {
  let installRoot: string | undefined;
  let userDataRoot: string | undefined;
  try {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      fail('ROOT', 'Asset store options must be a plain record');
    }
    const proto = Object.getPrototypeOf(options);
    if (proto !== Object.prototype && proto !== null) {
      fail('ROOT', 'Asset store options must be a plain record');
    }
    const raw = options as Record<string, unknown>;
    installRoot = raw['installRoot'] === undefined ? undefined : checkRoot(raw['installRoot']);
    userDataRoot = raw['userDataRoot'] === undefined ? undefined : checkRoot(raw['userDataRoot']);
  } catch {
    fail('ROOT', 'Asset store options must be a plain record');
  }
  void userDataRoot;
  let pck: PckFile | undefined;
  if (installRoot !== undefined) {
    pck = await openPckFile(installRoot);
  }
  const userRoot = userDataRoot;
  let closed = false;
  let active = 0;
  let drainNotify: Array<() => void> = [];
  let closePromise: Promise<void> | undefined;

  function releaseSlot(): void {
    active -= 1;
    if (active === 0) {
      const waiting = drainNotify;
      drainNotify = [];
      for (const notify of waiting) notify();
    }
  }

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      if (active > 0) {
        await new Promise<void>((resolve) => {
          drainNotify.push(resolve);
        });
      }
      if (pck) await pck.close();
    })();
    return closePromise;
  }

  async function readImage(kind: RefKind, reference: string, maxBytes?: number): Promise<ImageAsset> {
    const cap = checkCap(maxBytes);
    const ref = resolveRef(kind, reference);
    const key = assetKey(ref);
    if (closed) fail('CLOSED', 'Asset store is closed');
    if (ref.source === 'pck' ? pck === undefined : userRoot === undefined) {
      fail('ROOT', ref.source === 'pck' ? 'Install root is not configured' : 'User data root is not configured');
    }
    if (active >= ASSET_STORE_LIMITS.maxConcurrentReads) {
      fail('BUSY', 'Too many concurrent asset reads');
    }
    active += 1;
    try {
      let bytes: Uint8Array;
      if (ref.source === 'pck') {
        bytes = await (pck as PckFile).readData(ref.path, cap);
      } else {
        bytes = await readAssetFile(userRoot as string, `assets/${ref.pack}/${ref.relPath}`, cap);
      }
      const info = validatePng(bytes);
      const frozenRef = Object.freeze(ref);
      const frozenInfo = Object.freeze(info);
      return Object.freeze({ key, ref: frozenRef, info: frozenInfo, bytes });
    } finally {
      releaseSlot();
    }
  }

  async function readSymbolSet(reference: string, maxBytes?: number): Promise<SymbolSetAsset> {
    const cap = checkSymbolCap(maxBytes);
    const image = resolveRef('symbol', reference);
    const meta = symbolSetRef(image);
    const key = assetKey(meta);
    if (closed) fail('CLOSED', 'Asset store is closed');
    if (meta.source === 'pck' ? pck === undefined : userRoot === undefined) {
      fail('ROOT', meta.source === 'pck' ? 'Install root is not configured' : 'User data root is not configured');
    }
    if (active >= ASSET_STORE_LIMITS.maxConcurrentReads) {
      fail('BUSY', 'Too many concurrent asset reads');
    }
    active += 1;
    try {
      let bytes: Uint8Array;
      if (meta.source === 'pck') {
        bytes = await (pck as PckFile).readData(meta.path, cap);
      } else {
        bytes = await readAssetFile(userRoot as string, `assets/${meta.pack}/${meta.relPath}`, cap);
      }
      const file = parseSymbolSet(decodeAssetText(bytes));
      const frozenRef = Object.freeze(meta);
      return Object.freeze({ key, ref: frozenRef, file });
    } finally {
      releaseSlot();
    }
  }

  async function readTheme(reference: string, maxBytes?: number): Promise<ThemeAsset> {
    const cap = checkThemeCap(maxBytes);
    const ref = resolveThemeRef(reference);
    const key = `theme:${ref.source}:${ref.path}`;
    if (closed) fail('CLOSED', 'Asset store is closed');
    if (ref.source === 'pck' ? pck === undefined : userRoot === undefined) {
      fail('ROOT', ref.source === 'pck' ? 'Install root is not configured' : 'User data root is not configured');
    }
    if (active >= ASSET_STORE_LIMITS.maxConcurrentReads) {
      fail('BUSY', 'Too many concurrent asset reads');
    }
    active += 1;
    try {
      let bytes: Uint8Array;
      if (ref.source === 'pck') {
        bytes = await (pck as PckFile).readData(ref.path, cap);
      } else {
        bytes = await readAssetFile(userRoot as string, ref.path, cap);
      }
      const file = parseThemeFile(decodeAssetText(bytes));
      const frozenRef = Object.freeze(ref);
      return Object.freeze({ key, ref: frozenRef, file });
    } finally {
      releaseSlot();
    }
  }

  return { readImage, readSymbolSet, readTheme, close };
}
