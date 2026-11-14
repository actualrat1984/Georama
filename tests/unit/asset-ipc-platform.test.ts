import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('native asset IPC startup boundary', () => {
  it('keeps helper configuration and asset-handler registration in the same Windows-only block', () => {
    // main.ts has Electron startup side effects, so assert the production
    // registration site directly; the hidden-window E2E checks its behavior.
    const main = readFileSync(new URL('../../electron/main.ts', import.meta.url), 'utf8');
    const startup = main.slice(main.indexOf('void app.whenReady().then'));
    expect(startup.match(/\bregisterAssetIpc\s*\(/g)).toHaveLength(1);
    const windowsBlock = startup.match(/if\s*\(process\.platform\s*===\s*'win32'\)\s*\{([\s\S]*?)\n\s*\}/)?.[1];
    expect(windowsBlock).toBeDefined();
    expect(windowsBlock).toContain('configureWindowsSelectedFileHelper(appRoot);');
    expect(windowsBlock).toContain('configureWindowsAssetHelper(appRoot);');
    expect(windowsBlock).toContain('registerAssetIpc(() => mainWindow?.webContents ?? null, () => mainWindow, editorUrl);');
    const preload = readFileSync(new URL('../../electron/preload.ts', import.meta.url), 'utf8');
    expect(preload).toContain("process.platform === 'win32' ? {");
    expect(preload).toContain('selectUserAssets: () => ipcRenderer.invoke(IPC.selectUserAssets)');
    expect(preload).toContain('readUserImage: (kind: UserImageKind, reference: string) => ipcRenderer.invoke(IPC.readUserImage, kind, reference)');
  });
});
