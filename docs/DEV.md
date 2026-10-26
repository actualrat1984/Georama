# Development

Gates run on Node 22: `.nvmrc` pins the version, and `typecheck`, `test`, `build`, `e2e`, `e2e:gl`, `e2e:compose` and `corpus` refuse any other major (`scripts/require-node-22.mjs`, run as a `pre` script). The `engines` range in `package.json` (^22.18, ^24, >=26) is the runtime range of the application, not the gate range. Native TypeScript execution is on by default from 22.18, and npm is required. Install the exact locked dependencies with `npm ci`.

- `npm run typecheck` — sequential strict checks of `tsconfig.core.json` (ES2022, no environment types), `tsconfig.renderer.json` (DOM, no Node types) and `tsconfig.node.json` (Node, no DOM) via `tsc -p`; any failed project fails the command.
- `npm test` — Node-environment Vitest unit tests, including compiler ambient-global/closed-world gates, esbuild runtime-import gates and text rules for the portable core, with positive and negative fixtures.
- `npm run build` — typecheck, bundle main/preload with esbuild, build the renderer with Vite.
- `npm run app` — rebuild main/renderer and open the app. Set `GEORAMA_DEVTOOLS=1` only for local debugging.
- `npm run e2e` — build and run the real hidden Electron CDP smoke test. The test alone passes loopback inspector flags and uses a temporary user-data directory under `os.tmpdir()` (honouring `TMPDIR`). It verifies runtime hardening; external navigation, `window.open` and `target=_blank` links are attempted against a loopback HTTP server that must see zero requests, so no test depends on the public internet. On exit, SIGINT, SIGTERM and SIGHUP it terminates the launcher's whole process group (observing that the group is gone) and removes the temporary data. `node tests/e2e/cleanup.mjs` proves this by sending each of those three signals to a running smoke test and scanning `/proc` for leftovers; it starts the hidden app three times and takes about a minute.

The launcher uses Electron from the local dependency and resolves the display with the pure function `resolveDisplayEnv` in `scripts/display-env.mjs`. A set `WAYLAND_DISPLAY` is kept; if its socket exists (an absolute value is used as is, a relative one is joined to `XDG_RUNTIME_DIR`, or to `/run/user/<uid>` when that is unset) the launcher adds `--ozone-platform=wayland`, otherwise the existing display configuration passes through untouched. If it is absent, the lowest-numbered `wayland-<n>` socket is taken from the inherited `XDG_RUNTIME_DIR` first, then from `/run/user/<uid>`. A socket in the inherited directory (or with no `XDG_RUNTIME_DIR` set) sets `WAYLAND_DISPLAY=wayland-<n>` and the matching `XDG_RUNTIME_DIR`; a socket found only in the fallback directory while a different `XDG_RUNTIME_DIR` is set is passed as an absolute path and the inherited directory is left alone, so the launcher never emits a relative name that disagrees with the runtime directory. With no socket the environment is not changed and no flag is added. Extra CLI arguments and SIGINT, SIGTERM and SIGHUP are forwarded. The launcher is Linux-only: it calls `process.getuid()` and looks for Wayland sockets under `/run/user/<uid>`.


## Native Windows selected files and path discovery (phase 1)

This step intentionally separates **directly selected files** from **root-confined community asset packs**. On Windows, Georama can validate native `C:\\...` paths, read selected `.json` / `.wonderdraft_map` data through a held file handle with the existing byte caps and change-detection checks, parse Windows config paths, and discover configured or conventional Wonderdraft directories (`ProgramFiles`, `ProgramFiles(x86)`, `APPDATA`, user home). Root scanning accepts canonical drive paths with the existing depth and entry budgets.

The Windows path policy currently accepts only **normalized, fully drive-qualified paths**. UNC shares, device/verbatim prefixes, drive-relative paths, alternate data streams, reserved device names, dot/dotdot segments, and trailing dot/space components are intentionally rejected. The POSIX path contract and Linux discovery remain unchanged.

**Security limit:** Windows selected-file symlink-leaf checks use a preliminary `lstat`, which is not an atomic no-follow open. Unlike the Linux `O_NOFOLLOW` behavior, a concurrent local actor could replace the leaf between check and open. This API is for an explicitly selected trusted local path, and must not be exposed as an arbitrary renderer-chosen filesystem read capability. File reads still use a single held handle after opening, with size limits, bounded read loops and held-file metadata checks. Device/UNC paths are out of scope until separately reviewed.

**Phase 2 (experimental): Windows asset file reads.** `readAssetFile()` can now use a native Windows helper to read files beneath an explicit root. `openPckFile()` remains Linux-only. A missing native helper fails closed rather than falling back to unsafe joined-path JavaScript reads. Windows asset loading does not work in packaged releases until the executable is bundled and authenticated; root discovery does not create a renderer IPC read capability.

Windows Node 22 checks:

```powershell
npm run build
npx vitest run tests/unit/native-path.test.ts tests/unit/windows-selected-files.test.ts
```

Linux regression checks are in `.github/workflows/windows-file-paths.yml` together with the Windows build and native-file tests. This phase does not claim that the Linux-specific full unit suite is green on Windows or that the application now loads Wonderdraft assets natively.


## Native Windows secure asset reader (phase 2 — experimental)

Windows user asset files now use an optional dedicated C++17 executable, not the Linux /proc/self/fd backend and not a JavaScript lstat/open preflight. The helper uses Win32 CreateFileW with FILE_FLAG_OPEN_REPARSE_POINT and keeps open directory/file handles without FILE_SHARE_DELETE. Each opened object is checked for a reparse point and its final DOS name is compared against its held parent. Only data verified through bounded reads and before/after metadata is emitted. Errors contain no user paths; Linux behavior remains unchanged.

Build prerequisite: install Visual Studio 2022 C++ Build Tools (MSVC x64) **and the Windows 10/11 SDK** using the *Desktop development with C++* workload. Finding `cl.exe` on `PATH` is not sufficient: `INCLUDE` and `LIB` must point to both the SDK and MSVC standard headers/libraries. The build script checks these directories and, if necessary, uses `vswhere` + `vcvars64.bat` to initialize the complete environment automatically—even when an uninitialized `cl.exe` is already on `PATH`. If that fails, install/repair the SDK from Visual Studio Installer or build in an *x64 Native Tools Command Prompt*. Output resides in the git-ignored `out/windows` directory.

Run on Windows (Node 22, after npm ci):

~~~powershell
node scripts/build-win-asset-helper.mjs
npm run build
npx vitest run tests/unit/msvc-environment.test.ts tests/unit/windows-asset-bridge.test.ts tests/unit/windows-asset-reader.test.ts tests/unit/windows-asset-races.test.ts tests/unit/windows-selected-files.test.ts tests/unit/native-path.test.ts
~~~

The Windows tests require a compiled helper; missing helper is a failing test, not a skip. The CI workflow builds it and exercises real junctions, path refusal, size limits, handle release and concurrent directory replacement. Linux CI runs the original asset tests.

Limits: this is an experimental design pending native CI and independent security review, not a proof across every Windows filesystem/filter driver. The backend spawns a process per asset and now enforces a four-helper concurrency budget, bounded stdout, a 60-second deadline and a three-second post-termination grace. A child that fails to close retains its slot (fail closed). The helper location is bound once to the trusted Electron application root (`app.getAppPath()`), with the developer executable under `out/windows`; it is not resolved from the process working directory. It is not yet production-packaged or authenticated. Root symlinks, UNC/network shares, native PCK archives, stronger packaging/authenticity checks and performance tuning are separate phases. Directly selected map/config files keep their separate security policy.

## Layout

- `electron/` — sandboxed application shell, custom protocol, narrow IPC, preload bridge.
- `src/shared/` — brand constants and IPC types shared by main and renderer.
- `src/core/` — environment-agnostic algorithms, `Uint8Array` in/out; compiler-isolated together with `src/shared/`, with no Node/Electron/DOM ambient types or foreign imports.
- `tsconfig.base.json` — shared strict/erasable-syntax conventions; `tsconfig.json` is the editor-only solution entry with references and no catch-all source globs. The core, renderer and Node projects check their respective environments; shared/core code is also checked in both consumers.
- `types/portable-globals.d.ts` — core-only ambient allow-list, outside all project include globs; renderer and Node use their native declarations instead.
- `tests/fixtures/core-boundary/` — explicit gate controls, excluded from every real TypeScript project; tests create disposable fixture projects under `os.tmpdir()`.
- `src/renderer/` — Preact UI; local external CSS only, no network fonts or inline styles.
- `tests/unit/`, `tests/e2e/` — pure unit tests and the real Electron smoke test.
- `scripts/` — esbuild entry point and Wayland-aware launcher.

To rename the app, start with `src/shared/brand.ts` and `package.json` (`name`, `productName`); keep the HTML title and smoke-test expectations in sync. The technical ID determines the user-data directory (normally `~/.config/georama`), not the display name. Regenerate the lockfile after package metadata changes.

## Code conventions

- **Erasable TypeScript only** (`erasableSyntaxOnly`): no `enum`, `namespace` or constructor parameter properties; declare fields explicitly. Node can then run `.ts` files directly: `node scripts/tool.ts`.
- **Relative imports end in `.ts`** (`import { x } from './x.ts'`) and types are imported with `import type` (`verbatimModuleSyntax`). The portable-core runtime-import gate enforces the `.ts` extension and rejects external imports and relative escapes; the compiler still accepts extensionless imports elsewhere.
- **`src/core` and `src/shared` are environment-agnostic**: `Uint8Array`/`DataView` in and out, no Node, Electron or DOM APIs. They must run unchanged in the renderer, a Web Worker and a future Node CLI. Core compiles with ES2022 and `types: []`; its closed-world gate admits only core/shared source, the portable allow-list and the compiler's own `lib.*.d.ts` files. The renderer's closed-world gate rejects Node/Electron declarations, including those pulled in by type-only imports. Literal runtime imports are checked through esbuild metafiles; non-literal dynamic imports (including interpolated templates) and triple-slash reference directives are forbidden by a comment-aware lexical gate.
- **Portable globals are an explicit allow-list**: `TextDecoder` and `TextEncoder` are the only additions to ES2022, for portable byte/text codecs. A global may be added only if its API exists identically in browsers, Web Workers and Node >= 22. Propose the shared API shape and portability evidence in review, add it to `types/portable-globals.d.ts`, document the addition and rationale here, and extend the positive/negative gate fixtures. Do not add DOM/Node libraries or ambient packages to make core compile.
- **Gate rules that close self-declared globals** (enforced by `npm test`, each with committed negative fixtures and a clean positive control): (1) `src/core` and `src/shared` hold plain `.ts` files only, with no `.d.ts`, `.tsx`, `.mts`, scripts, data or symlinks, and the one ambient file, `types/portable-globals.d.ts`, is pinned to exactly `TextDecoder` and `TextEncoder`; (2) no `declare <keyword>` at any depth or indentation and no `namespace`/`module` block, because a self-declared `process` or `window` makes the compiler's missing-name error disappear, and `moduleDetection: force` stops a script file's top-level `var` from becoming a global; (3) no `@ts-ignore`, `@ts-nocheck` or `@ts-expect-error`, comments included; (4) no `globalThis` and no `eval` in code, and none of the dynamic-code constructors: the identifiers `Function`, `AsyncFunction`, `GeneratorFunction` and `AsyncGeneratorFunction` are banned in every position, types included (write a specific function type such as `(x: number) => number`), and so is reaching them through `.constructor` member access (optional chains included), a `{ constructor }` or `{ constructor: F }` destructuring pattern, or the string key `'constructor'`. The gate parses each file with Vite's public `parseAst` and walks the AST: identifier names and string values arrive decoded, so unicode, hex and line-continuation escapes cannot hide a banned word, and regex literals parse as regexes, so a quote can no longer desync the scan and blind the later rules; a file that does not parse is itself a violation, fail-closed. The same words inside comments, strings, templates and regexes are fine, and so are a class `constructor(` definition, a parameter or variable called `constructor`, an object-literal key called `constructor`, and a property called `Function` on another object. A member that merely carries one of the names is a name, not a reference, and is fine in every declaration form (class, abstract class, interface, type literal, object literal, enum member, label, right side of a qualified type name); a computed key, a shorthand `{ Function }` and a binding are references and are flagged. `tests/helpers/core-gate-forms.ts` is the table of those positions, one row per position with its exact verdict: add a row there when a new position is found, and check the verdict against this policy before recording it. A source nested absurdly deep breaks the gate loudly, never silently: measured with Node 22 here, a thousand levels are fine, two thousand or more overflow the recursive walk on the main thread (a RangeError, so the test run fails), and eight thousand (three thousand inside a worker thread, so `--pool=threads` is hit first) abort the native parser and crash the process. The gate is dev-only and `vite` is not imported by any runtime code. The gate is a regression guard against accidental dependencies, not a sandbox: a key computed at run time (`'const' + 'ructor'`) cannot be decided statically, and at run time the CSP has no `unsafe-eval`, so dynamic code fails closed in the renderer as well.
- **Worker configuration is deferred**: `tsconfig.worker.json` (`lib: ["ES2022", "WebWorker"]`, `types: []`) arrives with the first worker entry file.
- Tooling note: TypeScript is 7.x (native compiler); the `typescript` package has no JS API, so tests must not import it. Use the `tsc` CLI or esbuild.
- Git worktrees share `node_modules` through a symlink; `.gitignore` lists `node_modules` without a trailing slash so the symlink is ignored too.

