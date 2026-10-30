# Experimental Windows portable package

This branch is stacked on the native Windows asset-reader work. It builds an
**unsigned developer preview**, not a signed release or installer.

## Build (Windows x64)

Prerequisites: Node 22, `npm ci`, Visual Studio 2022 C++ Build Tools + Windows
SDK. The helper build script locates and initializes MSVC as needed.

```powershell
npm ci
npm run package:win:portable
```

The command compiles the native helper, rebuilds the main and renderer bundles,
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
georama-manifest.json
```

The helper remains anchored to `app.getAppPath()` and is never searched for in
the launch working directory. The package copies no repository .git tree,
private map files, external assets, or development node_modules.

## Verification

After extracting, supply the **absolute** package directory:

```powershell
node scripts/verify-win-portable.mjs "E:\path\to\georama-win-x64-..."
```

The verifier compares hashes of Electron, the main bundle, renderer entry page
and native helper against `georama-manifest.json`. A clean result means only
that the checked files match that manifest; **the manifest is not signed**.
An attacker who can alter both payloads and manifest can evade this check, and
the check is not atomic with subsequent executable launch. Do not present this
as authenticated production distribution.

Acceptance still requires a clean extraction/launch test on Windows, a separate
helper path-substitution test from a hostile working directory, and a runtime
asset read through the packaged application. Code-signing, trusted update
delivery, and installer ownership/ACL policy are future release gates.

Windows PCK archives remain unsupported. Linux readers remain unchanged.
