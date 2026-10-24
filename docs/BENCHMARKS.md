# Reproducible core codec benchmarks

The standalone `scripts/benchmark-core.ts` compares the performance of Georama's
**existing** core codecs using generated, deterministic inputs. No Wonderdraft
installation, personal `.wonderdraft_map` files, proprietary textures or GPU are
required. It is an **observational tool**, not a correctness or performance gate.

Run with the project's supported verification environment, **Node 22**:

```sh
node scripts/benchmark-core.ts
node scripts/benchmark-core.ts --json --runs 11 --warmup 3
```

`--runs` accepts 1–30 measured iterations (default 7); `--warmup` accepts
0–20 untimed iterations (default 2). `--help` prints the accepted CLI syntax.
`--json` prints exactly one report object to stdout, suitable for storing and
comparing runs. Errors are written to stderr, with exit code 2 for bad CLI
arguments and 1 if input verification or benchmarking fails.

## Workload definitions

| Name | Input | Reported logical bytes |
| --- | --- | --- |
| `gcpf-encode` | 256 KiB seeded mixture of repetitive bytes and noise | Uncompressed payload |
| `gcpf-decode` | Encoded version of that same payload | Uncompressed payload |
| `variant-encode` | Invented nested Godot dictionaries containing 48 synthetic map records | Serialized message size |
| `variant-decode` | Encoded version of that Godot message | Serialized message size |
| `png-decode` | Independently generated 256×256 RGBA8 PNG with three IDAT chunks | RGBA output size |
| `points-parse` | Text encoding 2,048 invented Vector2 points | UTF-8 text size |
| `points-format` | The same 2,048 points as a Float32Array | Resulting UTF-8 text size |

The PNG intentionally has all-zero pixels: this measures a **highly compressible**
image rather than a representative asset texture. The Godot workload is an
artificially repeated model, not a realistic distribution of map contents.
No benchmark result is claimed to predict application frame rate or throughput
for real-world maps.

## What the measurements mean

- Input generation, serialization needed to prepare inputs, hashing and
  correctness checks happen **outside** each measured interval.
- Each run performs the full operation once. The JSON report contains raw
  `samplesMs`, `minMs`, `medianMs`, `maxMs`, `mibPerSecond`, `workBytes` and
  `fixtureSha256` for every workload.
- Median is the midpoint of sorted observations (arithmetic midpoint for an
  even count). Throughput is `logical MiB / median seconds`; the logical byte
  definition differs by workload, so do **not** compare throughput between
  different codecs as though they perform equivalent work.
- Garbage collection, JIT optimization, CPU scaling and concurrent system
  activity are not controlled. Memory use is **not** measured or bounded.
  No artificial speed threshold is enforced.
- Compare the **same workload**, Node version, machine and fixture fingerprint
  before/after a code change, ideally across several separate process runs.
  The fingerprints identify the generated inputs; they are not a promise that
  every future Node/zlib version generates byte-identical compressed fixtures.
- The standalone test `tests/unit/benchmark-core-cli.test.ts` checks the command
  contract, statistics and one complete one-run JSON smoke test without
  asserting wall-clock performance.

JSON schema version 1 includes `node`, `platform`, `arch`, the effective options
and the seven results. It does not emit filenames, machine usernames, map data
or host-identifying paths.
