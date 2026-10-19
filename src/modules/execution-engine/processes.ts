import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Env } from './env.js';

export interface SpawnOptions {
  cwd: string;
  env: Env;
  /** stdout and stderr are appended here. */
  logFile: string;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ServiceProcess {
  name: string;
  /** Pid of the shell that leads the process group (the group id is the same number). */
  pid: number;
  /** Resolves when the group leader exits. */
  exited: Promise<ExitInfo>;
}

export interface CommandResult extends ExitInfo {
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

/**
 * Starts a shell command as the leader of a new process group, so the whole tree
 * (npm → cross-env → node) can be stopped together. Output goes straight to the log file.
 */
function spawnGroup(command: string, { cwd, env, logFile }: SpawnOptions) {
  mkdirSync(path.dirname(logFile), { recursive: true });
  appendFileSync(logFile, `$ ${command}  (in ${cwd})\n`);
  const fd = openSync(logFile, 'a');
  try {
    const child = spawn(command, { cwd, env, shell: true, detached: true, stdio: ['ignore', fd, fd] });
    const exited = new Promise<ExitInfo>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    return { child, exited };
  } finally {
    closeSync(fd); // the child keeps its own copy
  }
}

/** True while any process in the group is still alive. */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
}

async function waitForGroupExit(pgid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
  return true;
}

/** Sends SIGTERM to the whole group, then SIGKILL to whatever is left after `graceMs`. */
export async function stopProcessGroup(pgid: number, { graceMs = 5000 } = {}): Promise<void> {
  if (!groupAlive(pgid)) return;
  signalGroup(pgid, 'SIGTERM');
  if (await waitForGroupExit(pgid, graceMs)) return;
  signalGroup(pgid, 'SIGKILL');
  if (!(await waitForGroupExit(pgid, 2000))) {
    throw new Error(`Process group ${pgid} is still running after SIGKILL`);
  }
}

/** Starts a long-running service (backend or frontend). Stop it with stopProcessGroup(service.pid). */
export function startService(name: string, command: string, options: SpawnOptions): ServiceProcess {
  const { child, exited } = spawnGroup(command, options);
  if (child.pid === undefined) throw new Error(`Could not start ${name}: ${command}`);
  exited.catch(() => {}); // a spawn error is reported through `exited` to whoever awaits it
  return { name, pid: child.pid, exited };
}

/** Runs a command to completion. The whole process group is killed on timeout or abort. */
export async function runCommand(
  command: string,
  options: SpawnOptions & { timeoutMs: number; signal?: AbortSignal },
): Promise<CommandResult> {
  const started = Date.now();
  const { child, exited } = spawnGroup(command, options);
  let timedOut = false;
  let aborted = false;
  const kill = () => {
    if (child.pid !== undefined) void stopProcessGroup(child.pid, { graceMs: 2000 }).catch(() => {});
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, options.timeoutMs);
  const onAbort = () => {
    aborted = true;
    kill();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  try {
    const exit = await exited;
    // The leader may exit before its children; make sure nothing is left behind.
    if (child.pid !== undefined) await stopProcessGroup(child.pid, { graceMs: 2000 });
    const durationMs = Date.now() - started;
    appendFileSync(
      options.logFile,
      `[exit ${exit.code ?? exit.signal}${timedOut ? ', timed out' : ''}${aborted ? ', aborted' : ''} after ${durationMs} ms]\n`,
    );
    return { ...exit, timedOut, aborted, durationMs };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
