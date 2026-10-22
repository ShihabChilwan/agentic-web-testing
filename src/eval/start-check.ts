import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildSourceTree, startTarget, type RunningTarget } from '../modules/execution-engine/index.js';
import type { ConfigOverride, EvaluationConfig, TargetConfig } from '../shared/schemas.js';

/** A crash shortly after the health checks still counts as a failed start. */
const SETTLE_MS = 3000;

const SERVICES = ['backend', 'frontend'] as const;
type Service = (typeof SERVICES)[number];

export interface StartObservation {
  healthChecks: Record<Service, boolean>;
  /** How a service's process exited, or null while it still ran. */
  exited: Record<Service, { code: number | null; signal: string | null } | null>;
  /** Services whose log matched their build-error pattern. */
  buildErrors: Service[];
}

export interface StartCheckOptions {
  config: TargetConfig;
  repoDir: string;
  targetDir: string;
  commit: string;
  patchFile?: string;
  configOverride?: ConfigOverride;
  skipSeed?: boolean;
  /** Where this start's backend.log, frontend.log and setup.log go. */
  logsDir: string;
  buildErrorPattern: EvaluationConfig['buildErrorPattern'];
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export type StartCheck<T> = { patchFailed: string } | { observation: StartObservation; probe: T | undefined };

/**
 * Builds a golden source tree with the optional patch (the same `git apply` an execution does, SPEC §7.5),
 * starts the app with the Execution Engine's lifecycle, records health checks, exits and build errors,
 * runs `probe` while the app is up, and stops and removes everything.
 */
export async function startCheck<T = undefined>(
  options: StartCheckOptions,
  probe?: (target: RunningTarget) => Promise<T>,
): Promise<StartCheck<T>> {
  const { config } = options;
  let tree;
  try {
    tree = await buildSourceTree({
      repoDir: options.repoDir,
      commit: options.commit,
      ...(options.patchFile ? { patchFile: options.patchFile } : {}),
      linkNodeModules: [config.backend.cwd, config.frontend.cwd],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('git apply')) return { patchFailed: message };
    throw err;
  }
  try {
    const target = await startTarget(config, {
      ref: config.goldenRef,
      repoDir: tree.dir,
      prepared: { commit: options.commit, patched: options.patchFile !== undefined },
      targetDir: options.targetDir,
      logsDir: options.logsDir,
      ...(options.configOverride ? { configOverride: options.configOverride } : {}),
      ...(options.skipSeed ? { skipSeed: true } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      log: options.log ?? (() => {}),
    });
    try {
      await sleep(SETTLE_MS);
      const result = probe ? await probe(target) : undefined;
      const health = (name: Service) => target.healthChecks.find((c) => c.name === name)?.ok === true;
      const buildErrors: Service[] = [];
      for (const name of SERVICES) {
        const pattern = options.buildErrorPattern[name];
        if (!pattern) continue;
        const text = await readFile(path.join(options.logsDir, `${name}.log`), 'utf8').catch(() => '');
        if (new RegExp(pattern).test(text)) buildErrors.push(name);
      }
      const exit = (name: Service) => {
        const e = target.exitOf(name);
        return e ? { code: e.code, signal: e.signal } : null;
      };
      return {
        observation: {
          healthChecks: { backend: health('backend'), frontend: health('frontend') },
          exited: { backend: exit('backend'), frontend: exit('frontend') },
          buildErrors,
        },
        probe: result,
      };
    } finally {
      await target.stop();
    }
  } finally {
    await tree.remove();
  }
}

/** Why a start check means the variant cannot be used (SPEC §11.2 step 6), or null when it is kept. */
export function startFailure(o: StartObservation): string | null {
  const problems: string[] = [];
  for (const name of SERVICES) {
    const e = o.exited[name];
    if (e) problems.push(`${name} exited (code ${e.code ?? 'none'}${e.signal ? `, signal ${e.signal}` : ''})`);
  }
  for (const name of o.buildErrors) problems.push(`${name} build failed`);
  return problems.length > 0 ? problems.join('; ') : null;
}
