import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type GeoramaApi, type UserImageKind } from '../src/shared/ipc';

const api: GeoramaApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC.getInfo),
  ...(process.platform === 'win32' ? {
    selectUserAssets: () => ipcRenderer.invoke(IPC.selectUserAssets),
    readUserImage: (kind: UserImageKind, reference: string) => ipcRenderer.invoke(IPC.readUserImage, kind, reference),
  } : {}),
};
contextBridge.exposeInMainWorld('georama', Object.freeze(api));
