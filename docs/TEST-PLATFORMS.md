# Unit-test host coverage

`npm test` runs the unit suites applicable to the current host. The policy is in
`tests/helpers/test-platform-suites.ts` and is checked by
`tests/unit/test-platform-suites.test.ts`.

| Host | Runs | Does not run |
| --- | --- | --- |
| Linux | Shared tests and Linux descriptor/file-system contracts | Windows-native selected-file, EXE reader, and junction-race tests |
| Windows | Shared tests and Windows-native selected-file, EXE reader, and junction-race tests | Linux descriptor/file-system and POSIX process/socket suites |
| Other | Shared tests | Both host-specific sets (no native reader backend verified) |

The test-runner serializes test **files** on every host because legacy
performance assertions use tight elapsed-time bounds. This avoids competing
filesystem/CPU tests generating unrelated timing failures. Vitest still runs
individual tests inside a file according to that file's own settings.

## Windows requirements

Use Node 22 and the Visual Studio C++ x64 build tools plus Windows SDK.
`npm test` invokes `scripts/prepare-unit-tests.mjs`, which rebuilds **both**
`georama-win-asset-read.exe` and `georama-win-selected-read.exe` from source.
A missing MSVC/SDK, failed build, or missing executable is a **test failure**,
never a skip. Native tests call `fs.access` in `beforeAll` and include an
adversarial junction-substitution regression. Focused `npx vitest` runs also
fail if the required helper is absent.

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

These exceptions are **file-granular**; they do not permit silently ignoring
failing Windows tests. Some excluded files still have shared assertions; the
five portable suites below recover explicit cross-platform coverage. A new
exclusion requires an actual platform assumption, not merely a CI failure.
The Linux `/proc/self/fd` PCK archive reader is not implemented on Windows;
the host-aware policy does not implement or claim Windows PCK support.

### Exactly which files are excluded, and why

| File in `tests/unit/` | Not run on | Required platform assumption |
| --- | --- | --- |
| `assets-config-strength.test.ts` | Windows | Unix home/root discovery and symlink path-security fixtures |
| `assets-config.test.ts` | Windows | XDG, `~/.wine`, Unix absolute roots and symlink discovery fixtures |
| `assets-open.test.ts` | Windows | Linux `/proc/self/fd`, `O_NOFOLLOW`, and FIFO descriptor reads |
| `assets-pck-file-strength.test.ts` | Windows | POSIX descriptor lifetime, filesystem metadata and PCK snapshot identity |
| `assets-pck-file.test.ts` | Windows | POSIX `O_NOFOLLOW` and FIFO descriptor behavior |
| `assets-store-strength.test.ts` | Windows | Linux PCK and descriptor-backed asset-store behavior; pure options extracted |
| `assets-store.test.ts` | Windows | Linux `/proc/self/fd` and FIFO-backed store sessions |
| `assets-symbol-store-strength.test.ts` | Windows | Linux PCK-backed symbol metadata and descriptor concurrency |
| `assets-symbol-store.test.ts` | Windows | Linux PCK descriptor and metadata source semantics |
| `assets-theme-store-strength.test.ts` | Windows | Linux PCK-backed theme read admission and descriptor lifecycle |
| `assets-theme-store.test.ts` | Windows | Linux PCK-backed theme metadata sources |
| `check-map-assets-cli.test.ts` | Windows | XDG config, Unix selected paths and Linux asset checker backend |
| `corpus-runner.test.ts` | Windows | POSIX symlink, FIFO and Unix corpus paths; pure verdicts extracted |
| `gl-runner-lifecycle.test.ts` | Windows | POSIX signals and process termination conventions |
| `launcher-display.test.ts` | Windows | Linux XDG/Wayland socket discovery and signal wiring |
| `map-asset-check-strength.test.ts` | Windows | Linux selected-file/asset backend and XDG configuration |
| `map-asset-check.test.ts` | Windows | Linux asset-check integration through selected file and PCK backends |
| `protocol.test.ts` | Windows | POSIX FIFO and symlink-resolved asset protocol fixtures |
| `selected-config-file-strength.test.ts` | Windows | POSIX selected-file close/path semantics; pure parsing extracted |
| `selected-config-file.test.ts` | Windows | POSIX `O_NOFOLLOW`, FIFO and symlink-selected JSON descriptors |
| `selected-data-file-strength.test.ts` | Windows | POSIX `O_NOFOLLOW` and selected-map close semantics |
| `selected-data-file.test.ts` | Windows | POSIX `O_NOFOLLOW`, FIFO and symlink-selected map descriptors |
| `windows-asset-races.test.ts` | Linux | Win32 HANDLE and NTFS junction/reparse race behavior |
| `windows-asset-reader.test.ts` | Linux | Compiled Windows reader, HANDLE, reparse and Win32 paths |
| `windows-selected-files.test.ts` | Linux | Compiled Windows selected-file reader and held HANDLE policy |

All other unit files run on both native platforms. `core-boundary.test.ts`
contains one **individual Windows skip**: symlink creation can require Windows
Developer Mode or elevated privileges. Native junction/reparse rejection is
tested in `windows-asset-races.test.ts`. The policy unit test requires that
every excluded filename appear explicitly in this documentation.

The shared `selected-config-errors-portable.test.ts` configures the real
selected-file helper on Windows and uses canonical temporary paths. It fails
if that helper is unavailable; decoder/parser assertions then run on bytes
returned by the actual host-specific reader. Linux uses held POSIX reads.

The Linux full-suite timing failures observed under file parallelism
initially reproduced green (163/163 across the four affected files) with
`--no-file-parallelism`. Another sparse-array test counted allocation/GC pauses
in its parser timing; it now constructs its fixture outside the timed section
and traps element access and enumeration, retaining a no-iteration guarantee.
This config runs files serially by default.

A newly created unit test is included on both platforms by default. Only add a
file to a host-specific exclusion after reviewing and documenting its actual
platform assumptions. Do not skip failing cross-platform regressions.

The shared `network.test.ts` mocks Electron's unused `session` export, and the
Linux launcher wiring unit test points Electron package resolution at a fake
distribution while its child-process spawn is mocked. Neither unit test needs
to download or execute the Electron runtime; actual Electron startup remains
in the separate E2E/packaged gates.

## Portable assertions moved out of Linux-only files

The following contracts are now tested on **both** hosts through explicit
`*-portable.test.ts` files. Their originals no longer duplicate those checks
in the Linux-only suite:

| Shared suite | Source previously excluded on Windows | Coverage |
| --- | --- | --- |
| `assets-config-parser-portable` | `assets-config.test.ts` | Native absolute-path policy, frozen JSON parsing, bad types/paths, proto-pollution, UTF-8 size cap and seeded fuzz |
| `assets-config-limits-portable` | `assets-config-strength.test.ts` | Exact config byte boundaries and maximum number of roots |
| `selected-config-errors-portable` | `selected-config-file-strength.test.ts` | Reader, decoder and parser error type/identity across actual selected JSON files |
| `corpus-verdict-portable` | `corpus-runner.test.ts` | Opaque corpus-output parsing and fail-closed pass/fail verdicts |
| `assets-store-options-portable` | `assets-store-strength.test.ts` | Frozen limits, cap validation before I/O, rejection of non-record options |

Host-specific files retain the filesystem traversal, POSIX symlink/FIFO,
Linux descriptor and backend-specific behaviors. The next useful splits are
`protocol.test.ts` (trusted app resources) and the selected asset file
readers, where semantics differ between Linux descriptor opens and native
Windows handles. Those require direct host validation, not merely moving tests.
