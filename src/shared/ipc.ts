export const IPC = {
  getInfo: 'app:get-info',
  selectUserAssets: 'assets:select-user-root',
  readUserImage: 'assets:read-user-image',
} as const;

export interface AppInfo {
  name: string;
  id: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  e2e: boolean;
}

export type AssetImageReply =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly code: 'INVALID' | 'NOT_SELECTED' | 'UNAVAILABLE' };

export type UserImageKind = 'symbol' | 'path-style' | 'border-style' | 'water-texture' | 'ground-texture' | 'frame-texture';

export interface GeoramaApi {
  getAppInfo(): Promise<AppInfo>;
  selectUserAssets(): Promise<boolean>;
  readUserImage(kind: UserImageKind, reference: string): Promise<AssetImageReply>;
}
