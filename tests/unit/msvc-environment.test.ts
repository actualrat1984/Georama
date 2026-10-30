import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { hasMsvcBuildEnvironment, vcvarsCommand } from '../../scripts/msvc-environment.mjs';

const vcInclude = 'C:\\VS\\VC\\include';
const sdkInclude = 'C:\\Windows Kits\\10\\Include\\um';
const vcLib = 'C:\\VS\\VC\\lib\\x64';
const sdkLib = 'C:\\Windows Kits\\10\\Lib\\um\\x64';
const complete = {
  INCLUDE: [vcInclude, sdkInclude].join(';'),
  LIB: [vcLib, sdkLib].join(';'),
};
const completeFiles = new Set([
  path.win32.join(vcInclude, 'vector'),
  path.win32.join(sdkInclude, 'windows.h'),
  path.win32.join(vcLib, 'libcmt.lib'),
  path.win32.join(sdkLib, 'kernel32.lib'),
]);

describe('MSVC build environment readiness (host-independent)', () => {
  const exists = (candidate: string): boolean => completeFiles.has(candidate);

  it('accepts a fully initialized compiler and Windows SDK environment', () => {
    expect(hasMsvcBuildEnvironment(complete, exists)).toBe(true);
  });
  it('rejects cl.exe-on-PATH-only environments without INCLUDE or LIB', () => {
    expect(hasMsvcBuildEnvironment({}, exists)).toBe(false);
    expect(hasMsvcBuildEnvironment({ INCLUDE: '', LIB: '' }, exists)).toBe(false);
  });
  it('rejects an SDK-less MSVC environment even if standard C++ headers work', () => {
    const files = new Set(completeFiles);
    files.delete(path.win32.join(sdkInclude, 'windows.h'));
    expect(hasMsvcBuildEnvironment(complete, (v: string) => files.has(v))).toBe(false);
  });
  it('rejects incomplete C++ headers even when Windows SDK is present', () => {
    const files = new Set(completeFiles);
    files.delete(path.win32.join(vcInclude, 'vector'));
    expect(hasMsvcBuildEnvironment(complete, (v: string) => files.has(v))).toBe(false);
  });
  it.each(['libcmt.lib', 'kernel32.lib'])('rejects absent %s libraries', (name) => {
    const files = new Set(completeFiles);
    const folder = name === 'libcmt.lib' ? vcLib : sdkLib;
    files.delete(path.win32.join(folder, name));
    expect(hasMsvcBuildEnvironment(complete, (v: string) => files.has(v))).toBe(false);
  });
  it('ignores empty include/library path entries', () => {
    expect(hasMsvcBuildEnvironment({
      INCLUDE: ';' + complete.INCLUDE + ';;',
      LIB: ';' + complete.LIB + ';',
    }, exists)).toBe(true);
  });
});

describe('VC environment invocation with cmd.exe', () => {
  it('passes quoted Build Tools 2026 paths verbatim without /s quote stripping', () => {
    const bat = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\18\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64.bat';
    const node = 'C:\\Program Files\\nodejs\\node.exe';
    const verify = 'E:\\Georama Workspace\\scripts\\check-msvc-environment.mjs';
    const run = vcvarsCommand(bat, node, verify, ['/nologo', '/FeE:\\Georama Workspace\\out\\helper.exe']);
    expect(run.command).toBe('cmd.exe');
    expect(run.args.slice(0, 2)).toEqual(['/d', '/c']);
    expect(run.args[2]).toBe(
      'call "' + bat + '" >nul && "' + node + '" "' + verify +
      '" && cl "/nologo" "/FeE:\\Georama Workspace\\out\\helper.exe"',
    );
    expect(run.options).toEqual({ windowsVerbatimArguments: true });
    expect(run.args[2]).not.toContain('\\\\"');
  });

  it.skipIf(process.platform !== 'win32')('runs a spaced-path batch and compiler through a real Windows cmd process', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'georama vc (x86) '));
    try {
      const bat = path.join(dir, 'vcvars64.bat');
      const check = path.join(dir, 'check.mjs');
      const fakeCompiler = path.join(dir, 'cl.cmd');
      await writeFile(bat,
        '@echo off\r\n' +
        'set "GEORAMA_VCVARS_PROBE=ready"\r\n' +
        'set "PATH=' + dir + ';%PATH%"\r\n',
      );
      await writeFile(check, 'if (process.env.GEORAMA_VCVARS_PROBE !== "ready") process.exit(6);\n');
      await writeFile(fakeCompiler,
        '@echo off\r\n' +
        'if not "%GEORAMA_VCVARS_PROBE%"=="ready" exit /b 7\r\n' +
        'exit /b 0\r\n',
      );
      const call = vcvarsCommand(bat, process.execPath, check, ['/nologo']);
      const result = spawnSync(call.command, call.args, {
        ...call.options, encoding: 'utf8', windowsHide: true, timeout: 15_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
