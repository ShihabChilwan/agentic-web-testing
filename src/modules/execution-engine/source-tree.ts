import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { lockfileHash } from './install.js';

const execFileAsync = promisify(execFile);

/** Files a patch may not touch: changing them would need an install of its own. */
const DEPENDENCY_FILES = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);

export interface SourceTree {
  /** Absolute path of the tree (a neutrally named temporary folder). */
  dir: string;
  remove(): Promise<void>;
}

export interface SourceTreeOptions {
  /** The target repo (read only: nothing in it changes). */
  repoDir: string;
  commit: string;
  /** Absolute path of a unified diff to apply on top of the commit. */
  patchFile?: string;
  /** Service folders (e.g. "server", "client") whose node_modules are linked from the target repo (executions only). */
  linkNodeModules?: readonly string[];
}

async function run(file: string, args: string[], cwd?: string): Promise<string> {
  try {
    return (await execFileAsync(file, args, { maxBuffer: 50 * 1024 * 1024, ...(cwd ? { cwd } : {}) })).stdout;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new Error(`${file} ${args[0] ?? ''} failed${stderr ? `: ${stderr}` : ''}`, { cause: err });
  }
}

/** `git rev-parse` of a ref to a full commit id; throws a clear error for an unknown ref. */
export async function resolveCommit(repoDir: string, ref: string): Promise<string> {
  try {
    return (await execFileAsync('git', ['-C', repoDir, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).stdout.trim();
  } catch {
    throw new Error(`Unknown ref "${ref}" in ${repoDir}`);
  }
}

/** The files a patch changes, from `git apply --numstat`. */
export async function patchedFiles(patchFile: string): Promise<string[]> {
  const out = await run('git', ['apply', '--numstat', patchFile]);
  return out.split('\n').filter(Boolean).map((line) => line.split('\t')[2] ?? '').filter(Boolean);
}

/**
 * Exports `commit` of the target repo into a new temporary folder (no `.git`, neutral name), applies
 * the optional patch, and links the listed services' node_modules from the target repo (SPEC §7.5).
 * The target repo itself is never changed.
 */
export async function buildSourceTree(options: SourceTreeOptions): Promise<SourceTree> {
  const { repoDir, commit, patchFile } = options;
  if (patchFile) {
    const blocked = (await patchedFiles(patchFile)).filter((f) => DEPENDENCY_FILES.has(path.posix.basename(f)));
    if (blocked.length > 0) throw new Error(`The patch changes ${blocked.join(', ')}; patches that change dependencies are not supported`);
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'awt-src-'));
  const remove = () => rm(dir, { recursive: true, force: true });
  try {
    // git archive writes a tar of the commit; tar unpacks it. Paths are passed as arguments, never interpolated.
    await run('sh', ['-c', 'git -C "$1" archive --format=tar "$2" | tar -x -C "$3"', 'sh', repoDir, commit, dir]);
    if (patchFile) await run('git', ['apply', '--whitespace=nowarn', patchFile], dir);
    for (const service of options.linkNodeModules ?? []) {
      const source = path.join(repoDir, service, 'node_modules');
      const installed = await readFile(path.join(source, '.lockfile-hash'), 'utf8').then((t) => t.trim(), () => null);
      const wanted = await lockfileHash(path.join(dir, service));
      if (installed === null || installed !== wanted) {
        throw new Error(`${source} is not installed for this version's lockfile; run "npm run target:up -- <target>" once first`);
      }
      await symlink(source, path.join(dir, service, 'node_modules'), 'dir');
    }
    return { dir, remove };
  } catch (err) {
    await remove();
    throw err;
  }
}
