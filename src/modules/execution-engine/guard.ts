import type { TargetConfig } from '../../shared/schemas.js';
import { loginFixture } from './login.js';

export interface FixtureGuardResult {
  /** Fixture users whose login no longer works (e.g. "users.<name>"): a test changed them. */
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
      if (!(await loginFixture(config, user, { timeoutMs })).ok) broken.push(`users.${name}`);
    } catch {
      return { broken, unreachable: true };
    }
  }
  return { broken, unreachable: false };
}
