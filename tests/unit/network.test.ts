import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// The URL/network policy is tested with synthetic App and Session objects.
// electron/security.ts imports the Electron session only for installSecurity;
// loading a binary here would make a unit test depend on release downloads.
vi.mock('electron', () => ({ session: { defaultSession: {} } }));

import { HOST_CATCH_ALL, installNetwork, isAllowedRequestUrl, OFFLINE_PROXY } from '../../electron/network.ts';

const allowed = ['georama://app/', 'georama://app/index.html', 'georama://app/assets/a.js?x=1#x', 'blob:georama://app/27f41072-efaa-4d0e-a101-62c65a0bab64', 'data:image/png;base64,AA==', 'data:image/svg+xml,%3Csvg%3E', 'data:image/png,AA==', 'data:image/svg+xml;utf8,AA'];
const denied = ['http://127.0.0.1/', 'https://app/', 'ws://app/', 'wss://app/', 'ftp://app/', 'file:///etc/passwd', 'georama://user@app/', 'georama://u:p@app/', 'georama://app@evil/', 'georama://app.evil/', 'georama://evil/', 'georama://app:80/', 'georama://app:0/', 'blob:https://evil/abc', 'blob:file:///abc', 'blob:georama://user@app/abc', 'blob:georama://app:80/abc', 'data:text/html,x', 'data:text/javascript,x', 'data:image/wav;base64,AA==', 'data:audio/wav;base64,AA==', 'data:audio/png;base64,AA==', 'data:video/mp4;base64,AA==', 'data:video/webp;base64,AA==', 'data:font/woff2;base64,AA==', 'data:application/octet-stream;base64,AA==', 'data:text/html;base64,AA==', 'data:image/png-evil;base64,AA==', 'javascript:1', 'about:blank', 'chrome://version', 'devtools://devtools/bundled/inspector.html', '', 'bad url'];

describe('request allowlist', () => {
  it.each(allowed)('allows necessary CSP resources %s', url => expect(isAllowedRequestUrl(url)).toBe(true));
  it.each(denied)('denies %s', url => expect(isAllowedRequestUrl(url)).toBe(false));
  it('requires an explicit devtools opt-in', () => {
    expect(isAllowedRequestUrl('devtools://devtools/bundled/inspector.html', true)).toBe(true);
    expect(isAllowedRequestUrl('https://evil/', true)).toBe(false);
  });
});

function fixtureSession(order: string[]) {
  let handler: (details: {url: string}, reply: (x: {cancel: boolean}) => void) => void;
  return {
    webRequest: { onBeforeRequest: vi.fn((filter, fn) => { expect(filter).toEqual({urls: ['<all_urls>']}); handler = fn; order.push('filter'); }) },
    setProxy: vi.fn(async config => { expect(config).toEqual({mode: 'fixed_servers', proxyRules: 'socks5://offline.invalid:9', proxyBypassRules: '<-loopback>'}); order.push('proxy'); }),
    closeAllConnections: vi.fn(async () => { order.push('close'); }),
    request(url: string) { const reply = vi.fn(); handler({url}, reply); return reply.mock.calls[0][0]; },
  };
}

describe('network enforcement ordering', () => {
  beforeEach(() => vi.unstubAllEnvs());
  it('locks default and future sessions before any allowed request; sessions are idempotent', async () => {
    const order: string[] = [], app = Object.assign(new EventEmitter(), {commandLine: {getSwitchValue: vi.fn(() => ''), appendSwitch: vi.fn((k: string, v?: string) => order.push(k + (v ? '=' + v : '')))}});
    const first = fixtureSession(order), second = fixtureSession(order);
    const network = installNetwork(app as never);
    await network.prepareSession(first as never);
    order.push('first-window');
    const c = {session: second, setWebRTCIPHandlingPolicy: vi.fn()};
    app.emit('web-contents-created', {}, c);
    expect(second.request('georama://app/index.html')).toEqual({cancel: true});
    await network.prepareSession(second as never);
    app.emit('web-contents-created', {}, c);
    await network.prepareSession(first as never);
    expect(c.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp');
    expect(first.setProxy).toHaveBeenCalledTimes(1); expect(second.setProxy).toHaveBeenCalledTimes(1);
    expect(first.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1); expect(second.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
    expect(order.slice(0, 5)).toEqual(['force-webrtc-ip-handling-policy=disable_non_proxied_udp', 'host-resolver-rules=MAP * ~NOTFOUND', 'filter', 'proxy', 'close']);
    expect(order.indexOf('close')).toBeLessThan(order.indexOf('first-window'));
    for (const s of [first, second]) {
      expect(s.request('georama://app/index.html')).toEqual({cancel: false});
      for (const url of denied) expect(s.request(url)).toEqual({cancel: true});
    }
  });
  it('keeps a host-resolver rule given on the command line and puts the catch-all last (first match wins)', () => {
    const appendSwitch = vi.fn();
    const app = Object.assign(new EventEmitter(), {commandLine: {getSwitchValue: vi.fn((name: string) => name === 'host-resolver-rules' ? 'MAP *.x.invalid 127.0.0.1' : ''), appendSwitch}});
    installNetwork(app as never);
    expect(appendSwitch).toHaveBeenCalledWith('host-resolver-rules', 'MAP *.x.invalid 127.0.0.1, MAP * ~NOTFOUND');
  });
  it('does not allow a request after proxy setup fails', async () => {
    const app = Object.assign(new EventEmitter(), {commandLine: {getSwitchValue: vi.fn(() => ''), appendSwitch: vi.fn()}}), s = fixtureSession([]);
    s.setProxy.mockRejectedValueOnce(new Error('proxy failed'));
    await expect(installNetwork(app as never).prepareSession(s as never)).rejects.toThrow('proxy failed');
    expect(s.request('georama://app/index.html')).toEqual({cancel: true});
    expect(s.closeAllConnections).not.toHaveBeenCalled();
  });
  it('pins the offline proxy literals exactly (a changed port or bypass must fail)', async () => {
    expect(OFFLINE_PROXY).toBe('socks5://offline.invalid:9');
    const order: string[] = [];
    const app = Object.assign(new EventEmitter(), {commandLine: {getSwitchValue: vi.fn(() => ''), appendSwitch: vi.fn()}});
    const s = fixtureSession(order);
    installNetwork(app as never);
    await installNetwork(app as never).prepareSession(s as never);
    expect(s.setProxy).toHaveBeenCalledWith({mode: 'fixed_servers', proxyRules: 'socks5://offline.invalid:9', proxyBypassRules: '<-loopback>'});
  });
  it("pins the literal HOST_CATCH_ALL value 'MAP * ~NOTFOUND'", () => {
    expect(HOST_CATCH_ALL).toBe('MAP * ~NOTFOUND');
  });
  it("appends the switch force-webrtc-ip-handling-policy with value disable_non_proxied_udp", () => {
    const appendSwitch = vi.fn();
    const app = Object.assign(new EventEmitter(), {commandLine: {getSwitchValue: vi.fn(() => ''), appendSwitch}});
    installNetwork(app as never);
    expect(appendSwitch).toHaveBeenCalledWith('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');
  });
});
