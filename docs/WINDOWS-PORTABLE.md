# Experimental Windows portable package

This branch is stacked on the native Windows asset-reader work. It builds an
**unsigned developer preview**, not a signed release, trusted download or installer.
The **Electron bundle and both native helper executables are unsigned**. Nothing
here establishes publisher authenticity or grants permission to distribute a
release; Authenticode signing and release/security review are still required.

## Build (Windows x64)

Prerequisites: Node 22, `npm ci`, Visual Studio 2022 C++ Build Tools + Windows
SDK. The native helper build scripts locate and initialize MSVC as needed.

```powershell
npm ci
npm run package:win:portable
```

The command compiles the two native helpers, rebuilds the main and renderer bundles,
copies the installed pinned Electron 44.9.3 distribution, and creates a fresh
`out/portable/georama-win-x64-<unique>` directory plus an adjacent ZIP. Existing
packages are never overwritten or recursively deleted.

Extract the ZIP as a **whole directory** and run `electron.exe`. The unbranded
executable name is intentional for this experimental stage.

The application layout follows Electron's manual packaging convention:

```text
electron.exe
resources/
  app/
    package.json
    dist-electron/main.cjs
    dist-electron/preload.cjs
    dist/renderer/
    out/windows/georama-win-asset-read.exe
    out/windows/georama-win-selected-read.exe
georama-manifest.json
```

Both helpers are real executables beneath the physically unpacked
`resources/app/out/windows/` directory, not members of `app.asar`, and remain
anchored to `app.getAppPath()` rather than the launch working directory. #24
also supports an `app.asar` app by resolving its helper to adjacent
`app.asar.unpacked`; this **developer preview uses `resources/app`**, not
`app.asar`. The package copies no repository .git tree, private map files,
external assets, or development node_modules.

## Verification

After extracting, supply the **absolute** package directory:

```powershell
node scripts/verify-win-portable.mjs "E:\path\to\georama-win-x64-..."
```

The verifier compares hashes of Electron, the main bundle, renderer entry page
and **both unsigned native helpers** against `georama-manifest.json`. The
manifest declares `kind: unsigned-developer-preview` and `authenticated: false`.
A clean result means only
that the checked files match that manifest; **the manifest is not signed**.
An attacker who can alter both payloads and manifest can evade this check, and
the check is not atomic with subsequent executable launch. Do not present this
as authenticated production distribution.

The hosted Windows acceptance workflow tests both the newly staged folder and
a freshly extracted ZIP: it verifies hashes, launches the hidden packaged
Electron window from an unrelated working directory, checks its trusted preload
API, and executes both **physically packaged** native helpers against synthetic
files, including a traversal refusal. This is an unsigned developer-preview
smoke test, **not a release gate** or proof of helper authenticity. The
`BUSY` (four occupied native asset slots) and `TIMEOUT` (60 s deadline)
result codes are inherited from #24's bounded bridge and tested there. Four
children that never close can leave all direct reads at `BUSY` until restart.
No new asset IPC is enabled here; an actual packaged renderer-to-helper asset
read remains gated on #27 and the maintainer's explicit authorization.

Authenticode signing, trusted update delivery, installer ownership/ACL policy,
and full adversarial packaged-app review remain mandatory before release.

Windows PCK archives remain unsupported. Linux readers remain unchanged.
