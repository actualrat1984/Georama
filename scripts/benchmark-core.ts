/**
 * Reproducible, synthetic-only throughput measurements for existing core codecs.
 * Input creation and correctness checks are excluded from the timed regions.
 * No performance threshold is enforced: wall time depends on the host machine.
 *
 * Usage: node scripts/benchmark-core.ts [--json] [--runs N] [--warmup N]
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { decodePngRgba8 } from '../src/core/assets/png-pixels.ts';
import { decodeGcpf, encodeGcpf } from '../src/core/formats/gcpf.ts';
import { GdDict, decodeStoreVar, encodeStoreVar } from '../src/core/formats/godot-var.ts';
import { formatPoints, parsePoints } from '../src/core/formats/wonderdraft-points.ts';
import { makePng } from '../tests/helpers/pck-synthetic.ts';
import { makeSyntheticRoot } from '../tests/helpers/wd-synthetic.ts';

export interface BenchmarkOptions {
  readonly runs: number;
  readonly warmup: number;
  readonly json: boolean;
}

export interface BenchmarkResult {
  readonly name: string;
  /** Uncompressed payload, serialized message, RGBA output or points text bytes. */
  readonly workBytes: number;
  readonly fixtureSha256: string;
  readonly samplesMs: readonly number[];
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly mibPerSecond: number;
}

export interface BenchmarkReport {
  readonly schemaVersion: 1;
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
  readonly options: BenchmarkOptions;
  readonly results: readonly BenchmarkResult[];
}

export interface BenchmarkCase {
  readonly name: string;
  readonly workBytes: number;
  readonly fixtureSha256: string;
  readonly run: () => unknown;
  /** Called outside the timer before warmup and after the final measured iteration. */
  readonly check: (result: unknown) => void;
}

export function parseBenchmarkArgs(args: readonly string[]): BenchmarkOptions | { readonly help: true } {
  let runs = 7;
  let warmup = 2;
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help') {
      if (args.length !== 1) throw new Error('--help cannot be combined with other arguments');
      return { help: true };
    }
    if (flag !== '--json' && flag !== '--runs' && flag !== '--warmup') {
      throw new Error(`unknown argument: ${String(flag)}`);
    }
    if (seen.has(flag)) throw new Error(`duplicate argument: ${flag}`);
    seen.add(flag);
    if (flag === '--json') {
      json = true;
      continue;
    }
    const value = args[++i];
    if (value === undefined || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
      throw new Error(`${flag} requires a nonnegative decimal integer`);
    }
    const n = Number(value);
    if (flag === '--runs') {
      if (!Number.isSafeInteger(n) || n < 1 || n > 30) throw new Error('--runs must be in 1..30');
      runs = n;
    } else {
      if (!Number.isSafeInteger(n) || n > 20) throw new Error('--warmup must be in 0..20');
      warmup = n;
    }
  }
  return { runs, warmup, json };
}

/** Pure statistics, intentionally without pass/fail thresholds. */
export function summarizeSamples(samplesMs: readonly number[], workBytes: number): {
  medianMs: number; minMs: number; maxMs: number; mibPerSecond: number;
} {
  if (samplesMs.length === 0 || samplesMs.some((n) => !Number.isFinite(n) || n <= 0)) {
    throw new RangeError('samples must be nonempty, finite positive milliseconds');
  }
  if (!Number.isSafeInteger(workBytes) || workBytes <= 0) {
    throw new RangeError('workBytes must be a positive safe integer');
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    medianMs,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    mibPerSecond: (workBytes / 1048576) / (medianMs / 1000),
  };
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const asBytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * All inputs are invented and deterministic. No installed Wonderdraft assets,
 * personal map files or private corpus are accessed.
 */
export function makeBenchmarkCases(): readonly BenchmarkCase[] {
  const payload = new Uint8Array(256 * 1024);
  // Mix repeated motifs and seeded noise; never depend on Math.random().
  let state = 0x1a2b3c4d;
  for (let i = 0; i < payload.length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    payload[i] = (i % 256 < 192) ? ((i >>> 4) & 0xff) : (state & 0xff);
  }
  const compressed = encodeGcpf(payload);
  const gcpfInputHash = sha256(payload);
  const gcpfWireHash = sha256(compressed);

  const root = new GdDict([
    ['version', 1n],
    ['maps', Array.from({ length: 48 }, () => makeSyntheticRoot())],
  ]);
  const variant = encodeStoreVar(root);
  const variantHash = sha256(variant);

  // The PNG is constructed with Node zlib (not Georama's PNG decoder).
  // RGBA8, 256x256, all-zero pixels: a defined highly-compressible workload.
  const png = makePng({ width: 256, height: 256, colorType: 6, bitDepth: 8, idatChunks: 3 });
  const pngHash = sha256(png);

  const coords = new Float32Array(4096);
  for (let i = 0; i < coords.length; i++) coords[i] = i % 2 === 0 ? i / 4 : -(i % 1024) / 8;
  const pointText = formatPoints(coords);
  const pointBytes = asBytes(pointText);
  const pointHash = sha256(pointBytes);

  return [
    {
      name: 'gcpf-encode', workBytes: payload.length, fixtureSha256: gcpfInputHash,
      run: () => encodeGcpf(payload),
      check: (output) => {
        assert.ok(output instanceof Uint8Array);
        assert.deepEqual(output, compressed);
      },
    },
    {
      name: 'gcpf-decode', workBytes: payload.length, fixtureSha256: gcpfWireHash,
      run: () => decodeGcpf(compressed),
      check: (output) => {
        assert.ok(output && typeof output === 'object' && 'payload' in output);
        assert.deepEqual(output.payload, payload);
      },
    },
    {
      name: 'variant-encode', workBytes: variant.length, fixtureSha256: variantHash,
      run: () => encodeStoreVar(root),
      check: (output) => {
        assert.ok(output instanceof Uint8Array);
        assert.deepEqual(output, variant);
      },
    },
    {
      name: 'variant-decode', workBytes: variant.length, fixtureSha256: variantHash,
      run: () => decodeStoreVar(variant),
      check: (output) => {
        assert.ok(output instanceof GdDict);
        assert.equal((output.get('maps') as unknown[]).length, 48);
      },
    },
    {
      name: 'png-decode', workBytes: 256 * 256 * 4, fixtureSha256: pngHash,
      run: () => decodePngRgba8(png),
      check: (output) => {
        assert.ok(output && typeof output === 'object' && 'rgba' in output);
        const decoded = output as { width: number; height: number; rgba: Uint8Array };
        assert.equal(decoded.width, 256);
        assert.equal(decoded.height, 256);
        assert.equal(decoded.rgba.length, 256 * 256 * 4);
        assert.ok(decoded.rgba.every((byte) => byte === 0));
      },
    },
    {
      name: 'points-parse', workBytes: pointBytes.length, fixtureSha256: pointHash,
      run: () => parsePoints(pointText),
      check: (output) => {
        assert.ok(output instanceof Float32Array);
        assert.deepEqual(output, coords);
      },
    },
    {
      name: 'points-format', workBytes: pointBytes.length, fixtureSha256: pointHash,
      run: () => formatPoints(coords),
      check: (output) => assert.equal(output, pointText),
    },
  ];
}

export function measureCase(item: BenchmarkCase, options: BenchmarkOptions): BenchmarkResult {
  if (!Number.isSafeInteger(options.runs) || options.runs < 1 || options.runs > 30 ||
      !Number.isSafeInteger(options.warmup) || options.warmup < 0 || options.warmup > 20) {
    throw new RangeError('invalid benchmark iteration counts');
  }
  item.check(item.run());
  for (let i = 0; i < options.warmup; i++) item.run();
  const samples: number[] = [];
  let last: unknown;
  for (let i = 0; i < options.runs; i++) {
    const start = performance.now();
    last = item.run();
    samples.push(performance.now() - start);
  }
  item.check(last);
  const stats = summarizeSamples(samples, item.workBytes);
  return { name: item.name, workBytes: item.workBytes, fixtureSha256: item.fixtureSha256,
    samplesMs: samples, ...stats };
}

export function runBenchmarks(options: BenchmarkOptions, cases = makeBenchmarkCases()): BenchmarkReport {
  return {
    schemaVersion: 1,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    options,
    results: cases.map((item) => measureCase(item, options)),
  };
}

function printUsage(): void {
  console.log('Usage: node scripts/benchmark-core.ts [--json] [--runs N] [--warmup N]');
  console.log('N: --runs 1..30 (default 7), --warmup 0..20 (default 2).');
  console.log('Inputs are fixed synthetic fixtures; throughput uses logical bytes and MiB/s.');
}

function printText(report: BenchmarkReport): void {
  console.log(`Georama core codec benchmarks | Node ${report.node} | ${report.platform}/${report.arch}`);
  console.log(`Warmup ${report.options.warmup}, measured runs ${report.options.runs}; setup and checks excluded.`);
  console.log('Workload          KiB logical    median ms      min ms      max ms     MiB/s');
  for (const item of report.results) {
    const fmt = (n: number, width: number): string => n.toFixed(3).padStart(width);
    console.log(`${item.name.padEnd(18)}${fmt(item.workBytes / 1024, 11)}${fmt(item.medianMs, 13)}` +
      `${fmt(item.minMs, 12)}${fmt(item.maxMs, 12)}${fmt(item.mibPerSecond, 10)}`);
  }
  console.log('Results depend on the machine, Node version, GC and system load; no pass/fail thresholds.');
}

export function main(args: readonly string[]): number {
  let options: BenchmarkOptions | { readonly help: true };
  try {
    options = parseBenchmarkArgs(args);
  } catch (error) {
    console.error(`benchmark-core: ${error instanceof Error ? error.message : String(error)}`);
    console.error('Run with --help for usage.');
    return 2;
  }
  if ('help' in options) {
    printUsage();
    return 0;
  }
  try {
    const report = runBenchmarks(options);
    if (options.json) console.log(JSON.stringify(report));
    else printText(report);
    return 0;
  } catch (error) {
    console.error(`benchmark-core: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
