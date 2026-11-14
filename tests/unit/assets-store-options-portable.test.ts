import fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ASSET_STORE_LIMITS, AssetStoreError, createAssetStore } from '../../electron/assets/store.ts';
import type { AssetStore } from '../../electron/assets/store.ts';

const stores: AssetStore[] = [];
const builtin = 'res://sprites/synthetic/tree';
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.close();
});

describe('portable image store limits and options', () => {
  it('publishes the exact frozen byte and global admission ceilings', () => {
    expect(ASSET_STORE_LIMITS).toEqual({ maxReadBytes: 64 * 1024 * 1024, maxConcurrentReads: 4 });
    expect(Object.isFrozen(ASSET_STORE_LIMITS)).toBe(true);
  });

  it('accepts zero and exact maximum caps, and rejects malformed caps before CLOSED or IO', async () => {
    const store = await createAssetStore();
    stores.push(store);
    for (const cap of [0, 64 * 1024 * 1024]) {
      await expect(store.readImage('symbol', builtin, cap)).rejects.toMatchObject({ code: 'ROOT' });
    }
    await store.close();
    let coercions = 0;
    const open = vi.spyOn(fs, 'open').mockRejectedValue(new Error('unexpected filesystem open'));
    const caps: unknown[] = [-1, 1.5, NaN, Infinity, -Infinity, 64 * 1024 * 1024 + 1,
      Number.MAX_SAFE_INTEGER + 1, null, '1', false, Symbol('cap'),
      { valueOf() { coercions++; throw new Error('must not coerce'); } }];
    for (const cap of caps) {
      const error = await store.readImage('symbol', builtin, cap as number).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AssetStoreError);
      expect(error).toMatchObject({ code: 'LIMIT' });
    }
    expect(coercions).toBe(0);
    expect(open).not.toHaveBeenCalled();
  });

  it('rejects non-record options including arrays with an otherwise allowed null prototype', async () => {
    const open = vi.spyOn(fs, 'open').mockRejectedValue(new Error('unexpected filesystem open'));
    const nullArray: unknown[] = [];
    Object.setPrototypeOf(nullArray, null);
    const bad: unknown[] = [null, 1, 'options', false, Symbol('options'), () => {}, [], nullArray, new Date(0)];
    for (const options of bad) {
      let accepted: AssetStore | undefined;
      let error: unknown;
      try { accepted = await createAssetStore(options as Parameters<typeof createAssetStore>[0]); }
      catch (e) { error = e; }
      finally { if (accepted) await accepted.close(); }
      expect(error).toBeInstanceOf(AssetStoreError);
      expect(error).toMatchObject({ code: 'ROOT' });
    }
    const allowed = await createAssetStore(Object.create(null) as Record<string, never>);
    stores.push(allowed);
    await allowed.close();
    expect(open).not.toHaveBeenCalled();
  });

});
