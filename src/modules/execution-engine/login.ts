import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { PROJECT_ROOT } from '../../shared/paths.js';
import type { TargetConfig } from '../../shared/schemas.js';
import { uiBaseUrl } from '../../shared/target-ui.js';
import { fillPlaceholders } from './placeholders.js';
import { valueAtPath } from './seed.js';

const execFileAsync = promisify(execFile);

export interface LoginResult {
  /** True when the login gave a token. */
  ok: boolean;
  /** HTTP status of a login request; null for a login command. */
  status: number | null;
  token: string | null;
}

/** The target's own folder (`targets/<name>/`), where a login command runs. */
export const targetFolder = (config: Pick<TargetConfig, 'name'>): string => path.join(PROJECT_ROOT, 'targets', config.name);

/** `AWT_USER_<FIELD>` for each text, number or boolean field of the fixture user, plus the app's URLs. */
export function loginEnv(config: TargetConfig, user: unknown): Record<string, string> {
  const env: Record<string, string> = { AWT_API_URL: config.backend.baseUrl, AWT_UI_URL: uiBaseUrl(config) };
  for (const [key, value] of Object.entries(user && typeof user === 'object' ? user : {})) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') env[`AWT_USER_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] = String(value);
  }
  return env;
}

/**
 * Logs in as a fixture user the way the target's auth settings say: one HTTP request (JSON or form-encoded body,
 * the token at `tokenAt`), or the login command's output. A login request that gets no answer throws; a login that
 * is refused, or a command that fails, returns `ok: false`.
 */
export async function loginFixture(config: TargetConfig, user: unknown, options: { timeoutMs?: number; cwd?: string } = {}): Promise<LoginResult> {
  const auth = config.auth;
  if (!auth) return { ok: false, status: null, token: null };
  const timeoutMs = options.timeoutMs ?? 10_000;
  const login = auth.login;
  if ('command' in login) {
    try {
      const { stdout } = await execFileAsync('/bin/sh', ['-c', login.command], {
        cwd: options.cwd ?? targetFolder(config),
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...loginEnv(config, user) },
        timeout: Math.max(timeoutMs, 30_000),
        maxBuffer: 1024 * 1024,
      });
      const token = stdout.trim();
      return { ok: token !== '', status: null, token: token === '' ? null : token };
    } catch {
      return { ok: false, status: null, token: null };
    }
  }
  const body = fillPlaceholders(login.body, { user });
  const form = login.encoding === 'form';
  const res = await fetch(new URL(login.path, config.backend.baseUrl), {
    method: login.method,
    headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
    body: form ? new URLSearchParams(Object.entries((body ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)] as [string, string])).toString() : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const found = valueAtPath(await res.json().catch(() => null), auth.tokenAt ?? '');
  const token = typeof found === 'string' && found !== '' ? found : null;
  return { ok: res.status < 400 && token !== null, status: res.status, token };
}
