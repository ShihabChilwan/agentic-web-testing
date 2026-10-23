import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSourceTree, patchedFiles, resolveCommit } from '../../src/modules/execution-engine/source-tree.js';

let root: string;
let repo: string;
let commit: string;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'awt-tree-test-'));
  repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'server', 'node_modules'), { recursive: true });
  await writeFile(path.join(repo, 'server', 'app.js'), 'const ok = true;\nmodule.exports = ok;\n');
  await writeFile(path.join(repo, 'server', 'package-lock.json'), '{"v":1}');
  await writeFile(path.join(repo, 'server', 'node_modules', '.lockfile-hash'), `${hash('{"v":1}')}\n`);
  await writeFile(path.join(repo, '.gitignore'), 'node_modules\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@x.test', ...args], { encoding: 'utf8' });
  git('init', '--quiet');
  git('add', '.');
  git('commit', '--quiet', '-m', 'one');
  git('branch', 'golden');
  commit = git('rev-parse', 'HEAD').trim();
  await writeFile(path.join(root, 'bug.patch'), '--- a/server/app.js\n+++ b/server/app.js\n@@ -1,2 +1,2 @@\n-const ok = true;\n+const ok = false;\n module.exports = ok;\n');
  await writeFile(path.join(root, 'deps.patch'), '--- a/server/package-lock.json\n+++ b/server/package-lock.json\n@@ -1 +1 @@\n-{"v":1}\n\\ No newline at end of file\n+{"v":2}\n\\ No newline at end of file\n');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('buildSourceTree', () => {
  it('exports the commit without .git into a neutrally named folder and removes it', async () => {
    const tree = await buildSourceTree({ repoDir: repo, commit });
    expect(path.basename(tree.dir)).toMatch(/^awt-src-[A-Za-z0-9]+$/);
    expect((await readdir(tree.dir)).sort()).toEqual(['.gitignore', 'server']);
    expect(await readFile(path.join(tree.dir, 'server', 'app.js'), 'utf8')).toContain('ok = true');
    await tree.remove();
    await expect(readdir(tree.dir)).rejects.toThrow(/ENOENT/);
  });

  it('applies a patch to the tree only, and links node_modules installed for the same lockfile', async () => {
    const tree = await buildSourceTree({ repoDir: repo, commit, patchFile: path.join(root, 'bug.patch'), linkNodeModules: ['server'] });
    try {
      expect(await readFile(path.join(tree.dir, 'server', 'app.js'), 'utf8')).toContain('ok = false');
      expect((await lstat(path.join(tree.dir, 'server', 'node_modules'))).isSymbolicLink()).toBe(true);
      expect(await readFile(path.join(repo, 'server', 'app.js'), 'utf8')).toContain('ok = true'); // the repo is unchanged
    } finally {
      await tree.remove();
    }
    expect(await readdir(path.join(repo, 'server', 'node_modules'))).toEqual(['.lockfile-hash']); // removing the link left the real folder alone
  });

  it('refuses a patch that changes dependencies, and node_modules installed for another lockfile', async () => {
    expect(await patchedFiles(path.join(root, 'deps.patch'))).toEqual(['server/package-lock.json']);
    await expect(buildSourceTree({ repoDir: repo, commit, patchFile: path.join(root, 'deps.patch') })).rejects.toThrow(/changes server\/package-lock.json/);
    await writeFile(path.join(repo, 'server', 'node_modules', '.lockfile-hash'), 'something-else\n');
    try {
      await expect(buildSourceTree({ repoDir: repo, commit, linkNodeModules: ['server'] })).rejects.toThrow(/is not installed for this version's lockfile/);
    } finally {
      await writeFile(path.join(repo, 'server', 'node_modules', '.lockfile-hash'), `${hash('{"v":1}')}\n`);
    }
  });

  it('resolveCommit: a branch to its commit, an unknown ref to a clear error', async () => {
    expect(await resolveCommit(repo, 'golden')).toBe(commit);
    await expect(resolveCommit(repo, 'nope')).rejects.toThrow('Unknown ref "nope"');
    // Any other git failure keeps git's own reason (e.g. "dubious ownership" when the repo belongs to another user).
    await expect(resolveCommit(path.join(path.dirname(repo), 'missing'), 'golden')).rejects.toThrow(/Cannot resolve ref "golden" in .*missing: fatal: cannot change to/);
  });
});
