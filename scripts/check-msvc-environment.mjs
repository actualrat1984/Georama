import { hasMsvcBuildEnvironment } from './msvc-environment.mjs';

if (!hasMsvcBuildEnvironment(process.env)) {
  console.error('MSVC is present, but Windows SDK / C++ include or library paths are missing.');
  console.error('Install or repair Desktop development with C++ and a Windows 10/11 SDK.');
  console.error('Try the x64 Native Tools Command Prompt or rebuild with the Georama script.');
  process.exitCode = 1;
}
