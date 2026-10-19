import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { childEnv } from '../../src/modules/execution-engine/env.js';
import { installIfNeeded, needsInstall } from '../../src/modules/execution-engine/install.js';
import {
  groupAlive,
  runCommand,
  startService,
  stopProcessGroup,
} from '../../src/modules/execution-engine/processes.js';

let dir: string;
let logFile: string;
const started: number[] = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'awt-proc-'));
  logFile = path.join(dir, 'logs', 'service.log');
});

afterEach(async () => {
  for (const pid of started.splice(0)) await stopProcessGroup(pid, { graceMs: 200 }).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

const opts = () => ({ cwd: dir, env: childEnv(), logFile });

describe('process groups', () => {
  it('stops the whole tree, including background children', async () => {
    const service = startService('svc', 'sleep 100 & sleep 100 & wait', opts());
    started.push(service.pid);
    await sleep(200);
    expect(groupAlive(service.pid)).toBe(true);
    await stopProcessGroup(service.pid);
    expect(groupAlive(service.pid)).toBe(false);
    expect(await service.exited).toMatchObject({ signal: 'SIGTERM' });
  });

  it('uses SIGKILL when the group ignores SIGTERM', async () => {
    const service = startService('stubborn', "trap '' TERM; sleep 100 & wait; sleep 100", opts());
    started.push(service.pid);
    await sleep(200);
    const t0 = Date.now();
    await stopProcessGroup(service.pid, { graceMs: 300 });
    expect(groupAlive(service.pid)).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
  });

  it('writes output and the command line to the log file, but not the env', async () => {
    const result = await runCommand('echo hello; echo oops >&2; exit 3', {
      ...opts(),
      env: childEnv({ SECRET_VALUE: 'do-not-log' }),
      timeoutMs: 5000,
    });
    expect(result).toMatchObject({ code: 3, timedOut: false });
    const log = await readFile(logFile, 'utf8');
    expect(log).toContain('$ echo hello');
    expect(log).toContain('hello\noops\n');
    expect(log).toContain('[exit 3');
    expect(log).not.toContain('do-not-log');
  });

  it('kills a command that runs past its timeout', async () => {
    const t0 = Date.now();
    const result = await runCommand('sleep 30', { ...opts(), timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('kills a command when aborted', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await runCommand('sleep 30', { ...opts(), timeoutMs: 10_000, signal: controller.signal });
    expect(result.aborted).toBe(true);
  });

  it('cleans up background children left by a finished command', async () => {
    const pidFile = path.join(dir, 'bg.pid');
    await runCommand(`sleep 100 & echo $! > ${pidFile}`, { ...opts(), timeoutMs: 5000 });
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe('install', () => {
  it('installs on first run and when the lockfile changes, skips otherwise', async () => {
    const lock = path.join(dir, 'package-lock.json');
    await writeFile(lock, '{"v":1}');
    const command = 'echo x >> installs.txt';
    const run = () => installIfNeeded(dir, command, { env: childEnv(), logFile, timeoutMs: 5000 });

    expect(await needsInstall(dir)).toBe(true);
    expect(await run()).toBe('installed');
    expect(await run()).toBe('skipped');
    await writeFile(lock, '{"v":2}');
    expect(await run()).toBe('installed');
    await rm(path.join(dir, 'node_modules'), { recursive: true });
    expect(await run()).toBe('installed');
    expect((await readFile(path.join(dir, 'installs.txt'), 'utf8')).trim().split('\n')).toHaveLength(3);
  });

  it('throws when the install fails and installs again next time', async () => {
    await writeFile(path.join(dir, 'package-lock.json'), '{}');
    await expect(installIfNeeded(dir, 'exit 1', { env: childEnv(), logFile, timeoutMs: 5000 })).rejects.toThrow(
      /exited with 1/,
    );
    expect(await needsInstall(dir)).toBe(true);
  });
});
