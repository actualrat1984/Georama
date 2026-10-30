import path from 'node:path';
import { app, BrowserWindow, Menu, session } from 'electron';
import type { WebContents } from 'electron';
import { BRAND } from '../src/shared/brand.ts';
import type { AppInfo } from '../src/shared/ipc.ts';
import { registerIpc } from './ipc.ts';
import { configureWindowsAssetHelper } from './assets/windows-read.ts';
import { createNavigationGuard, isEditorDocument } from './navigation-guard.ts';
import { installNetwork } from './network.ts';
import { installAppProtocol, registerAppScheme } from './protocol.ts';
import { installSecurity, isTrustedAppUrl } from './security.ts';

app.setName(BRAND.id);
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
installSecurity(app);
// Switches and listeners that must exist before the first session or window do.
const network = installNetwork(app);
registerAppScheme();

const e2e = process.env.GEORAMA_E2E === '1';
const editorUrl = `${BRAND.scheme}://${BRAND.host}/index.html`;
let mainWindow: BrowserWindow | null = null;

const appInfo = (): AppInfo => ({
  name: BRAND.name,
  id: BRAND.id,
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform,
  e2e,
});

/** Only the editor document may ever be committed, and never in a frame: anything else discards the window. */
const navigationGuard = createNavigationGuard({
  editorUrl,
  now: () => Date.now(),
  observe: (violation) => {
    // One line, no page-controlled text beyond the scheme: the URL is attacker-chosen.
    const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(violation.url)?.[0] ?? 'unparsed:';
    console.error(`navigation guard: ${violation.action}; ${violation.isMainFrame ? 'main' : 'child'} frame ${violation.precommit ? 'before commit' : 'committed'} ${scheme}`);
  },
  recover: (violation) => {
    // Create the replacement first: closing the last window would quit the app.
    const offender = violation.target instanceof Object ? BrowserWindow.fromWebContents(violation.target as WebContents) : null;
    createEditorWindow();
    if (offender && !offender.isDestroyed()) offender.destroy();
  },
  quit: () => app.exit(1),
});

function createEditorWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: BRAND.name,
    backgroundColor: '#14110d',
    show: !e2e,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist-electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      backgroundThrottling: false,
      devTools: process.env.GEORAMA_DEVTOOLS === '1',
    },
  });
  mainWindow = window;
  window.on('closed', () => { if (mainWindow === window) mainWindow = null; });
  const contents = window.webContents;
  // Main frame, before commit: an app document other than the editor never loads, so the window keeps its unsaved
  // state. The attempt counts toward the same 60 s limit as a committed violation.
  contents.on('will-navigate', (event, url) => {
    if (!isTrustedAppUrl(url) || isEditorDocument(url, editorUrl)) return;
    event.preventDefault();
    navigationGuard.check({ url, isMainFrame: true, target: contents, precommit: true });
  });
  // Main frame: committed navigations only. did-start-navigation also fires for attempts that will-navigate
  // then cancels (a dropped file, an external link); recovering from those would destroy unsaved editor state.
  // Child frames: any attempt counts, because the app has no frames and the page can only create one itself.
  contents.on('did-navigate', (_event, url) => navigationGuard.check({ url, isMainFrame: true, target: contents }));
  contents.on('did-start-navigation', (details) => { if (!details.isMainFrame) navigationGuard.check({ url: details.url, isMainFrame: false, target: contents }); });
  contents.on('did-frame-navigate', (_event, url, _code, _text, isMainFrame) => { if (!isMainFrame) navigationGuard.check({ url, isMainFrame: false, target: contents }); });
  void window.loadURL(editorUrl).catch((error: unknown) => {
    console.error('Editor load failed:', error);
    app.exit(1);
  });
  return window;
}

if (!e2e && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });

  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    // The network lockdown must be complete before anything can load.
    await network.prepareSession(session.defaultSession);
    installAppProtocol();
    if (process.platform === 'win32') configureWindowsAssetHelper(app.getAppPath());
    registerIpc(appInfo, () => mainWindow?.webContents ?? null, editorUrl);
    createEditorWindow();
  }).catch((error: unknown) => {
    console.error('Application startup failed:', error);
    app.exit(1);
  });
}

app.on('window-all-closed', () => app.quit());
