import { dialog, ipcMain } from 'electron';
import type { BrowserWindow, WebContents, IpcMainInvokeEvent } from 'electron';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { IPC, type AssetImageReply } from '../src/shared/ipc.ts';
import { isNativeAbsolutePath } from './native-path.ts';
import { createAssetStore, type AssetStore } from './assets/store.ts';
import { isTrustedSender } from './ipc.ts';

const KINDS = new Set(['symbol', 'path-style', 'border-style', 'water-texture', 'ground-texture', 'frame-texture']);

/**
 * Only the main process chooses an asset root via an OS directory dialog.
 * Renderer calls carry semantic references, never arbitrary roots or disk paths.
 * No filesystem path is returned to the renderer.
 */
export function registerAssetIpc(
  expectedWebContents: () => WebContents | null,
  ownerWindow: () => BrowserWindow | null,
  editorUrl: string,
): void {
  let store: AssetStore | null = null;
  let selecting = false;

  function trusted(event: IpcMainInvokeEvent): void {
    if (!isTrustedSender(event, expectedWebContents(), editorUrl)) {
      throw new Error('untrusted sender');
    }
  }

  ipcMain.handle(IPC.selectUserAssets, async (event): Promise<boolean> => {
    trusted(event);
    if (selecting) return false;
    const owner = ownerWindow();
    if (!owner) return false;
    selecting = true;
    try {
      const result = await dialog.showOpenDialog(owner, {
        title: 'Choose Wonderdraft user data directory',
        properties: ['openDirectory'],
      });
      // An origin/frame can be replaced while the native dialog is open.
      trusted(event);
      if (result.canceled || result.filePaths.length !== 1) return false;
      const root = result.filePaths[0];
      if (!isNativeAbsolutePath(root)) return false;
      const rootInfo = await lstat(root);
      const assetsInfo = await lstat(path.join(root, 'assets'));
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() ||
          !assetsInfo.isDirectory() || assetsInfo.isSymbolicLink()) return false;
      trusted(event);
      const next = await createAssetStore({ userDataRoot: root });
      try { trusted(event); } catch (error) { await next.close(); throw error; }
      const previous = store;
      store = next;
      if (previous) await previous.close();
      return true;
    } catch {
      return false;
    } finally {
      selecting = false;
    }
  });

  ipcMain.handle(IPC.readUserImage, async (event, kind: unknown, reference: unknown): Promise<AssetImageReply> => {
    trusted(event);
    if (typeof kind !== 'string' || !KINDS.has(kind) ||
        typeof reference !== 'string' || !reference.startsWith('user://assets/')) {
      return { ok: false, code: 'INVALID' };
    }
    const selected = store;
    if (!selected) return { ok: false, code: 'NOT_SELECTED' };
    try {
      const image = await selected.readImage(kind as Parameters<AssetStore['readImage']>[0], reference);
      trusted(event);
      if (store !== selected) return { ok: false, code: 'UNAVAILABLE' };
      return { ok: true, bytes: image.bytes };
    } catch {
      return { ok: false, code: 'UNAVAILABLE' };
    }
  });
}
