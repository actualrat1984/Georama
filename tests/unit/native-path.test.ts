import { describe, expect, it } from 'vitest';
import { isNativeAbsolutePath } from '../../electron/native-path.ts';

describe('canonical native absolute path policy', () => {
  it.each([
    'C:\\',
    'C:\\Users\\Example\\Maps\\world.wonderdraft_map',
    'e:\\Games\\Wonderdraft\\Wonderdraft.pck',
    'D:\\non-ascii-é-ü-ß\\🗺️.json',
    'Z:\\with spaces\\a%2eb.json',
    'C:\\.hidden\\nested',
  ])('accepts explicit normalized drive paths: %s', (value) => {
    expect(isNativeAbsolutePath(value, 'win32')).toBe(true);
  });

  it.each([
    '',
    '/',
    '/home/u/maps/world.json',
    'relative\\world.json',
    'C:world.json',
    'C:',
    'C:/Users/Example/world.json',
    '\\\\server\\share\\world.json',
    '\\\\?\\C:\\world.json',
    '\\\\.\\C:\\world.json',
    'C:\\\\world.json',
    'C:\\a\\.\\world.json',
    'C:\\a\\..\\world.json',
    'C:\\a\\..',
    'C:\\a\\',
    'C:\\a.\\world.json',
    'C:\\a \\world.json',
    'C:\\assets\\CON.json',
    'C:\\assets\\NUL',
    'C:\\assets\\COM1.png',
    'C:\\assets\\LPT9.txt',
    'C:\\assets\\CONIN$',
    'C:\\assets\\COM¹.txt',
    'C:\\assets\\world.json:secret',
    'C:\\assets\\star*.json',
    'C:\\assets\\quest?.json',
    'C:\\assets\\tab\\bad\tfile.json',
    'C:\\assets\\bad\0file.json',
    'C:\\assets\\bad' + String.fromCharCode(0xd800) + '.json',
    'C:\\assets\\bad' + String.fromCharCode(0xdc00) + '.json',
  ])('rejects dangerous or ambiguous Windows paths: %s', (value) => {
    expect(isNativeAbsolutePath(value, 'win32')).toBe(false);
  });

  it('enforces the length boundary and avoids user-defined coercion', () => {
    expect(isNativeAbsolutePath('C:\\' + 'a'.repeat(4093), 'win32')).toBe(true);
    expect(isNativeAbsolutePath('C:\\' + 'a'.repeat(4094), 'win32')).toBe(false);
    for (const input of [null, undefined, [], {}, 5, new String('C:\\x')]) {
      expect(isNativeAbsolutePath(input, 'win32')).toBe(false);
    }
    expect(isNativeAbsolutePath({ toString: () => { throw new Error('coercion'); } }, 'win32')).toBe(false);
  });

  it('retains the original POSIX normalization contract exactly', () => {
    for (const good of ['/', '/a', '/a/', '/with spaces/f.json', '/colon:name.json', '/back\\slash.json']) {
      expect(isNativeAbsolutePath(good, 'linux')).toBe(true);
    }
    for (const bad of ['', 'a', 'C:\\file.json', '//a', '/a//b', '/a/./b', '/a/../b', '/bad\0.json']) {
      expect(isNativeAbsolutePath(bad, 'linux')).toBe(false);
    }
  });
});
