import path from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Detect a usable MSVC + Windows SDK environment, not merely a cl.exe on PATH.
 * PowerShell commonly finds cl.exe without initializing INCLUDE and LIB.
 * The injectable fileExists keeps this check unit-testable off Windows.
 */
export function hasMsvcBuildEnvironment(env, fileExists = existsSync) {
  const includes = (env.INCLUDE ?? '').split(';').map((s) => s.trim()).filter(Boolean);
  const libraries = (env.LIB ?? '').split(';').map((s) => s.trim()).filter(Boolean);
  return includes.some((dir) => fileExists(path.win32.join(dir, 'windows.h'))) &&
    includes.some((dir) => fileExists(path.win32.join(dir, 'vector'))) &&
    libraries.some((dir) => fileExists(path.win32.join(dir, 'kernel32.lib'))) &&
    libraries.some((dir) => fileExists(path.win32.join(dir, 'libcmt.lib')));
}

/**
 * cmd.exe parses the command after /c. Pass it verbatim: Node's standard
 * Windows argv escaping would turn inner double quotes into backslash-quote
 * sequences, making a quoted vcvars64.bat path unexecutable.
 * Avoid /s, whose additional quote-stripping rules are undesirable here.
 */
export function vcvarsCommand(vcvars, node, verify, compilerArgs) {
  const quote = (value) => {
    if (typeof value !== 'string' || /["\r\n]/.test(value)) {
      throw new TypeError('Invalid compiler path or argument');
    }
    return '"' + value + '"';
  };
  return {
    command: 'cmd.exe',
    args: [
      '/d', '/c',
      'call ' + quote(vcvars) + ' >nul && ' +
        quote(node) + ' ' + quote(verify) +
        ' && cl ' + compilerArgs.map(quote).join(' '),
    ],
    options: { windowsVerbatimArguments: true },
  };
}
