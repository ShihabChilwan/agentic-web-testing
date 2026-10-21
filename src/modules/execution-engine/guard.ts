import type { TargetConfig } from '../../shared/schemas.js';
import { fillPlaceholders } from './placeholders.js';
import { valueAtPath } from './seed.js';

export interface FixtureGuardResult {
  /** Fixture users whose login no longer works (e.g. "users.alice"): a test changed them. */
  broken: string[];
  /** True when the backend did not answer at all: not a fixture change, but the app is down. */
  unreachable: boolean;
}

/**
 * Logs in as every fixture user with the target's auth settings (about 50 ms each). A failed login after
 * a test means that test changed a fixture user (email, password, deleted). Without auth settings there
 * is nothing to check.
 */
export async function checkFixtureLogins(config: TargetConfig, timeoutMs = 10_000): Promise<FixtureGuardResult> {
  const auth = config.auth;
  if (!auth) return { broken: [], unreachable: false };
  const broken: string[] = [];
  for (const [name, user] of Object.entries(config.fixtures.users)) {
    try {
      const res = await fetch(new URL(auth.login.path, config.backend.baseUrl), {
        method: auth.login.method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(fillPlaceholders(auth.login.body, { user })),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body: unknown = await res.json().catch(() => null);
      const token = valueAtPath(body, auth.tokenAt);
      if (res.status >= 400 || typeof token !== 'string' || token === '') broken.push(`users.${name}`);
    } catch {
      return { broken, unreachable: true };
    }
  }
  return { broken, unreachable: false };
}
