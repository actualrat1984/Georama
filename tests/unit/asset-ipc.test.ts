import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const mocked = vi.hoisted(() => ({
  handle: vi.fn(),
  choose: vi.fn(),
  lstat: vi.fn(),
  makeStore: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: mocked.handle },
  dialog: { showOpenDialog: mocked.choose },
}));
vi.mock('node:fs/promises', () => ({ lstat: mocked.lstat }));
vi.mock('../../electron/assets/store.ts', () => ({
  createAssetStore: mocked.makeStore,
  ASSET_STORE_LIMITS: Object.freeze({ maxReadBytes: 64 * 1024 * 1024, maxConcurrentReads: 4 }),
}));
import { registerAssetIpc } from '../../electron/asset-ipc.ts';
import { IPC } from '../../src/shared/ipc.ts';
import { ASSET_STORE_LIMITS } from '../../electron/assets/store.ts';

const editor = 'georama://app/index.html';
const root = 'C:\\UserAssets';
function fixture() {
  const frame = { url: editor, parent: null as object | null };
  const contents = { mainFrame: frame };
  return { frame, contents, event: { sender: contents, senderFrame: frame } };
}
function handlers() {
  const f = fixture();
  registerAssetIpc(() => f.contents as never, () => ({}) as never, editor);
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>(
    mocked.handle.mock.calls.map(([name, handler]) => [name, handler] as [string, (...args: unknown[]) => Promise<unknown>]),
  );
  return { ...f, pick: handlers.get(IPC.selectUserAssets)!, read: handlers.get(IPC.readUserImage)! };
}
const info = { isDirectory: () => true, isSymbolicLink: () => false };

beforeEach(() => {
  mocked.handle.mockReset();
  mocked.choose.mockReset();
  mocked.lstat.mockReset().mockResolvedValue(info);
  mocked.makeStore.mockReset();
});

describe('user asset IPC capability', () => {
  it('requires the current trusted editor for each call', async () => {
    const x = handlers();
    const foreign = { ...x.event, senderFrame: { url: editor, parent: null } };
    await expect(x.pick(foreign)).rejects.toThrow('untrusted sender');
    await expect(x.read(foreign, 'symbol', 'user://assets/p/tree')).rejects.toThrow('untrusted sender');
    expect(mocked.choose).not.toHaveBeenCalled();
    expect(mocked.makeStore).not.toHaveBeenCalled();
  });

  it('rejects forged main-window identities, subframes, and another app document at both handlers', async () => {
    const x = handlers();
    const forgedContents = { mainFrame: x.frame };
    const attempts = [
      { sender: forgedContents, senderFrame: x.frame },
      { sender: x.contents, senderFrame: { url: editor, parent: null } },
      { sender: x.contents, senderFrame: { url: editor, parent: x.frame } },
    ];
    for (const event of attempts) {
      await expect(x.pick(event)).rejects.toThrow('untrusted sender');
      await expect(x.read(event, 'symbol', 'user://assets/a/tree')).rejects.toThrow('untrusted sender');
    }
    x.frame.url = 'georama://app/another-document.html';
    await expect(x.pick(x.event)).rejects.toThrow('untrusted sender');
    await expect(x.read(x.event, 'symbol', 'user://assets/a/tree')).rejects.toThrow('untrusted sender');
    expect(mocked.choose).not.toHaveBeenCalled();
  });

  it('never accepts arbitrary roots or unsupported references from the renderer', async () => {
    const x = handlers();
    expect(await x.read(x.event, 'symbol', 'user://assets/a/tree')).toEqual({ ok: false, code: 'NOT_SELECTED' });
    for (const args of [
      ['symbol', '../secret'],
      ['symbol', 'res://sprites/tree'],
      ['symbol', 'C:\\Users\\secret.png'],
      ['symbol', 'user://assets/a/../secret'],
      ['symbol', 'user://assets/a//tree'],
      ['symbol', 'user://assets/a/.hidden'],
      ['symbol', 'user://assets/a/tree\\other'],
      ['symbol', 'user://assets/a'],
      ['path-style', 'user://assets/a/tree'],
      ['unexpected', 'user://assets/a/tree'],
      [null, 'user://assets/a/tree'],
      ['symbol', { root: '/tmp/secret' }],
    ]) {
      expect(await x.read(x.event, ...args)).toEqual({ ok: false, code: 'INVALID' });
    }
    expect(mocked.makeStore).not.toHaveBeenCalled();
  });

  it('never takes a new asset root from renderer arguments or without another OS dialog', async () => {
    const x = handlers();
    const store = { readImage: vi.fn().mockResolvedValue({ bytes: new Uint8Array([1]) }), close: vi.fn() };
    mocked.makeStore.mockResolvedValue(store);
    mocked.choose.mockResolvedValueOnce({ canceled: false, filePaths: [root] });
    expect(await x.pick(x.event, 'C:\\renderer-injected-root')).toBe(true);
    expect(mocked.makeStore).toHaveBeenCalledTimes(1);
    expect(mocked.makeStore).toHaveBeenCalledWith({ userDataRoot: root });
    expect(mocked.choose).toHaveBeenCalledTimes(1);
    expect(await x.read(x.event, 'symbol', 'C:\\renderer-injected-root\\tree.png'))
      .toEqual({ ok: false, code: 'INVALID' });
    expect(await x.read(x.event, 'symbol', 'user://assets/a/tree'))
      .toEqual({ ok: true, bytes: new Uint8Array([1]) });
    expect(mocked.choose).toHaveBeenCalledTimes(1);
    expect(mocked.makeStore).toHaveBeenCalledTimes(1);
  });

  it('selects through the native picker and reads with a private store', async () => {
    const x = handlers();
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const readImage = vi.fn().mockResolvedValue({ bytes });
    mocked.makeStore.mockResolvedValue({ readImage, close: vi.fn() });
    mocked.choose.mockResolvedValue({ canceled: false, filePaths: [root] });
    expect(await x.pick(x.event)).toBe(true);
    expect(mocked.choose).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ properties: ['openDirectory'] }));
    expect(mocked.lstat).toHaveBeenCalledWith(path.join(root, 'assets'));
    expect(mocked.makeStore).toHaveBeenCalledWith({ userDataRoot: root });
    expect(await x.read(x.event, 'symbol', 'user://assets/a/tree')).toEqual({ ok: true, bytes });
    expect(readImage).toHaveBeenCalledWith('symbol', 'user://assets/a/tree', ASSET_STORE_LIMITS.maxReadBytes);
  });

  it('rejects canceled and symlinked selections without granting authority', async () => {
    const x = handlers();
    mocked.choose.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await x.pick(x.event)).toBe(false);
    mocked.choose.mockResolvedValueOnce({ canceled: false, filePaths: [root] });
    mocked.lstat.mockResolvedValueOnce({ isDirectory: () => true, isSymbolicLink: () => true });
    expect(await x.pick(x.event)).toBe(false);
    expect(mocked.makeStore).not.toHaveBeenCalled();
  });

  it('rejects malformed or non-canonical Windows roots chosen by a dialog', async () => {
    const x = handlers();
    for (const candidate of ['\\\\server\\share', 'C:relative', 'C:\\folder\\..\\private',
      'C:\\folder\\', 'C:\\folder\\junction/child', '/tmp/absolute-but-not-Windows']) {
      mocked.choose.mockResolvedValueOnce({ canceled: false, filePaths: [candidate] });
      expect(await x.pick(x.event)).toBe(false);
    }
    expect(mocked.makeStore).not.toHaveBeenCalled();
    expect(mocked.lstat).not.toHaveBeenCalled();
  });

  it('revokes a pending dialog when the editor navigates away', async () => {
    const x = handlers();
    mocked.choose.mockImplementation(async () => {
      x.frame.url = 'https://evil.example/';
      return { canceled: false, filePaths: [root] };
    });
    expect(await x.pick(x.event)).toBe(false);
    expect(mocked.makeStore).not.toHaveBeenCalled();
  });

  it('does not expose raw errors or stale reads after selection is replaced', async () => {
    const x = handlers();
    const first = { readImage: vi.fn().mockRejectedValue(new Error('C:\\private\\secret')), close: vi.fn() };
    mocked.makeStore.mockResolvedValue(first);
    mocked.choose.mockResolvedValue({ canceled: false, filePaths: [root] });
    expect(await x.pick(x.event)).toBe(true);
    expect(await x.read(x.event, 'symbol', 'user://assets/a/tree')).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });
  it('rejects overlapping native folder dialogs', async () => {
    const x = handlers();
    let finish!: (value: unknown) => void;
    mocked.choose.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const waiting = x.pick(x.event);
    expect(await x.pick(x.event)).toBe(false);
    expect(mocked.choose).toHaveBeenCalledTimes(1);
    finish({ canceled: true, filePaths: [] });
    expect(await waiting).toBe(false);
  });

  it('never delivers bytes from a root replaced during an in-flight read', async () => {
    const x = handlers();
    let complete!: (value: unknown) => void;
    const firstRead = new Promise((resolve) => { complete = resolve; });
    const first = { readImage: vi.fn().mockReturnValue(firstRead), close: vi.fn().mockResolvedValue(undefined) };
    const second = { readImage: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    mocked.choose.mockResolvedValue({ canceled: false, filePaths: [root] });
    mocked.makeStore.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    expect(await x.pick(x.event)).toBe(true);
    const pending = x.read(x.event, 'symbol', 'user://assets/a/tree');
    expect(await x.pick(x.event)).toBe(true);
    complete({ bytes: new Uint8Array([1, 2, 3]) });
    expect(await pending).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(first.close).toHaveBeenCalledOnce();
  });

  it('never delivers in-flight bytes after the calling frame navigates away', async () => {
    const x = handlers();
    let complete!: (value: unknown) => void;
    const waiting = new Promise((resolve) => { complete = resolve; });
    const store = { readImage: vi.fn().mockReturnValue(waiting), close: vi.fn() };
    mocked.choose.mockResolvedValue({ canceled: false, filePaths: [root] });
    mocked.makeStore.mockResolvedValue(store);
    expect(await x.pick(x.event)).toBe(true);
    const pending = x.read(x.event, 'symbol', 'user://assets/a/tree');
    x.frame.url = 'https://untrusted.example/';
    complete({ bytes: new Uint8Array([99]) });
    expect(await pending).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });

  it('enforces four simultaneous IPC reads and the explicit 64 MiB call cap', async () => {
    const x = handlers();
    let release!: (value: unknown) => void;
    const gate = new Promise(resolve => { release = resolve; });
    const readImage = vi.fn().mockReturnValue(gate);
    mocked.makeStore.mockResolvedValue({ readImage, close: vi.fn() });
    mocked.choose.mockResolvedValue({ canceled: false, filePaths: [root] });
    expect(await x.pick(x.event)).toBe(true);
    const pending = Array.from({ length: 4 }, () => x.read(x.event, 'symbol', 'user://assets/a/tree'));
    expect(await x.read(x.event, 'symbol', 'user://assets/a/tree'))
      .toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(readImage).toHaveBeenCalledTimes(4);
    for (const args of readImage.mock.calls) {
      expect(args).toEqual(['symbol', 'user://assets/a/tree', ASSET_STORE_LIMITS.maxReadBytes]);
    }
    release({ bytes: new Uint8Array([1, 2]) });
    expect(await Promise.all(pending)).toEqual(Array.from({ length: 4 }, () => ({ ok: true, bytes: new Uint8Array([1, 2]) })));
    expect(await x.read(x.event, 'symbol', 'user://assets/a/tree'))
      .toEqual({ ok: true, bytes: new Uint8Array([1, 2]) });
  });

  it('never returns an oversized reader result even if a mocked backend violates its contract', async () => {
    const x = handlers();
    const tooLarge = new Uint8Array(ASSET_STORE_LIMITS.maxReadBytes + 1);
    mocked.makeStore.mockResolvedValue({ readImage: vi.fn().mockResolvedValue({ bytes: tooLarge }), close: vi.fn() });
    mocked.choose.mockResolvedValue({ canceled: false, filePaths: [root] });
    expect(await x.pick(x.event)).toBe(true);
    expect(await x.read(x.event, 'symbol', 'user://assets/a/tree'))
      .toEqual({ ok: false, code: 'UNAVAILABLE' });
  });

});
