import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Env } from './env.js';
import { runCommand } from './processes.js';

const LOCKFILE = 'package-lock.json';
/** Kept inside node_modules, so deleting node_modules forces a reinstall. */
const MARKER = path.join('node_modules', '.lockfile-hash');

async function readOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** sha256 of the service's lockfile, or null when it has none. */
export async function lockfileHash(serviceDir: string): Promise<string | null> {
  const content = await readOrNull(path.join(serviceDir, LOCKFILE));
  return content === null ? null : createHash('sha256').update(content).digest('hex');
}

/** True when the lockfile changed since the last successful install, or there is no record of one. */
export async function needsInstall(serviceDir: string): Promise<boolean> {
  const hash = await lockfileHash(serviceDir);
  if (hash === null) return true;
  const recorded = await readOrNull(path.join(serviceDir, MARKER));
  return recorded?.trim() !== hash;
}

export async function installIfNeeded(
  serviceDir: string,
  command: string,
  options: { env: Env; logFile: string; timeoutMs: number; signal?: AbortSignal },
): Promise<'installed' | 'skipped'> {
  if (!(await needsInstall(serviceDir))) return 'skipped';
  const result = await runCommand(command, { cwd: serviceDir, ...options });
  if (result.code !== 0) {
    const why = result.aborted ? 'was aborted' : result.timedOut ? 'timed out' : `exited with ${result.code ?? result.signal}`;
    throw new Error(`Install "${command}" in ${serviceDir} ${why}; see ${options.logFile}`);
  }
  const hash = await lockfileHash(serviceDir);
  if (hash !== null) {
    await mkdir(path.join(serviceDir, 'node_modules'), { recursive: true });
    await writeFile(path.join(serviceDir, MARKER), `${hash}\n`);
  }
  return 'installed';
}
