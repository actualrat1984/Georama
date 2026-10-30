import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
import { spawn } from 'node:child_process';
import { configureWindowsAssetHelper, readWindowsAsset } from '../../electron/assets/windows-read.ts';

describe('Windows native helper configuration', () => {
  it('fails closed before trusted startup binds a helper location', async () => {
    expect(await readWindowsAsset('C:\\assets', 'pack/tree.png', 8)).toEqual({ error: 'IO' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses relative installation roots and rejects rebinding', () => {
    expect(() => configureWindowsAssetHelper('relative/checkout')).toThrow();
    const root = fileURLToPath(new URL('../../', import.meta.url));
    expect(() => configureWindowsAssetHelper(root)).not.toThrow();
    expect(() => configureWindowsAssetHelper(root)).toThrow('already configured');
  });
});
