import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeGcpf } from '../../src/core/formats/gcpf.ts';
import { encodeStoreVar } from '../../src/core/formats/godot-var.ts';
import { findMapFiles, findMapFilesIn, parseMapRoots, runCorpusCheck } from '../helpers/corpus.ts';
import { makeSyntheticRoot } from '../helpers/wd-synthetic.ts';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(process.env['TMPDIR'] ?? tmpdir(), 'georama-corpus-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function validMap(): Uint8Array {
  return encodeGcpf(encodeStoreVar(makeSyntheticRoot()));
}

describe('findMapFiles', () => {
  it('finds maps recursively, any case of the extension, sorted, and nothing else', async () => {
    await mkdir(join(dir, 'b', 'deep'), { recursive: true });
    await writeFile(join(dir, 'z.wonderdraft_map'), 'x');
    await writeFile(join(dir, 'a.WONDERDRAFT_MAP'), 'x');
    await writeFile(join(dir, 'b', 'deep', 'm.wonderdraft_map'), 'x');
    await writeFile(join(dir, 'b', 'notes.txt'), 'x');
    await writeFile(join(dir, 'b', 'map.wonderdraft_map.bak'), 'x');
    const found = await findMapFiles(dir);
    expect(found).toEqual([join(dir, 'a.WONDERDRAFT_MAP'), join(dir, 'b', 'deep', 'm.wonderdraft_map'), join(dir, 'z.wonderdraft_map')]);
  });

  it('does not follow symbolic links, to files or to folders', async () => {
    await mkdir(join(dir, 'real'));
    await writeFile(join(dir, 'real', 'm.wonderdraft_map'), 'x');
    await symlink(join(dir, 'real'), join(dir, 'linked-folder'));
    await symlink(join(dir, 'real', 'm.wonderdraft_map'), join(dir, 'linked-file.wonderdraft_map'));
    expect(await findMapFiles(dir)).toEqual([join(dir, 'real', 'm.wonderdraft_map')]);
  });

  it('skips names that could break a one-path-per-line list', async () => {
    await writeFile(join(dir, 'ok.wonderdraft_map'), 'x');
    await writeFile(join(dir, 'bad\nname.wonderdraft_map'), 'x');
    await writeFile(join(dir, 'bad\rname.wonderdraft_map'), 'x');
    expect(await findMapFiles(dir)).toEqual([join(dir, 'ok.wonderdraft_map')]);
  });

  it('lists only regular files: a pipe named like a map would hang the gate, so it is left out', async () => {
    await writeFile(join(dir, 'real.wonderdraft_map'), 'x');
    execFileSync('mkfifo', [join(dir, 'pipe.wonderdraft_map')]);
    expect(await findMapFiles(dir)).toEqual([join(dir, 'real.wonderdraft_map')]);
  }, 5000);

  it('returns the list in plain path order, also where a folder and a file share a prefix', async () => {
    // The walk visits the folder `b` before the file `b.wonderdraft_map` (a shorter name sorts first), but as path
    // strings `b.wonderdraft_map` < `b/x.wonderdraft_map` ('.' is below '/'): only the final sort puts them right.
    await mkdir(join(dir, 'b'));
    await writeFile(join(dir, 'b', 'x.wonderdraft_map'), 'x');
    await writeFile(join(dir, 'b.wonderdraft_map'), 'x');
    await writeFile(join(dir, 'a.wonderdraft_map'), 'x');
    const found = await findMapFiles(dir);
    expect(found).toEqual([join(dir, 'a.wonderdraft_map'), join(dir, 'b.wonderdraft_map'), join(dir, 'b', 'x.wonderdraft_map')]);
    expect(found).toEqual([...found].sort());
  });

  it('returns an empty list for an empty folder, a missing folder and a file', async () => {
    expect(await findMapFiles(dir)).toEqual([]);
    expect(await findMapFiles(join(dir, 'does-not-exist'))).toEqual([]);
    await writeFile(join(dir, 'plain.wonderdraft_map'), 'x');
    expect(await findMapFiles(join(dir, 'plain.wonderdraft_map'))).toEqual([]);
  });
});

describe('parseMapRoots', () => {
  it('splits a PATH-style list, keeps spaces inside names and drops empty parts', () => {
    expect(parseMapRoots(undefined)).toEqual([]);
    expect(parseMapRoots('')).toEqual([]);
    expect(parseMapRoots('/a/b')).toEqual(['/a/b']);
    expect(parseMapRoots('/a b/c:/d e')).toEqual(['/a b/c', '/d e']);
    expect(parseMapRoots(':/a::/b:')).toEqual(['/a', '/b']);
  });
});

describe('findMapFilesIn', () => {
  it('joins several folders, lists a file once even when folders overlap, and tolerates a missing folder', async () => {
    await mkdir(join(dir, 'one', 'inner'), { recursive: true });
    await mkdir(join(dir, 'two'));
    await writeFile(join(dir, 'one', 'a.wonderdraft_map'), 'x');
    await writeFile(join(dir, 'one', 'inner', 'b.wonderdraft_map'), 'x');
    await writeFile(join(dir, 'two', 'c.wonderdraft_map'), 'x');
    const found = await findMapFilesIn([join(dir, 'two'), join(dir, 'one'), join(dir, 'one', 'inner'), join(dir, 'gone')]);
    expect(found).toEqual([join(dir, 'one', 'a.wonderdraft_map'), join(dir, 'one', 'inner', 'b.wonderdraft_map'), join(dir, 'two', 'c.wonderdraft_map')]);
  });
});

describe('runCorpusCheck through the real gate script on synthetic maps', () => {
  it('takes several folders and counts a map that appears in both once', async () => {
    await mkdir(join(dir, 'x'));
    await mkdir(join(dir, 'y'));
    await writeFile(join(dir, 'x', 'a.wonderdraft_map'), validMap());
    await writeFile(join(dir, 'y', 'a.wonderdraft_map'), validMap());
    await writeFile(join(dir, 'y', 'b.wonderdraft_map'), validMap());
    const report = await runCorpusCheck([join(dir, 'x'), join(dir, 'y')]);
    expect(report.reason).toBeNull();
    expect(report.listed).toBe(3);
    expect(report.maps).toBe(2);
    expect(report.identical).toBe(2);
  }, 60_000);

  it('passes valid maps and counts a repeated file (same name and size) once', async () => {
    await mkdir(join(dir, 'one'));
    await mkdir(join(dir, 'two'));
    await mkdir(join(dir, 'copy'));
    await writeFile(join(dir, 'one', 'a.wonderdraft_map'), validMap());
    await writeFile(join(dir, 'two', 'b.wonderdraft_map'), validMap());
    await writeFile(join(dir, 'copy', 'a.wonderdraft_map'), validMap());
    const report = await runCorpusCheck(dir);
    expect(report.reason).toBeNull();
    expect(report.ok).toBe(true);
    expect(report.maps).toBe(2);
    expect(report.identical).toBe(2);
    expect(report.issues).toBe(0);
    expect(report.pointsTexts).toBeGreaterThan(0);
    expect(report.pointsIdentical).toBe(report.pointsTexts);
    expect(report.files.map((f) => f.name).sort()).toEqual(['a.wonderdraft_map', 'b.wonderdraft_map']);
    expect(report.files.every((f) => f.verdict === 'IDENTICAL')).toBe(true);
  }, 60_000);

  it('fails for an empty folder without starting the gate', async () => {
    const report = await runCorpusCheck(dir);
    expect(report.ok).toBe(false);
    expect(report.reason).toMatch(/no .*map/i);
    expect(report.exitCode).toBeNull();
  });

  it('fails, with the exit status, when one map is damaged', async () => {
    await writeFile(join(dir, 'good.wonderdraft_map'), validMap());
    await writeFile(join(dir, 'zbad.wonderdraft_map'), validMap().slice(0, -20));
    const report = await runCorpusCheck(dir);
    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(1);
    expect(report.reason).toMatch(/exit/);
  }, 60_000);

  it('fails with a clear reason when the gate cannot finish in time', async () => {
    await writeFile(join(dir, 'good.wonderdraft_map'), validMap());
    const report = await runCorpusCheck(dir, { timeoutMs: 1 });
    expect(report.ok).toBe(false);
    expect(report.reason).toMatch(/did not finish|timed out|exit/);
  }, 60_000);
});
