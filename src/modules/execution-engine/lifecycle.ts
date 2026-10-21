import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  ConfigOverride,
  HealthCheckResult,
  SeedCheckResult,
  SeedResult,
  TargetConfig,
} from '../../shared/schemas.js';
import { childEnv, formatEnvFile, serviceEnv, type ServiceName } from './env.js';
import { waitForHealthy } from './health.js';
import { installIfNeeded } from './install.js';
import { fillPlaceholders } from './placeholders.js';
import { assertPortsFree } from './ports.js';
import { runCommand, startService, stopProcessGroup, type ServiceProcess } from './processes.js';
import { runSeedCheck, sendSeedRequests } from './seed.js';

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
  /** The run's generation ref (defaults to the config's goldenRef); a start at this ref with no override is "clean". */
  generationRef?: string;
  /** Aborting stops whatever is running and makes startTarget throw (after stopping the services). */
  signal?: AbortSignal;
  /** Progress messages for a human. */
  log?: (message: string) => void;
}

export interface RunningTarget {
  commit: string;
  healthChecks: HealthCheckResult[];
  seed: SeedResult[];
  /** Absent when the target has no seedCheck or the check was skipped. */
  seedCheck?: SeedCheckResult;
  services: ServiceProcess[];
  /**
   * Puts the data back to the clean seeded state while the app keeps running: reset, seed command,
   * a backend restart (a reset under a running backend can drop what it set up at start, e.g. indexes),
   * seed requests and the seed check. The frontend holds no server data and is not restarted.
   * Throws when any step fails: later results would not be trustworthy.
   */
  restore(): Promise<{ durationMs: number }>;
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

/** True when the override sets or removes anything (an empty override changes nothing). */
function changesConfig(override?: ConfigOverride): boolean {
  if (!override) return false;
  const envKeys = Object.keys(override.backend?.env ?? {}).length + Object.keys(override.frontend?.env ?? {}).length;
  return envKeys > 0 || override.lifecycle?.startupTimeoutMs !== undefined;
}

/** The generation ref with nothing changed: Stage 1, dry runs and the golden execution. */
export function isCleanStart(config: TargetConfig, options: StartOptions): boolean {
  return (
    options.ref === (options.generationRef ?? config.goldenRef) &&
    !changesConfig(options.configOverride) &&
    !options.skipSeed
  );
}

/** `git checkout --force <ref>` in the target repo; returns the checked-out commit. */
export async function checkoutRef(repoDir: string, ref: string): Promise<string> {
  await git(repoDir, ['checkout', '--quiet', '--force', ref]);
  return git(repoDir, ['rev-parse', 'HEAD']);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Target start was aborted');
}

/**
 * SPEC §7.1 steps 1–6: checkout, install when the lockfile changed, reset, seed command,
 * start backend and frontend, health checks, seed requests, seed check. Health-check and seed-request
 * failures are recorded, not thrown; a failed seed check throws only on a clean start (isCleanStart).
 * If anything throws, the services already started are stopped first.
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
    const commit = await checkoutRef(repoDir, options.ref);

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

    // Reset and seed command: shared by the start and by restore().
    const resetData = async (say: (m: string) => void = log) => {
      throwIfAborted(signal);
      say('Resetting the database');
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
        say('Running the seed command');
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
          say(`Warning: seed command ${why}; continuing (see ${setupLog})`);
        }
      }
    };
    const startOne = async (name: ServiceName, say: (m: string) => void = log) => {
      const service = config[name];
      const env = serviceEnv(config, name, configOverride);
      if (service.envFile) await writeFile(path.join(dir(service.cwd), service.envFile), formatEnvFile(env));
      say(`Starting ${name}: ${service.start}`);
      return startService(name, service.start, { cwd: dir(service.cwd), env: childEnv(env), logFile: path.join(logsDir, `${name}.log`) });
    };

    await resetData();
    for (const name of ['backend', 'frontend'] as ServiceName[]) {
      throwIfAborted(signal);
      services.push(await startOne(name));
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

    // A seed script can fail and still exit 0, so one request proves the data is there. Skipped when the
    // backend is unhealthy: then the broken environment itself is what the tests should see.
    let seedCheck: SeedCheckResult | undefined;
    const backendHealthy = healthChecks.find((c) => c.name === 'backend')?.ok === true;
    if (config.seedCheck && !options.skipSeed && backendHealthy) {
      const { method, path: checkPath } = config.seedCheck;
      seedCheck = await runSeedCheck(config.backend.baseUrl, config.seedCheck, config.fixtures);
      appendFileSync(setupLog, `[seed check] ${method} ${checkPath}: ${seedCheck.detail}\n`);
      if (!seedCheck.ok) {
        const message = `Seed check failed: ${method} ${checkPath}: ${seedCheck.detail}`;
        // Only a clean start can blame the seed. On a variant or an environment fault, the app's own bug
        // may be what broke the check, so it is recorded and the tests still run.
        if (isCleanStart(config, options)) throw new Error(`${message}. See ${setupLog}`);
        log(`Warning: ${message}; recorded, continuing`);
      } else {
        log('Seed check passed');
      }
    }
    const restore = async () => {
      const started = Date.now();
      const quiet = () => {}; // runs after every dry run: the setup log has the details
      await resetData(quiet);
      const index = services.findIndex((s) => s.name === 'backend');
      if (index >= 0) await stopProcessGroup(services[index]!.pid);
      const backend = await startOne('backend', quiet);
      if (index >= 0) services[index] = backend;
      else services.push(backend);
      const health = await waitForHealthy('backend', config.backend.healthCheckUrl, { timeoutMs: startupTimeoutMs, giveUp: backend.exited, signal });
      if (!health.ok) throw new Error(`Restore: the backend did not become healthy again; see ${logsDir}`);
      if (!options.skipSeed) {
        const seeded = await sendSeedRequests(config.backend.baseUrl, config.seed, config.fixtures);
        const failed = seeded.find((r) => !r.ok);
        if (failed) throw new Error(`Restore: seed request ${failed.request} failed (status ${failed.status ?? 'no response'})`);
        if (config.seedCheck) {
          const check = await runSeedCheck(config.backend.baseUrl, config.seedCheck, config.fixtures);
          if (!check.ok) throw new Error(`Restore: seed check failed: ${check.detail}`);
        }
      }
      appendFileSync(setupLog, `[restore] done in ${Date.now() - started} ms\n`);
      return { durationMs: Date.now() - started };
    };
    return { commit, healthChecks, seed, ...(seedCheck && { seedCheck }), services, restore, stop };
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
