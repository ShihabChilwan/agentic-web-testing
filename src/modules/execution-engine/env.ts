import type { ConfigOverride, TargetConfig } from '../../shared/schemas.js';

export type Env = Record<string, string>;
export type ServiceName = 'backend' | 'frontend';

/** The only variables child processes inherit from the pipeline (which holds LLM keys in its env). */
const INHERITED = ['PATH', 'HOME'] as const;

export function baseEnv(parent: NodeJS.ProcessEnv = process.env): Env {
  const env: Env = {};
  for (const name of INHERITED) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** Applies override values over an env: a string sets the variable, null removes it. */
export function applyOverride(env: Env, override: Record<string, string | null> = {}): Env {
  const result = { ...env };
  for (const [name, value] of Object.entries(override)) {
    if (value === null) delete result[name];
    else result[name] = value;
  }
  return result;
}

/** A service's own env: config `env` (plus `disabledServices` for the backend), then the override. */
export function serviceEnv(config: TargetConfig, service: ServiceName, override?: ConfigOverride): Env {
  const configured =
    service === 'backend' ? { ...config.backend.env, ...config.backend.disabledServices } : { ...config.frontend.env };
  return applyOverride(configured, override?.[service]?.env);
}

/** Full env for a child process: PATH and HOME, plus the given variables. */
export function childEnv(env: Env = {}, parent: NodeJS.ProcessEnv = process.env): Env {
  return { ...baseEnv(parent), ...env };
}

const PLAIN_VALUE = /^[A-Za-z0-9_./:@,+-]*$/;

/** Formats an env as .env file lines. Values with other characters are single-quoted (taken literally by dotenv). */
export function formatEnvFile(env: Env): string {
  const lines = Object.entries(env).map(([name, value]) => {
    if (PLAIN_VALUE.test(value)) return `${name}=${value}`;
    if (!value.includes("'") && !value.includes('\n')) return `${name}='${value}'`;
    throw new Error(`Cannot write ${name} to an env file: its value contains a quote or a line break`);
  });
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}
