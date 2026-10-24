import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  measureCase, parseBenchmarkArgs, summarizeSamples,
} from '../../scripts/benchmark-core.ts';

const execFileAsync = promisify(execFile);

describe('benchmark-core argument contract', () => {
  it('uses bounded defaults and accepts explicit JSON, run and warmup options', () => {
    expect(parseBenchmarkArgs([])).toEqual({ runs: 7, warmup: 2, json: false });
    expect(parseBenchmarkArgs(['--json', '--runs', '3', '--warmup', '0']))
      .toEqual({ runs: 3, warmup: 0, json: true });
    expect(parseBenchmarkArgs(['--help'])).toEqual({ help: true });
  });

  it.each([
    ['--unknown'], ['--runs'], ['--warmup'], ['--runs', '0'],
    ['--runs', '31'], ['--runs', 'NaN'], ['--runs', '2.5'], ['--runs', '-1'],
    ['--warmup', '21'], ['--warmup', 'Infinity'], ['--warmup', '01'],
    ['--json', '--json'], ['--runs', '2', '--runs', '3'],
    ['--help', '--json'], ['--runs', '1', 'extra'],
  ])('rejects bad invocation %j', (...args) => {
    expect(() => parseBenchmarkArgs(args)).toThrow();
  });
});

describe('benchmark-core measurements', () => {
  it('computes even/odd medians and byte-normalized throughput without fixed speed thresholds', () => {
    expect(summarizeSamples([6, 2, 4], 1024 * 1024)).toEqual({
      medianMs: 4, minMs: 2, maxMs: 6, mibPerSecond: 250,
    });
    expect(summarizeSamples([5, 3, 2, 8], 512 * 1024)).toEqual({
      medianMs: 4, minMs: 2, maxMs: 8, mibPerSecond: 125,
    });
  });

  it('rejects nonpositive or nonfinite timing samples and invalid byte counts', () => {
    for (const samples of [[], [0], [-1, 2], [NaN], [Infinity]]) {
      expect(() => summarizeSamples(samples, 1)).toThrow(RangeError);
    }
    for (const count of [-1, 0, 1.5, Infinity]) {
      expect(() => summarizeSamples([1], count)).toThrow(RangeError);
    }
  });

  it('runs setup checks outside the timed loop and measures precisely the requested runs', () => {
    let calls = 0;
    let checks = 0;
    const result = measureCase({
      name: 'synthetic-control', workBytes: 1048576, fixtureSha256: 'control',
      run: () => {
        // Enough work to exceed coarse Windows clock granularity.
        let accumulator = 0;
        for (let i = 0; i < 10000; i++) accumulator += i & 7;
        expect(accumulator).toBe(35000);
        return ++calls;
      },
      check: (value) => { expect(value).toBe(calls); checks++; },
    }, { runs: 3, warmup: 2, json: false });
    expect(calls).toBe(6); // initial check + two warmups + three samples
    expect(checks).toBe(2); // initial and final checks only
    expect(result.samplesMs).toHaveLength(3);
    expect(result.medianMs).toBeGreaterThan(0);
    expect(result.mibPerSecond).toBeGreaterThan(0);
  });
});

describe('benchmark-core standalone CLI', () => {
  async function cli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, ['scripts/benchmark-core.ts', ...args], {
        cwd: process.cwd(), timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
      });
      return { stdout, stderr, code: 0 };
    } catch (error) {
      const e = error as { code?: number; stdout?: string; stderr?: string };
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: typeof e.code === 'number' ? e.code : 1 };
    }
  }

  it('supports --help and refuses malformed flags before preparing fixtures', async () => {
    const help = await cli(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('--json');
    const invalid = await cli(['--runs', '0']);
    expect(invalid.code).toBe(2);
    expect(invalid.stdout).toBe('');
    expect(invalid.stderr).toContain('--runs');
  });

  it('emits one valid JSON report with all seven codecs and no private paths', async () => {
    const res = await cli(['--runs', '1', '--warmup', '0', '--json']);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout.trim().split('\n')).toHaveLength(1);
    const report = JSON.parse(res.stdout) as {
      schemaVersion: number;
      options: { runs: number; warmup: number; json: boolean };
      results: Array<{
        name: string; workBytes: number; fixtureSha256: string;
        samplesMs: number[]; medianMs: number; mibPerSecond: number;
      }>;
    };
    expect(report.schemaVersion).toBe(1);
    expect(report.options).toEqual({ runs: 1, warmup: 0, json: true });
    expect(report.results.map((r) => r.name)).toEqual([
      'gcpf-encode', 'gcpf-decode', 'variant-encode', 'variant-decode',
      'png-decode', 'points-parse', 'points-format',
    ]);
    for (const result of report.results) {
      expect(result.workBytes).toBeGreaterThan(0);
      expect(result.fixtureSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.samplesMs).toHaveLength(1);
      expect(result.medianMs).toBeGreaterThan(0);
      expect(result.mibPerSecond).toBeGreaterThan(0);
    }
    expect(res.stdout).not.toContain(process.cwd());
  }, 65_000);
});
