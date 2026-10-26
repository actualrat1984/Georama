# Unit-test host coverage

`npm test` runs the unit suites applicable to the current host. The policy is in
`tests/helpers/test-platform-suites.ts` and is checked by
`tests/unit/test-platform-suites.test.ts`.

| Host | Runs | Does not run |
| --- | --- | --- |
| Linux | Shared tests and Linux descriptor/file-system contracts | Windows-native selected-file, EXE reader, and junction-race tests |
| Windows | Shared tests and Windows-native selected-file, EXE reader, and junction-race tests | Linux descriptor/file-system and POSIX process/socket suites |
| Other | Only tests not assigned to Linux or Windows | Both host-specific sets (no native reader backend verified) |

The test-runner serializes test **files** on every host because legacy
performance assertions use tight elapsed-time bounds. This avoids competing
filesystem/CPU tests generating unrelated timing failures. Vitest still runs
individual tests inside a file according to that file's own settings.

## Windows requirements

Use Node 22 and the Visual Studio C++ x64 build tools plus Windows SDK.
`npm test` invokes `scripts/build-win-asset-helper.mjs` before running tests,
so native security tests always use the freshly built helper. A missing MSVC/SDK
or failing native compile is a **test failure**, not a skip. The native reader
tests include an adversarial junction-substitution regression.

```powershell
cd E:\Georama
npm ci
npm run build
npm test
```

## Linux requirements

```bash
cd ~/georama-linux
npm ci
npm run build
npm test
```

The Electron E2E tests remain separate (`npm run e2e`); this policy does not
affect the corpus gate (`npm run corpus`), the GPU gate, or focused
`npx vitest run path/to/test.ts` invocations.

## Deliberate limitations and review policy

The Linux-only list is **file-granular**. Some listed files also have
platform-neutral subtests, but those are not currently exercised on Windows.
They were classified by documented Linux descriptor/POSIX contracts and the
2026-10-26 Windows full-suite failure investigation. Follow-up work should
split shared assertions into new portable files and implement Windows-native
parity checks for the security properties, not simply move names out of the
exclude list. In particular, the Linux `/proc/self/fd` PCK archive reader is
not implemented for Windows; a test-filter change does not imply support.

The Linux full-suite timing failures observed under file parallelism
initially reproduced green (163/163 across the four affected files) with
`--no-file-parallelism`. A subsequent serial full-suite run exposed one
additional 213 ms versus 200 ms assertion: the oversized sparse-array test
counted allocation/GC pauses in its parser timing. That test now constructs
its fixture outside the timed section and also traps element access and
enumeration, retaining an explicit no-iteration guarantee. This config runs
files serially by default.

A newly created unit test is included on both platforms by default. Only add a
file to a host-specific exclusion after reviewing and documenting its actual
platform assumptions. Do not skip failing cross-platform regressions.
