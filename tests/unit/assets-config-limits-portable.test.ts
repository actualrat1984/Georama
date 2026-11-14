import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_LIMITS, ConfigError, parseConfig } from '../../electron/assets/config.ts';

// Platform-independent JSON size/error contracts; root fixtures use native syntax.
function parseCode(text: string): string {
  try {
    parseConfig(text);
    return 'ok';
  } catch (error) {
    return error instanceof ConfigError ? error.code : `foreign:${String(error)}`;
  }
}
/** `{"x":"<pad>"}` with exactly `bytes` UTF-8 bytes; the pad mixes two-byte letters, so characters and bytes differ. */
function jsonOfBytes(bytes: number): string {
  const head = '{"x":"';
  const tail = '"}';
  const room = bytes - Buffer.byteLength(head + tail);
  const twoByte = Math.floor(room / 4);
  const text = head + 'é'.repeat(twoByte) + 'p'.repeat(room - twoByte * 2) + tail;
  expect(Buffer.byteLength(text, 'utf8')).toBe(bytes);
  return text;
}

describe('parseConfig: the size and root-count limits sit exactly at their edge', () => {
  it('65,536 bytes parse, 65,537 do not, and the unit is bytes', () => {
    expect(CONFIG_LIMITS.maxBytes).toBe(65_536);
    expect(parseCode(jsonOfBytes(65_536))).toBe('ok');
    expect(parseCode(jsonOfBytes(65_535))).toBe('ok');
    expect(parseCode(jsonOfBytes(65_537))).toBe('TOO_LARGE');
    // 40,000 characters but 80,000 bytes.
    expect(parseCode('"' + 'é'.repeat(39_998) + '"')).toBe('TOO_LARGE');
    // 65,536 characters of a multi-byte letter is far more than 65,536 bytes.
    expect(parseCode('{"x":"' + 'é'.repeat(32_800) + '"}')).toBe('TOO_LARGE');
  });
  it('the size error carries an empty key and the JSON error is judged after the size', () => {
    try {
      parseConfig('x'.repeat(65_537));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).key).toBe('');
    }
    expect(parseCode('x'.repeat(65_536))).toBe('SYNTAX');
  });
  it('64 map roots are accepted, 65 are SHAPE at mapRoots', () => {
    const roots = (n: number): string => JSON.stringify({ mapRoots: Array.from({ length: n }, (_, i) =>
      process.platform === 'win32' ? path.win32.join('C:/', `r${i}`) : `/r${i}`) });
    expect(CONFIG_LIMITS.maxMapRoots).toBe(64);
    expect(parseConfig(roots(64)).mapRoots).toHaveLength(64);
    expect(parseConfig(roots(0)).mapRoots).toEqual([]);
    try {
      parseConfig(roots(65));
      expect.unreachable();
    } catch (error) {
      expect((error as ConfigError).code).toBe('SHAPE');
      expect((error as ConfigError).key).toBe('mapRoots');
    }
  });
});
