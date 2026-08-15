import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Mechanical enforcement of the one non-negotiable constraint (§3):
 * outside the model registry there is zero model-specific branching.
 *
 * This exists because "don't write `if (model === 'jmak')`" is otherwise a code-review
 * convention that decays. Here it is a build failure.
 */

const ROOT = join(import.meta.dirname, '..');
const GUARDED_DIRECTORIES = ['src/solver', 'src/explain', 'src/api', 'src/http'];

/** Every key in the registry, plus the categorical option values of the diffusion model. */
const MODEL_IDENTITIES = [
  'nth-order',
  'reversible-1',
  'two-reactant',
  'autocatalytic',
  'michaelis-menten',
  'var-volume',
  'jmak',
  'diffusion',
  'cstr',
  'D1',
  'D2',
  'D3',
  'D4',
] as const;

const listTypeScriptFiles = (dir: string): string[] => {
  const absolute = join(ROOT, dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listTypeScriptFiles(join(dir, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(dir, entry.name)]
        : [],
  );
};

/** Comments may discuss models freely; only executable code is constrained. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('architecture: chemistry lives only in the registry', () => {
  const guardedFiles = GUARDED_DIRECTORIES.flatMap(listTypeScriptFiles);

  it('finds files to guard', () => {
    expect(guardedFiles.length).toBeGreaterThan(0);
  });

  it.each(MODEL_IDENTITIES)('no solver-layer code branches on the model key %s', (key) => {
    const offenders = guardedFiles.filter((file) => {
      const code = stripComments(readFileSync(join(ROOT, file), 'utf8'));
      return new RegExp(`['"\`]${key}['"\`]`).test(code);
    });
    expect(offenders, `model key "${key}" leaked into: ${offenders.join(', ')}`).toEqual([]);
  });

  it('no solver-layer file imports an individual model', () => {
    const offenders = guardedFiles.filter((file) => {
      const code = stripComments(readFileSync(join(ROOT, file), 'utf8'));
      return /from\s+['"][^'"]*\/models\/(?!registry\.ts)/.test(code);
    });
    expect(
      offenders,
      `only models/registry.ts may be imported by the solver layer; offenders: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('every model file lives under src/models', () => {
    const modelFiles = listTypeScriptFiles('src/models');
    expect(modelFiles.length).toBeGreaterThanOrEqual(10); // nine models + registry
  });
});

describe('architecture: the engine is dependency-free', () => {
  it('package.json declares no runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it('no source file imports a third-party module', () => {
    const sourceFiles = listTypeScriptFiles('src');
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const code = stripComments(readFileSync(join(ROOT, file), 'utf8'));
      for (const match of code.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const specifier = match[1] as string;
        const isRelative = specifier.startsWith('.');
        const isNodeBuiltin = specifier.startsWith('node:');
        if (!isRelative && !isNodeBuiltin) {
          offenders.push(`${relative('.', file)} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
