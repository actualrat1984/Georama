// Windows-only helper build. No changes to the normal npm build or Linux gates.
// A cl.exe on PATH is NOT sufficient: INCLUDE and LIB must contain the MSVC
// standard library and Windows SDK, otherwise windows.h fails to compile.
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasMsvcBuildEnvironment, vcvarsCommand } from './msvc-environment.mjs';

if (process.platform !== 'win32') {
  console.error('Windows native helper requires Windows and MSVC');
  process.exit(1);
}

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'out', 'windows');
mkdirSync(output, { recursive: true });

const source = path.join(root, 'native', 'win-asset-read.cpp');
const exe = path.join(output, 'georama-win-asset-read.exe');
const object = path.join(output, 'win-asset-read.obj');
const args = [
  '/nologo', '/std:c++17', '/EHsc', '/W4', '/WX', '/O2', '/utf-8',
  '/D_WIN32_WINNT=0x0602', '/DUNICODE', '/D_UNICODE',
  '/Fo' + object, '/Fe' + exe, source,
];

function run(command, a, options = {}) {
  const result = spawnSync(command, a, { cwd: root, stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) {
    console.error('Could not start native compiler: ' + result.error.code);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error('Native helper compilation failed. Confirm Visual Studio C++ Build Tools');
    console.error('and the Windows 10/11 SDK are installed (Desktop development with C++).');
    process.exit(result.status ?? 1);
  }
}

function failToolchain(message) {
  console.error(message);
  console.error('Open Visual Studio Installer > Modify > Desktop development with C++.');
  console.error('Ensure MSVC x64/x86 build tools AND a Windows 10/11 SDK are installed.');
  console.error('Alternatively, run from an x64 Native Tools Command Prompt.');
  process.exit(1);
}

// Never leave an old executable that could make later security tests look green
// after a failed build.
rmSync(exe, { force: true });

const compiler = spawnSync('where.exe', ['cl.exe'], { encoding: 'utf8', windowsHide: true });
const clOnPath = compiler.status === 0;
if (clOnPath && hasMsvcBuildEnvironment(process.env)) {
  console.log('Using initialized MSVC + Windows SDK environment.');
  run('cl.exe', args);
} else {
  if (clOnPath) {
    console.log('cl.exe is present, but its SDK headers or libraries are not initialized.');
    console.log('Initializing the Visual Studio x64 toolchain...');
  }
  const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!existsSync(vswhere)) {
    failToolchain('Cannot locate Visual Studio Installer vswhere.exe to initialize MSVC.');
  }
  const probe = spawnSync(vswhere, [
    '-latest', '-products', '*',
    '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property', 'installationPath',
  ], { encoding: 'utf8', windowsHide: true });
  const install = probe.status === 0 ? probe.stdout.trim() : '';
  if (!install) failToolchain('No installed Visual Studio x64 C++ toolchain found.');
  const vcvars = path.join(install, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  if (!existsSync(vcvars)) failToolchain('Visual Studio installation has no vcvars64.bat.');

  // Run vcvars64.bat and cl.exe in ONE cmd process; only that child inherits
  // the SDK paths set by vcvars. A previous bare where.exe check misses this.
  const verify = path.join(root, 'scripts', 'check-msvc-environment.mjs');
  const setup = vcvarsCommand(vcvars, process.execPath, verify, args);
  run(setup.command, setup.args, setup.options);
}
if (!existsSync(exe)) failToolchain('Compiler completed but emitted no helper executable.');
console.log('Built Windows read-only asset helper under out/windows/');
