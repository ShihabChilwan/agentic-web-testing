import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ConfigOverride, HealthCheckResult, SeedResult, TargetConfig } from '../../shared/schemas.js';
import { childEnv, formatEnvFile, serviceEnv, type ServiceName } from './env.js';
import { waitForHealthy } from './health.js';
import { installIfNeeded } from './install.js';
import { fillPlaceholders } from './placeholders.js';
import { assertPortsFree } from './ports.js';
import { runCommand, startService, stopProcessGroup, type ServiceProcess } from './processes.js';
import { sendSeedRequests } from './seed.js';

const execFileAsync = promisify(execFile);

const INSTALL_TIMEOUT_MS = 30 * 60_000;
const RESET_TIMEOUT_MS = 60_000;

export interface StartOptions {
  /** Git ref to check out in the target repo. */
  ref: string;
  /** Absolute path of the target repo. */
  repoDir: string;
  /** Absolute path of targets/<name>/, available to commands as {{targetDir}}. */
  targetDir: string;
  /** Where backend.log, frontend.log and setup.log are written (an execution's server/ folder). */
  logsDir: string;
  configOverride?: ConfigOverride;
  skipSeed?: boolean;
  /** Aborting stops whatever is running and makes startTarget throw (after stopping the services). */
  signal?: AbortSignal;
  /** Progress messages for a human. */
  log?: (message: string) => void;
}

export interface RunningTarget {
  commit: string;
  healthChecks: HealthCheckResult[];
  seed: SeedResult[];
  services: ServiceProcess[];
  /** Stops every service's process group. Safe to call more than once. */
  stop(): Promise<void>;
}

async function git(repoDir: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoDir, ...args]);
    return stdout.trim();
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new Error(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`, { cause: err });
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Target start was aborted');
}

/**
 * SPEC §7.1 steps 1–6: checkout, install when the lockfile changed, reset, seed command,
 * start backend and frontend, health checks, seed requests. Health-check and seed failures
 * are recorded, not thrown. If anything throws, the services already started are stopped first.
 */
export async function startTarget(config: TargetConfig, options: StartOptions): Promise<RunningTarget> {
  const { repoDir, logsDir, configOverride, signal } = options;
  const log = options.log ?? (() => {});
  const setupLog = path.join(logsDir, 'setup.log');
  mkdirSync(logsDir, { recursive: true });
  const services: ServiceProcess[] = [];
  let stopped: Promise<void> | undefined;
  const stop = () =>
    (stopped ??= (async () => {
      for (const service of [...services].reverse()) await stopProcessGroup(service.pid);
    })());
  const startupTimeoutMs = configOverride?.lifecycle?.startupTimeoutMs ?? config.lifecycle.startupTimeoutMs;
  const dir = (cwd: string) => path.resolve(repoDir, cwd);
  const fill = (command: string) => fillPlaceholders(command, { targetDir: options.targetDir });

  try {
    await assertPortsFree([
      { name: 'backend', url: config.backend.baseUrl },
      { name: 'frontend', url: config.frontend.baseUrl },
    ]);

    log(`Checking out ${options.ref}`);
    await git(repoDir, ['checkout', '--quiet', '--force', options.ref]);
    const commit = await git(repoDir, ['rev-parse', 'HEAD']);

    for (const name of ['backend', 'frontend'] as const) {
      throwIfAborted(signal);
      // Installs use the configured env without the override: an environment fault targets the running app.
      const outcome = await installIfNeeded(dir(config[name].cwd), fill(config[name].install), {
        env: childEnv(serviceEnv(config, name)),
        logFile: setupLog,
        timeoutMs: INSTALL_TIMEOUT_MS,
        signal,
      });
      log(`Install ${name}: ${outcome}`);
    }

    throwIfAborted(signal);
    log('Resetting the database');
    const reset = await runCommand(fill(config.lifecycle.reset), {
      cwd: dir(config.lifecycle.resetCwd),
      env: childEnv(),
      logFile: setupLog,
      timeoutMs: RESET_TIMEOUT_MS,
      signal,
    });
    throwIfAborted(signal);
    if (reset.code !== 0) throw new Error(`Reset command failed (exit ${reset.code ?? reset.signal}); see ${setupLog}`);

    if (config.lifecycle.seedCommand && !options.skipSeed) {
      log('Running the seed command');
      const seeded = await runCommand(fill(config.lifecycle.seedCommand), {
        cwd: dir(config.lifecycle.seedCwd ?? '.'),
        env: childEnv(serviceEnv(config, 'backend', configOverride)),
        logFile: setupLog,
        timeoutMs: startupTimeoutMs,
        signal,
      });
      throwIfAborted(signal);
      if (seeded.code !== 0) {
        const why = seeded.timedOut ? 'timed out' : `exited with ${seeded.code ?? seeded.signal}`;
        appendFileSync(setupLog, `[warning] seed command ${why}; continuing\n`);
        log(`Warning: seed command ${why}; continuing (see ${setupLog})`);
      }
    }

    for (const name of ['backend', 'frontend'] as ServiceName[]) {
      throwIfAborted(signal);
      const service = config[name];
      const env = serviceEnv(config, name, configOverride);
      if (service.envFile) await writeFile(path.join(dir(service.cwd), service.envFile), formatEnvFile(env));
      log(`Starting ${name}: ${service.start}`);
      services.push(
        startService(name, service.start, {
          cwd: dir(service.cwd),
          env: childEnv(env),
          logFile: path.join(logsDir, `${name}.log`),
        }),
      );
    }

    log(`Waiting for health checks (up to ${Math.round(startupTimeoutMs / 1000)} s)`);
    const healthChecks = await Promise.all(
      services.map((service) =>
        waitForHealthy(service.name, config[service.name as ServiceName].healthCheckUrl, {
          timeoutMs: startupTimeoutMs,
          giveUp: service.exited,
          signal,
        }),
      ),
    );
    throwIfAborted(signal);

    const seed = options.skipSeed ? [] : await sendSeedRequests(config.backend.baseUrl, config.seed, config.fixtures);
    return { commit, healthChecks, seed, services, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

/** Starts the target, runs `fn`, and always stops the target afterwards, even when `fn` throws. */
export async function withTarget<T>(
  config: TargetConfig,
  options: StartOptions,
  fn: (target: RunningTarget) => Promise<T>,
): Promise<T> {
  const target = await startTarget(config, options);
  try {
    return await fn(target);
  } finally {
    await target.stop();
  }
}
