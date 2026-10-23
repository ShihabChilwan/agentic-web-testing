import { readdir, readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The executor image installs only `dependencies` (npm ci --omit=dev). A package that src/ loads at run time but
// that is listed under devDependencies crashes every task at start-up (it happened with typescript).

const root = new URL('../../', import.meta.url).pathname;

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** The package name of a bare specifier ('@scope/name/x' → '@scope/name', 'name/x' → 'name'), or null for relative and built-in ones. */
function packageOf(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return null;
  const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!;
  return builtinModules.includes(name) ? null : name;
}

/** Packages a file loads when it runs: value imports, side-effect imports, re-exports, dynamic import() and require(). Type-only imports are erased. */
export function runtimeImports(source: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /^\s*import\s+(?!type\b)[^'"]*?from\s*['"]([^'"]+)['"]/gm,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /^\s*export\s+(?!type\b)[^'"]*?from\s*['"]([^'"]+)['"]/gm,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) for (const m of source.matchAll(pattern)) {
    const name = packageOf(m[1]!);
    if (name) found.add(name);
  }
  return [...found].sort();
}

describe('runtime dependencies', () => {
  it('finds value imports but not type-only imports', () => {
    expect(runtimeImports("import ts from 'typescript';\nimport type { X } from 'vitest';\nimport { z } from 'zod/v4';\nconst m = await import('@scope/pkg/sub');\nimport 'side';\nimport { a } from 'node:fs';\nimport b from 'path';")).toEqual([
      '@scope/pkg',
      'side',
      'typescript',
      'zod',
    ]);
  });

  it('every package src/ loads at run time is in dependencies, not devDependencies', async () => {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    const missing: string[] = [];
    for (const file of await sourceFiles(path.join(root, 'src'))) {
      for (const name of runtimeImports(await readFile(file, 'utf8'))) {
        if (!(name in pkg.dependencies)) missing.push(`${path.relative(root, file)}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
