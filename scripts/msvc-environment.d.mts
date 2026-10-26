/** True only when MSVC's C++ headers and Windows SDK includes/libs exist. */
export function hasMsvcBuildEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  fileExists?: (path: string) => boolean,
): boolean;

export function vcvarsCommand(
  vcvars: string,
  node: string,
  verify: string,
  compilerArgs: readonly string[],
): {
  command: string;
  args: string[];
  options: { windowsVerbatimArguments: boolean };
};
