import type { TargetConfig } from './schemas.js';

// The settings of the target that the agents may read (SPEC §1.2 `visibleEnv`): a list of names in the config, never a
// scan of the whole environment. Only the golden config is shown; an environment fault overrides values at execution.

/** Names that look like secrets; a config may not list them. */
const SECRET_NAME = /SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE|KEY|CREDENTIAL/i;
/** A URL with credentials in it (scheme://user:password@host). */
const CREDENTIAL_URL = /:\/\/[^/\s:@]+:[^/\s@]+@/;

type Settings = Pick<TargetConfig, 'backend'> & { frontend?: Pick<NonNullable<TargetConfig['frontend']>, 'env' | 'visibleEnv'> };

/** What the config's `visibleEnv` lists wrongly: unknown names, names that look secret, values with credentials. */
export function visibleEnvProblems(config: Settings): string[] {
  const problems: string[] = [];
  const check = (service: string, names: readonly string[] | undefined, values: Record<string, string>) => {
    for (const name of names ?? []) {
      if (!(name in values)) problems.push(`${service}.visibleEnv lists ${name}, which is not in the ${service} env${service === 'backend' ? ' or disabledServices' : ''}`);
      else if (SECRET_NAME.test(name)) problems.push(`${service}.visibleEnv lists ${name}: a name that looks like a secret is never shown to the agents`);
      else if (CREDENTIAL_URL.test(values[name]!)) problems.push(`${service}.visibleEnv lists ${name}, whose value holds credentials`);
    }
  };
  check('backend', config.backend.visibleEnv, { ...config.backend.env, ...config.backend.disabledServices });
  if (config.frontend) check('frontend', config.frontend.visibleEnv, config.frontend.env);
  return problems;
}

/**
 * The settings line for the agents' task messages, or null when the config lists none: "Settings this application
 * runs with here: NAME=value, …" (an empty value is shown as "(empty)"). The names are the config's own; frontend
 * settings carry a "frontend." prefix.
 */
export function renderSettings(config: Settings): string | null {
  const backend = { ...config.backend.env, ...config.backend.disabledServices };
  const items = [
    ...(config.backend.visibleEnv ?? []).map((name) => `${name}=${backend[name] || '(empty)'}`),
    ...(config.frontend?.visibleEnv ?? []).map((name) => `frontend.${name}=${config.frontend!.env[name] || '(empty)'}`),
  ];
  return items.length > 0 ? `Settings this application runs with here (they can differ from the defaults in the code): ${items.join(', ')}.` : null;
}
