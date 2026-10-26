import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { parseAst } from 'vite';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export const fixtureRoot = path.join(projectRoot, 'tests/fixtures/core-boundary');
const portableGlobals = path.join(projectRoot, 'types/portable-globals.d.ts');
const sourceRoots = ['src/core', 'src/shared'].map((name) => path.join(projectRoot, name));

export function isInside(filename: string, directory: string): boolean {
  const relative = path.relative(directory, filename);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(filename);
    return entry.isFile() && filename.endsWith('.ts') ? [filename] : [];
  }));
  return files.flat().sort();
}

export async function portableSourceFiles(): Promise<string[]> {
  return (await Promise.all(sourceRoots.map(typescriptFiles))).flat();
}

export function runTsc(config: string, listFilesOnly = false) {
  const args = ['-p', config, '--noEmit', '--pretty', 'false'];
  if (listFilesOnly) args.push('--listFilesOnly');
  // Invoke the platform-neutral JS CLI: .bin/tsc is a POSIX shim, not a Windows executable.
  const compiler = path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  const result = spawnSync(process.execPath, [compiler, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { status: result.status, output: result.stdout + result.stderr };
}

export function listedFiles(output: string): string[] {
  const files = output.trim().split(/\r?\n/).filter(Boolean);
  // Do not silently discard diagnostics or an unexpected compiler output format.
  if (files.some((filename) => !path.isAbsolute(filename))) {
    throw new Error(`Expected absolute paths from tsc --listFilesOnly:\n${output}`);
  }
  // Diagnostics vary in native path separators. Keep comparisons platform-neutral.
  return files.map((filename) => filename.replaceAll(path.sep, '/'));
}

export async function withFixtureProject<T>(
  environment: 'core' | 'renderer',
  files: string[],
  action: (config: string) => T | Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), 'georama-core-gate-'));
  const config = path.join(directory, 'tsconfig.json');
  try {
    await writeFile(config, JSON.stringify({
      extends: path.join(projectRoot, `tsconfig.${environment}.json`),
      files: environment === 'core' ? [portableGlobals, ...files] : files,
      include: [],
      exclude: [],
    }));
    return await action(config);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function coreClosedWorld(files: string[], fixtureFiles: string[] = []): Promise<string[]> {
  // The native compiler resolves its libraries through the node_modules symlink.
  // Locate the actual library directory, not a project-relative node_modules path.
  const canonical = await Promise.all(files.map((filename) => realpath(filename)));
  const es5 = canonical.find((filename) => path.basename(filename) === 'lib.es5.d.ts');
  if (!es5) return ['closed-world core: compiler did not list lib.es5.d.ts'];
  const libDirectory = path.dirname(es5);
  const allowedRoots = await Promise.all(sourceRoots.map((directory) => realpath(directory)));
  const allowedFiles = new Set(await Promise.all([portableGlobals, ...fixtureFiles].map((filename) => realpath(filename))));
  return canonical.filter((filename) => !allowedFiles.has(filename)
    && !allowedRoots.some((directory) => isInside(filename, directory))
    && !(path.dirname(filename) === libDirectory && /^lib\..+\.d\.ts$/.test(path.basename(filename))))
    .map((filename) => `closed-world core: ${filename.replaceAll(path.sep, '/')}`);
}

export function rendererClosedWorld(files: string[]): string[] {
  return files.filter((filename) => /(?:^|\/)node_modules\/(?:@types\/node|electron)\//.test(filename.replaceAll(path.sep, '/')))
    .map((filename) => `closed-world renderer: ${filename}`);
}

export async function runtimeImportViolations(entryPoints: string[]): Promise<string[]> {
  const result = await build({
    absWorkingDir: projectRoot,
    tsconfig: path.join(projectRoot, 'tsconfig.core.json'),
    entryPoints,
    bundle: true,
    platform: 'neutral',
    format: 'esm',
    packages: 'external',
    write: false,
    metafile: true,
    logLevel: 'silent',
    // Multiple entries need an output directory; no files are written.
    outdir: 'out',
  });
  const violations: string[] = [];
  for (const [importer, input] of Object.entries(result.metafile.inputs)) {
    for (const dependency of input.imports) {
      const target = path.resolve(projectRoot, dependency.path);
      const label = `${importer}: ${dependency.kind} ${dependency.original ?? dependency.path}`;
      if (dependency.external) violations.push(`runtime imports: external ${label}`);
      else if (!sourceRoots.some((directory) => isInside(target, directory))) {
        violations.push(`runtime imports: outside core/shared ${label}`);
      }
      const specifier = dependency.original ?? dependency.path;
      if (specifier.startsWith('.') && !specifier.endsWith('.ts')) {
        violations.push(`runtime imports: relative specifier must end in .ts: ${label}`);
      }
    }
  }
  return violations;
}

type AstNode = { type: string; start: number; end: number; [key: string]: unknown };

function parseProgram(source: string, filename: string): { program: AstNode | null; violation: string | null } {
  try {
    const program = parseAst(source, { lang: 'ts' }) as unknown as AstNode;
    return { program, violation: null };
  } catch (error) {
    const first = String((error as Error)?.message ?? error).split('\n')[0];
    return { program: null, violation: `text rules: unparseable source at ${filename}: ${first}` };
  }
}

function walk(
  node: unknown,
  visit: (node: AstNode, parent: AstNode | null, key: string | null) => void,
  parent: AstNode | null = null,
  key: string | null = null,
): void {
  if (Array.isArray(node)) {
    for (const element of node) walk(element, visit, parent, key);
    return;
  }
  if (node !== null && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if (typeof record.type === 'string') {
      const ast = record as unknown as AstNode;
      visit(ast, parent, key);
      for (const [childKey, value] of Object.entries(record)) {
        if (childKey === 'loc' || childKey === 'range') continue;
        if (value !== null && typeof value === 'object') walk(value, visit, ast, childKey);
      }
      return;
    }
    for (const value of Object.values(record)) {
      if (value !== null && typeof value === 'object') walk(value, visit, parent, key);
    }
  }
}

type TextRule = (program: AstNode | null, source: string, filename: string) => string[];

function labelAt(source: string, filename: string, index: number): string {
  return `${filename}:${source.slice(0, index).split('\n').length}`;
}

/** Triple-slash directives can pull in lib.dom, @types/node or any file. Raw text: comments are not in the AST. */
const referenceDirectiveRule: TextRule = (_program, source, filename) => {
  // Block comments are not code: blank them (keeping newlines and length so
  // indices still line up) before matching. Strings and templates are left
  // intact on purpose: flagging the text there is fail-closed and accepted.
  const withoutBlocks = source.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, (match) => match.replace(/[^\n]/g, ' '));
  const pattern = /^[ \t]*\/\/\/[ \t]*<reference\b/gm;
  const violations: string[] = [];
  for (const match of withoutBlocks.matchAll(pattern)) {
    violations.push(`text rules: reference directive at ${labelAt(source, filename, match.index ?? 0)}`);
  }
  return violations;
};

/** esbuild cannot see through a computed import(): only a literal specifier is auditable. */
const dynamicImportRule: TextRule = (program, source, filename) => {
  if (!program) return [];
  const violations: string[] = [];
  walk(program, (node) => {
    if (node.type !== 'ImportExpression') return;
    const origin = node.source as AstNode | undefined;
    let clean = false;
    if (origin && typeof origin.type === 'string') {
      if (origin.type === 'Literal' && typeof origin.value === 'string') clean = true;
      else if (origin.type === 'TemplateLiteral') {
        const expressions = origin.expressions as unknown[] | undefined;
        if (Array.isArray(expressions) && expressions.length === 0) clean = true;
      }
    }
    if (!clean) violations.push(`text rules: non-literal dynamic import at ${labelAt(source, filename, node.start)}`);
  });
  return violations;
};

function ambientKeywordFor(node: AstNode): string {
  switch (node.type) {
    case 'VariableDeclaration': return String(node.kind ?? 'var');
    case 'FunctionDeclaration':
    case 'TSDeclareFunction': return 'function';
    case 'ClassDeclaration':
    case 'ClassExpression':
    case 'TSAbstractClassDeclaration': return 'class';
    case 'TSEnumDeclaration': return 'enum';
    case 'TSModuleDeclaration': return String(node.kind ?? 'namespace');
    case 'TSTypeAliasDeclaration': return 'type';
    case 'TSInterfaceDeclaration': return 'interface';
    default: {
      const base = node.type.replace(/^TSAbstract/, '').replace(/^TS/, '').replace(/Declaration$/, '');
      if (/^Function/i.test(base)) return 'function';
      if (/^Class/i.test(base)) return 'class';
      if (/^Enum/i.test(base)) return 'enum';
      if (/^Module/i.test(base)) return String(node.kind ?? 'module');
      if (/^Interface/i.test(base)) return 'interface';
      if (/^Type/i.test(base)) return 'type';
      if (/^Variable/i.test(base)) return String(node.kind ?? 'var');
      return base.charAt(0).toLowerCase() + base.slice(1);
    }
  }
}

/**
 * G2. A file that declares its own `process`/`window` makes the compiler's missing-name error
 * disappear while the file is still part of the core program, so no declaration may be ambient.
 */
const ambientDeclarationRule: TextRule = (program, source, filename) => {
  if (!program) return [];
  const violations: string[] = [];
  walk(program, (node) => {
    if (node.declare !== true) return;
    if (node.type === 'PropertyDefinition' || node.type === 'AccessorProperty'
      || node.type === 'MethodDefinition' || node.type.startsWith('TSAbstract')) return;
    const keyword = ambientKeywordFor(node);
    violations.push(`text rules: ambient declaration '${keyword}' at ${labelAt(source, filename, node.start)}`);
    if (node.type === 'TSModuleDeclaration') {
      violations.push(`text rules: namespace/module block at ${labelAt(source, filename, node.start)}`);
    }
  });
  // Every namespace/module block is forbidden, declared or not (plain `namespace A.B { }` too).
  walk(program, (node) => {
    if (node.type !== 'TSModuleDeclaration') return;
    if (node.declare === true) return; // already reported above
    violations.push(`text rules: namespace/module block at ${labelAt(source, filename, node.start)}`);
  });
  return violations;
};

/** G3. Suppression directives silence exactly the diagnostic this gate relies on. Raw text: comments count. */
const suppressionCommentRule: TextRule = (_program, source, filename) => [...source.matchAll(/@ts-(?:ignore|nocheck|expect-error)\b/g)]
  .map((match) => `text rules: suppression comment ${match[0]} at ${labelAt(source, filename, match.index ?? 0)}`);

/**
 * G4. Ways to reach an environment global or dynamic code without naming it: the global object, eval, and the
 * dynamic-code constructors (Function, AsyncFunction, GeneratorFunction, AsyncGeneratorFunction), which are also
 * reachable as `<function>.constructor`, through the key 'constructor' (Reflect.get(f, 'constructor'),
 * f['constructor']) or by destructuring `{ constructor }`. Portable code has no use for any of them, so those
 * identifiers are banned in every position, types included. A property merely called `.eval` or `.Function` on
 * some other object is not flagged, and neither is a class `constructor(` definition. The same goes for a member
 * declared with such a name (class, abstract class, interface, type literal, object literal), an enum member, a
 * label and the right side of a qualified type name: those are names, not references. tests/helpers/core-gate-forms.ts
 * pins every one of these positions, and the bad ones next to them, with the exact verdict.
 *
 * This is a regression guard against accidental dependencies, not a sandbox: a key computed at run time
 * ('const' + 'ructor') cannot be decided here. At run time the CSP has no 'unsafe-eval', so dynamic code fails
 * closed in the renderer as well.
 */
const bannedHatchNames = new Set([
  'globalThis', 'eval', 'Function', 'AsyncFunction', 'GeneratorFunction', 'AsyncGeneratorFunction',
]);

function isNameOnlyKey(parent: AstNode | null, key: string | null): boolean {
  if (!parent || !key) return false;
  if (parent.type === 'MemberExpression' && key === 'property' && parent.computed === false) return true;
  if ((parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition'
    || parent.type === 'AccessorProperty' || parent.type === 'TSPropertySignature' || parent.type === 'TSMethodSignature')
    && key === 'key' && parent.computed === false && (parent as AstNode).shorthand !== true) return true;
  // Abstract members are members too: the same names-only rule as their concrete twins above (a computed key is
  // still an expression and is still checked).
  if ((parent.type === 'TSAbstractMethodDefinition' || parent.type === 'TSAbstractPropertyDefinition'
    || parent.type === 'TSAbstractAccessorProperty') && key === 'key' && parent.computed === false) return true;
  if (parent.type === 'TSQualifiedName' && key === 'right') return true;
  if (parent.type === 'LabeledStatement' && key === 'label') return true;
  if ((parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') && key === 'label') return true;
  if (parent.type === 'TSEnumMember' && key === 'id') return true;
  return false;
}

const escapeHatchRule: TextRule = (program, source, filename) => {
  if (!program) return [];
  const violations: string[] = [];
  const report = (name: string, start: number): void => {
    violations.push(`text rules: escape hatch '${name}' at ${labelAt(source, filename, start)}`);
  };
  walk(program, (node, parent, key) => {
    // The key spelled as a string: decoded 'constructor' in any position, or a static template `constructor`.
    if (node.type === 'Literal' && typeof node.value === 'string' && node.value === 'constructor') {
      report('constructor', node.start);
      return;
    }
    if (node.type === 'TemplateLiteral') {
      const expressions = node.expressions as unknown[] | undefined;
      const quasis = node.quasis as AstNode[] | undefined;
      if (Array.isArray(expressions) && expressions.length === 0 && Array.isArray(quasis) && quasis.length === 1) {
        const cooked = ((quasis[0] as AstNode).value as { cooked?: unknown } | undefined)?.cooked;
        if (cooked === 'constructor') report('constructor', node.start);
      }
      return;
    }
    // Destructured `{ constructor }` / `{ constructor: F }`: the key of a Property inside an ObjectPattern.
    if (node.type === 'Property' && parent?.type === 'ObjectPattern') {
      const target = node.key as AstNode | undefined;
      if (target && typeof target.type === 'string' && target.type === 'Identifier'
        && (target.name as string) === 'constructor' && node.computed === false) {
        report('constructor', target.start);
      }
      return;
    }
    if (node.type !== 'Identifier') return;
    const name = node.name as string;
    if (name === 'constructor') {
      if (parent?.type === 'MemberExpression' && key === 'property' && parent.computed === false) {
        report('constructor', node.start);
      }
      return;
    }
    if (!bannedHatchNames.has(name)) return;
    if (isNameOnlyKey(parent, key)) return;
    report(name, node.start);
  });
  return violations;
};

export const textRules: readonly TextRule[] = [
  referenceDirectiveRule, dynamicImportRule, ambientDeclarationRule, suppressionCommentRule, escapeHatchRule,
];

export function textRuleViolations(source: string, filename = '<source>'): string[] {
  const { program, violation } = parseProgram(source, filename);
  if (violation) return [violation];
  return textRules.flatMap((rule) => rule(program, source, filename));
}

/**
 * G1. Everything the include globs can load must be a plain .ts source: no declaration file
 * (.d.ts), JSX, alternative module extensions, scripts or data, and no symlink (the compiler would
 * follow it, a directory walk by file type would not report it).
 */
export async function directoryHygieneViolations(roots: string[] = sourceRoots): Promise<string[]> {
  const violations: string[] = [];
  async function walkDir(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await walkDir(filename);
      else if (!entry.isFile()) violations.push(`directory hygiene: neither a regular file nor a directory (symlink?): ${filename}`);
      else if (filename.endsWith('.d.ts') || !filename.endsWith('.ts')) {
        violations.push(`directory hygiene: only plain .ts sources may live here (no .d.ts, .tsx, .mts, .cts, .js, data): ${filename}`);
      }
    }
  }
  for (const root of roots) await walkDir(root);
  return violations.sort();
}

/** The names declared by the one ambient file the core program may load. Pinned by a test. */
export async function allowListDeclarations(): Promise<string[]> {
  const { program } = parseProgram(await readFile(portableGlobals, 'utf8'), portableGlobals);
  if (!program) return [];
  const names: string[] = [];
  const body = program.body as AstNode[] | undefined;
  if (!Array.isArray(body)) return [];
  for (const statement of body) {
    if (statement.declare !== true) continue;
    if (statement.type === 'VariableDeclaration') {
      for (const declarator of (statement.declarations as AstNode[] ?? [])) {
        const id = declarator.id as AstNode | undefined;
        if (id?.type === 'Identifier') names.push(String(id.name));
      }
      continue;
    }
    const id = statement.id as AstNode | undefined;
    if (id?.type === 'Identifier') names.push(String(id.name));
    else if (id?.type === 'Literal' && typeof id.value === 'string') names.push(id.value);
  }
  return names.sort();
}

export async function portableTextViolations(files: string[]): Promise<string[]> {
  return (await Promise.all(files.map(async (filename) => textRuleViolations(await readFile(filename, 'utf8'), filename)))).flat();
}
