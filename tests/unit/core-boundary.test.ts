import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  allowListDeclarations, coreClosedWorld, directoryHygieneViolations, fixtureRoot, isInside,
  listedFiles, portableSourceFiles, portableTextViolations, projectRoot, rendererClosedWorld,
  runTsc, runtimeImportViolations, textRules, textRuleViolations, withFixtureProject,
} from '../helpers/core-gate.ts';
import { badForms, goodForms } from '../helpers/core-gate-forms.ts';

const fixture = (name: string) => path.join(fixtureRoot, name);
const config = (environment: string) => path.join(projectRoot, `tsconfig.${environment}.json`);
const timeout = 120_000;
const globals = ['process', 'Buffer', 'document', 'window', 'self', 'setTimeout', 'console', 'fetch', 'URL', 'structuredClone', 'performance', 'require'];

function expectCleanCompilation(result: ReturnType<typeof runTsc>): void {
  expect(result.status, result.output).toBe(0);
  expect(result.output).toBe('');
}

function expectSuccessfulListing(result: ReturnType<typeof runTsc>): string[] {
  expect(result.status, result.output).toBe(0);
  const files = listedFiles(result.output);
  expect(files.length).toBeGreaterThan(0);
  return files;
}

describe('environment-agnostic core boundary', () => {
  it('ambient globals: the real core compiles with the portable allow-list only', () => {
    expectCleanCompilation(runTsc(config('core')));
  }, timeout);

  it('closed-world core: every declaration belongs to core/shared, the allow-list or the compiler libraries', async () => {
    const files = expectSuccessfulListing(runTsc(config('core'), true));
    expect(await coreClosedWorld(files)).toEqual([]);
    expect(files.some((filename) => isInside(filename, fixtureRoot))).toBe(false);
  }, timeout);

  it('closed-world renderer: DOM is available without Node, Electron, fixtures or the core allow-list', () => {
    expectCleanCompilation(runTsc(config('renderer')));
    const files = expectSuccessfulListing(runTsc(config('renderer'), true));
    expect(rendererClosedWorld(files)).toEqual([]);
    expect(files.some((filename) => filename.endsWith('/lib.dom.d.ts'))).toBe(true);
    expect(files.some((filename) => isInside(filename, fixtureRoot) || filename.endsWith('/types/portable-globals.d.ts'))).toBe(false);
  }, timeout);

  it('node project: Node is available without DOM, fixtures or the core allow-list', () => {
    expectCleanCompilation(runTsc(config('node')));
    const files = expectSuccessfulListing(runTsc(config('node'), true));
    expect(files.some((filename) => filename.includes('/@types/node/'))).toBe(true);
    expect(files.some((filename) => /\/lib\.dom(?:\.iterable)?\.d\.ts$/.test(filename))).toBe(false);
    expect(files.some((filename) => isInside(filename, fixtureRoot) || filename.endsWith('/types/portable-globals.d.ts'))).toBe(false);
  }, timeout);

  it('runtime imports: scans every current core/shared .ts entry, including future codecs', async () => {
    const files = await portableSourceFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(await runtimeImportViolations(files)).toEqual([]);
  }, timeout);

  it('text rules: scans every current core/shared source', async () => {
    const files = await portableSourceFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(await portableTextViolations(files)).toEqual([]);
  }, timeout);
});

describe('ambient-global fixtures (one compiler invocation, diagnostics attributed per file)', () => {
  let result: ReturnType<typeof runTsc>;
  beforeAll(async () => {
    const files = [fixture('positive.ts'), ...globals.map((name) => fixture(`ambient/${name}.ts`))];
    result = await withFixtureProject('core', files, (project) => runTsc(project));
  }, timeout);

  it.each(globals)('rejects %s in its own negative fixture', (name) => {
    expect(result.status, result.output).not.toBe(0);
    const diagnostics = result.output.split('\n').filter((line) => line.includes(`ambient/${name}.ts(`));
    expect(diagnostics.length, result.output).toBeGreaterThan(0);
    expect(diagnostics.join('\n')).toMatch(/error TS(?:2304|2584|2591):/);
  });

  it('positive control: typed arrays, BigInt, TextDecoder/TextEncoder and relative .ts imports compile', async () => {
    expect(result.output).not.toContain('positive.ts(');
    await withFixtureProject('core', [fixture('positive.ts')], (project) => expectCleanCompilation(runTsc(project)));
  }, timeout);
});

describe('closed-world fixtures', () => {
  it('positive control: a clean relative .ts import stays inside the core program', async () => {
    const positive = fixture('positive.ts');
    await withFixtureProject('core', [positive], async (project) => {
      expectCleanCompilation(runTsc(project));
      const files = expectSuccessfulListing(runTsc(project, true));
      expect(await coreClosedWorld(files, [positive])).toEqual([]);
    });
  }, timeout);

  it.each(['electron-type', 'node-reference'])('core rejects %s declarations even when compilation succeeds', async (name) => {
    const negative = fixture(`closed-world/${name}.ts`);
    await withFixtureProject('core', [negative], async (project) => {
      // This is the type-only Electron hole: compiler success is NOT enough.
      expectCleanCompilation(runTsc(project));
      const files = expectSuccessfulListing(runTsc(project, true));
      const violations = await coreClosedWorld(files, [negative]);
      expect(violations.length, files.join('\n')).toBeGreaterThan(0);
      expect(violations.join('\n')).toContain('/@types/node/');
      if (name === 'electron-type') expect(violations.join('\n')).toContain('/electron/');
    });
  }, timeout);

  it('core rejects a type-only Node built-in even if no foreign declaration can resolve', async () => {
    const negative = fixture('closed-world/node-type.ts');
    await withFixtureProject('core', [negative], async (project) => {
      const compilation = runTsc(project);
      const files = expectSuccessfulListing(runTsc(project, true));
      const violations = await coreClosedWorld(files, [negative]);
      // With types: [] an unresolved node: import is compiler-rejected; if a
      // future compiler resolves it, the closed-world declaration gate rejects it.
      expect(compilation.status !== 0 || violations.length > 0, compilation.output).toBe(true);
      if (compilation.status !== 0) expect(compilation.output).toMatch(/node-type\.ts\(.*error TS/);
    });
  }, timeout);

  it('renderer rejects a type-only Electron import that re-enables Node declarations', async () => {
    await withFixtureProject('renderer', [fixture('closed-world/renderer-electron.ts')], (project) => {
      expectCleanCompilation(runTsc(project));
      const files = expectSuccessfulListing(runTsc(project, true));
      expect(rendererClosedWorld(files).join('\n')).toContain('/electron/');
      expect(rendererClosedWorld(files).join('\n')).toContain('/@types/node/');
    });
  }, timeout);

  it('renderer positive control: a clean portable file does not import Node/Electron', async () => {
    await withFixtureProject('renderer', [fixture('positive.ts')], (project) => {
      expectCleanCompilation(runTsc(project));
      expect(rendererClosedWorld(expectSuccessfulListing(runTsc(project, true)))).toEqual([]);
    });
  }, timeout);
});

describe('esbuild runtime-import fixtures', () => {
  it.each([
    ['bare-fs', 'external'], ['fs-promises', 'external'], ['node-fs', 'external'],
    ['side-effect', 'external'], ['re-export', 'external'], ['dynamic', 'external'],
    ['dynamic-bare', 'external'], ['require', 'external'], ['require-whitespace', 'external'],
    ['escape', 'outside core/shared'], ['extensionless', 'relative specifier must end in .ts'],
    ['third-party', 'external'],
  ])('rejects %s via real metafile import records', async (name, reason) => {
    expect((await runtimeImportViolations([fixture(`runtime/${name}.ts`)])).join('\n')).toContain(reason);
  }, timeout);

  it('positive control: a portable file with a relative .ts import bundles cleanly', async () => {
    expect(await runtimeImportViolations([fixture('positive.ts')])).toEqual([]);
  }, timeout);
});

describe('text-rule fixtures for syntax esbuild cannot enforce', () => {
  it.each(['non-literal', 'interpolated-template', 'nested-template', 'reference', 'regex-argument', 'concatenated-string'])('rejects %s', async (name) => {
    const filename = fixture(`text/${name}.ts`);
    expect(textRuleViolations(await readFile(filename, 'utf8'), filename).length).toBeGreaterThan(0);
  });

  it('positive control: comments, strings, regexes and static templates are not code', async () => {
    const filename = fixture('text/comments-only.ts');
    expect(textRuleViolations(await readFile(filename, 'utf8'), filename)).toEqual([]);
    expect(textRuleViolations(await readFile(fixture('positive.ts'), 'utf8'))).toEqual([]);
  });
});

describe('G1 directory hygiene: core/shared hold plain .ts files only', () => {
  it('the real trees are clean, and the only declaration file in the core program is the pinned allow-list', async () => {
    expect(await directoryHygieneViolations()).toEqual([]);
    expect(await allowListDeclarations()).toEqual(['TextDecoder', 'TextEncoder']);
    const files = expectSuccessfulListing(runTsc(config('core'), true));
    const declarations = files.filter((filename) => isInside(filename, path.join(projectRoot, 'src')) && filename.endsWith('.d.ts'));
    expect(declarations).toEqual([]);
  }, timeout);

  async function withTree<T>(build: (root: string) => Promise<void>, action: (root: string) => Promise<T>): Promise<T> {
    const root = await mkdtemp(path.join(tmpdir(), 'georama-hygiene-'));
    try {
      await build(root);
      return await action(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it('positive control: nested plain .ts files pass', async () => {
    await withTree(async (root) => {
      await mkdir(path.join(root, 'formats/deep'), { recursive: true });
      await writeFile(path.join(root, 'index.ts'), 'export {};\n');
      await writeFile(path.join(root, 'formats/deep/codec.ts'), 'export {};\n');
    }, async (root) => expect(await directoryHygieneViolations([root])).toEqual([]));
  });

  it.each([
    'smuggled.d.ts', 'sub/nested.d.ts', 'view.tsx', 'module.mts', 'common.cts', 'plain.js', 'esm.mjs', 'cjs.cjs',
    'data.json', 'notes.md', 'declarations.d.mts', '.hidden',
  ])('rejects %s and names its path', async (name) => {
    await withTree(async (root) => {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), 'export {};\n');
      await writeFile(path.join(root, 'ok.ts'), 'export {};\n');
    }, async (root) => {
      const violations = await directoryHygieneViolations([root]);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain(path.join(root, name));
    });
  });

  // Ordinary Windows users cannot always create symlinks (EPERM without Developer Mode).
  // Native Windows junction/reparse rejection is exercised by windows-asset-races.test.ts.
  it.skipIf(process.platform === 'win32')('rejects a symlink, which the include glob would follow but a directory walk does not report', async () => {
    await withTree(async (root) => {
      await writeFile(path.join(root, 'real.ts'), 'export {};\n');
      await symlink(path.join(root, 'real.ts'), path.join(root, 'alias.ts'));
    }, async (root) => {
      const violations = await directoryHygieneViolations([root]);
      expect(violations.join('\n')).toContain(path.join(root, 'alias.ts'));
    });
  });
});

describe('G2 no ambient declarations in core/shared source', () => {
  const blind = ['declare-const-process', 'declare-var-window'];
  const bypasses = [
    ...blind, 'declare-function', 'declare-class', 'declare-namespace', 'declare-module', 'declare-global',
    'export-declare', 'declare-indented', 'bare-namespace',
  ];

  it.each(bypasses)('rejects %s', async (name) => {
    const filename = fixture(`text/${name}.ts`);
    expect(textRuleViolations(await readFile(filename, 'utf8'), filename).join('\n')).toMatch(/ambient declaration|namespace\/module block/);
  });

  it.each(blind)('the compiler alone is blind to %s (that is why the text rule exists)', async (name) => {
    await withFixtureProject('core', [fixture(`text/${name}.ts`)], (project) => expectCleanCompilation(runTsc(project)));
  }, timeout);

  it('a global declared in a script file (no import/export) cannot leak into another core file', async () => {
    await withFixtureProject('core', [fixture('ambient-script/declares-process.ts'), fixture('ambient-script/uses-process.ts')], (project) => {
      const result = runTsc(project);
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toMatch(/uses-process\.ts\(.*error TS(?:2304|2584|2591)/);
    });
  }, timeout);
});

describe('G3 no suppression comments', () => {
  it.each(['ts-ignore-line', 'ts-expect-error-block', 'ts-nocheck'])('rejects %s', async (name) => {
    const filename = fixture(`text/${name}.ts`);
    expect(textRuleViolations(await readFile(filename, 'utf8'), filename).join('\n')).toContain('suppression comment');
  });

  it('the compiler is blind to a suppressed missing global', async () => {
    await withFixtureProject('core', [fixture('text/ts-ignore-line.ts')], (project) => expectCleanCompilation(runTsc(project)));
  }, timeout);
});

describe('G4 no escape-hatch tokens', () => {
  it.each(['globalthis-cast', 'eval-call', 'eval-spaced', 'eval-indirect', 'new-function', 'function-call'])('rejects %s', async (name) => {
    const filename = fixture(`text/${name}.ts`);
    expect(textRuleViolations(await readFile(filename, 'utf8'), filename).join('\n')).toContain('escape hatch');
  });

  // The Function constructor reached without writing `new Function`: through a value position, a type position,
  // `.constructor` on any function (also async), a destructuring pattern, or the key spelled as a string.
  it.each([
    'function-logical', 'function-alias', 'function-type', 'constructor-member', 'async-constructor', 'constructor-optional',
    'constructor-destructure', 'constructor-shorthand', 'constructor-string-key', 'constructor-bracket-key', 'constructor-template-key',
  ])('rejects the indirect form %s', async (name) => {
    const filename = fixture(`text/${name}.ts`);
    expect(textRuleViolations(await readFile(filename, 'utf8'), filename).join('\n')).toContain('escape hatch');
  });

  it('the compiler alone lets the indirect Function constructor through (so the text rule is what stops it)', async () => {
    for (const name of ['function-logical', 'function-alias', 'constructor-member', 'constructor-string-key']) {
      await withFixtureProject('core', [fixture(`text/${name}.ts`)], (project) => expectCleanCompilation(runTsc(project)));
    }
  }, timeout);
});

describe('G5 the words are fine in comments and literals', () => {
  it('positive control: globalThis, eval, Function, .constructor and declare only inside comments, strings, templates and regexes', async () => {
    const filename = fixture('text/words-in-comments-and-strings.ts');
    expect(textRuleViolations(await readFile(filename, 'utf8'), filename)).toEqual([]);
    await withFixtureProject('core', [filename], (project) => expectCleanCompilation(runTsc(project)));
  }, timeout);

  it('positive control: class constructors, look-alike names and a property called Function on another object are not flagged', async () => {
    const filename = fixture('text/constructor-definitions.ts');
    expect(textRuleViolations(await readFile(filename, 'utf8'), filename)).toEqual([]);
    await withFixtureProject('core', [filename], (project) => expectCleanCompilation(runTsc(project)));
  }, timeout);
});

describe('fixF unicode escapes: decoded identifiers and keys are still escape hatches', () => {
  const bad: Array<[string, string, number]> = [
    ['fixf-esc-u-function.ts', 'Function', 1],
    ['fixf-esc-braced-function.ts', 'Function', 1],
    ['fixf-esc-eval.ts', 'eval', 1],
    ['fixf-esc-globalthis.ts', 'globalThis', 1],
    ['fixf-esc-member-ctor.ts', 'constructor', 1],
    ['fixf-esc-string-u.ts', 'constructor', 1],
    ['fixf-esc-string-hex.ts', 'constructor', 1],
    ['fixf-esc-continuation.ts', 'constructor', 1],
  ];
  it.each(bad)('rejects %s', async (name, word, line) => {
    const filename = fixture(`text/${name}`);
    expect(textRuleViolations(await readFile(filename, 'utf8'), filename))
      .toEqual([`text rules: escape hatch '${word}' at ${filename}:${line}`]);
  });
});

describe('fixF the regex desync is gone: quotes inside regex literals no longer blind the gate', () => {
  const bad: Array<[string, string, number]> = [
    ['fixf-desync-typeof-newfunction.ts', `escape hatch 'Function'`, 2],
    ['fixf-desync-if-newfunction.ts', `escape hatch 'Function'`, 2],
    ['fixf-desync-ifsimple-newfunction.ts', `escape hatch 'Function'`, 2],
    ['fixf-desync-while-newfunction.ts', `escape hatch 'Function'`, 2],
    ['fixf-desync-import.ts', 'non-literal dynamic import', 2],
    ['fixf-desync-declare.ts', `ambient declaration 'const'`, 2],
    ['fixf-desync-namespace.ts', 'namespace/module block', 2],
  ];
  it.each(bad)('rejects %s', async (name, kind, line) => {
    const filename = fixture(`text/${name}`);
    expect(textRuleViolations(await readFile(filename, 'utf8'), filename))
      .toEqual([`text rules: ${kind} at ${filename}:${line}`]);
  });
});

describe('fixF constructor keys and indirect Function reach', () => {
  const bad: Array<[string, string, number]> = [
    ['fixf-ctor-optional-computed.ts', 'constructor', 2],
    ['fixf-ctor-assign-destructure.ts', 'constructor', 1],
    ['fixf-ctor-default-destructure.ts', 'constructor', 1],
    ['fixf-getown-constructor.ts', 'constructor', 1],
    ['fixf-comma-function.ts', 'Function', 1],
    ['fixf-type-function.ts', 'Function', 1],
    ['fixf-typeof-globalthis.ts', 'globalThis', 1],
  ];
  it.each(bad)('rejects %s', async (name, word, line) => {
    const filename = fixture(`text/${name}`);
    expect(textRuleViolations(await readFile(filename, 'utf8'), filename))
      .toEqual([`text rules: escape hatch '${word}' at ${filename}:${line}`]);
  });

  it('rejects an unparseable source with only the unparseable violation', async () => {
    const filename = fixture('text/fixf-unparseable.ts');
    expect(textRuleViolations(await readFile(filename, 'utf8'), filename))
      .toEqual([`text rules: unparseable source at ${filename}: Parse failed with 1 error:`]);
  });
});

describe('fixF portable shapes stay clean', () => {
  it.each([
    'fixf-good-class-derived.ts', 'fixf-good-param-ctor.ts', 'fixf-good-object-keys.ts',
    'fixf-good-lookalikes.ts', 'fixf-good-words-context.ts', 'fixf-good-template-interp.ts',
    'fixf-good-regex-quotes.ts', 'fixf-good-division.ts', 'fixf-good-generic.ts',
    'fixf-good-satisfies.ts', 'fixf-good-enum.ts', 'fixf-good-arrow-regex.ts',
  ])('accepts %s', async (name) => {
    const filename = fixture(`text/${name}`);
    expect(textRuleViolations(await readFile(filename, 'utf8'), filename)).toEqual([]);
  });
});

// The final gate review (R0.1-deltaC) mutated the gate 23 times and 8 mutants lived; a wider table of 82 mutants (the
// 23, the exemption branches, and one 'walker skips this edge key' mutant per key that carries a banned name) left 45
// alive. Every one is a position or a name that no test pinned, so the class is closed with a table: one row per
// syntactic position, with the exact verdict. The rows live in tests/helpers/core-gate-forms.ts.
describe('G4 every position of a banned name (table of forms)', () => {
  const hatches = (names: readonly string[]): string[] => names.map((name) => `text rules: escape hatch '${name}' at x.ts:1`);

  it('the ids are unique, so a copy and paste slip cannot hide a case, and every bad form names what it expects', () => {
    const ids = [...badForms.map(([id]) => id), ...goodForms.map(([id]) => id)];
    expect(new Set(ids).size).toBe(ids.length);
    for (const [id, , ...names] of badForms) expect(names.length, id).toBeGreaterThan(0);
  });

  it.each(badForms)('flags %s', (_id, source, ...names) => {
    expect(textRuleViolations(source, 'x.ts')).toEqual(hatches(names));
  });

  it.each(goodForms)('accepts %s (the names are only names)', (_id, source) => {
    expect(textRuleViolations(source, 'x.ts')).toEqual([]);
  });

  it('the position of a violation is reported on the right line', () => {
    expect(textRuleViolations('const a = 1;\nconst b = 2;\nconst c = AsyncFunction;\n', 'multi.ts'))
      .toEqual(["text rules: escape hatch 'AsyncFunction' at multi.ts:3"]);
  });

  it('nesting alone does not hide a banned name', () => {
    // Hundreds of levels are far deeper than hand-written code. Measured on Node 22: the walk is fine at a thousand
    // levels and overflows beyond two thousand, so 400 stays well inside the limit of both thread modes.
    const source = `${'['.repeat(400)}Function${']'.repeat(400)}`;
    expect(textRuleViolations(source, 'deep.ts')).toEqual(["text rules: escape hatch 'Function' at deep.ts:1"]);
  });

  it('a rule that fails is never a silent pass', () => {
    // A pathological file makes a rule throw (a stack overflow in the recursive walk), and that must reach the
    // caller as an exception: an empty list would read as "clean". The live rule list is extended for one call only.
    // (The overflow itself is not exercised here: past a few thousand levels the native parser dies in a worker
    // thread, which would turn this test into a crash.)
    const rules = textRules as unknown as Array<() => string[]>;
    rules.push(() => {
      throw new RangeError('rule failure');
    });
    try {
      expect(() => textRuleViolations('const a = 1;', 'x.ts')).toThrow(RangeError);
    } finally {
      rules.pop();
    }
    expect(textRuleViolations('const a = 1;', 'x.ts')).toEqual([]);
  });
});
