import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, buildTask } from '../../src/modules/prd-generator/prompt.js';
import { buildReviewTask } from '../../src/modules/script-generator/review.js';
import { buildFeatureTask } from '../../src/modules/test-case-generator/context.js';
import { PROJECT_ROOT } from '../../src/shared/paths.js';
import { TargetConfig } from '../../src/shared/schemas.js';
import { loadTargetConfig } from '../../src/shared/target-config.js';
import { renderSettings, visibleEnvProblems } from '../../src/shared/target-settings.js';
import { example } from './schemas/helpers.js';

const withVisible = (names: string[], env: Record<string, string> = {}, disabled: Record<string, string> = {}) => {
  const c = structuredClone(example('target.config.json'));
  c.backend.env = { PORT: '3000', ANON: 'false', DB_URL: 'postgres://app:pw@db/x', API_TOKEN: 'abc', ...env };
  c.backend.disabledServices = { MAIL_ON: '', ...disabled };
  c.backend.visibleEnv = names;
  return c;
};

describe('visibleEnv (the settings the agents may read)', () => {
  it('renders the listed names with their values, an empty value as (empty), and nothing when none is listed', () => {
    const config = TargetConfig.parse(withVisible(['ANON', 'MAIL_ON']));
    expect(renderSettings(config)).toBe('Settings this application runs with here (they can differ from the defaults in the code): ANON=false, MAIL_ON=(empty).');
    expect(renderSettings(TargetConfig.parse(withVisible([])))).toBeNull();
    expect(renderSettings(TargetConfig.parse(example('target.config.json')))).toBeNull();
  });

  it('refuses a name that is not in the env, a name that looks secret and a value with credentials', () => {
    expect(TargetConfig.safeParse(withVisible(['NOPE'])).success).toBe(false);
    expect(TargetConfig.safeParse(withVisible(['API_TOKEN'])).success).toBe(false);
    expect(TargetConfig.safeParse(withVisible(['DB_URL'])).success).toBe(false);
    const problems = visibleEnvProblems(withVisible(['NOPE', 'API_TOKEN', 'DB_URL']));
    expect(problems).toHaveLength(3);
    expect(problems.join('\n')).not.toContain('abc'); // a problem message never repeats a value
    expect(problems.join('\n')).not.toContain('pw@');
  });

  it('shows frontend settings with a prefix', () => {
    const c = withVisible(['ANON']);
    c.frontend.env = { MODE: 'test' };
    c.frontend.visibleEnv = ['MODE'];
    expect(renderSettings(TargetConfig.parse(c))).toContain('ANON=false, frontend.MODE=test.');
  });
});

describe('where the settings are shown', () => {
  const config = TargetConfig.parse(withVisible(['ANON']));
  const settings = renderSettings(config)!;

  it('is in the PRD task, with the system rule to state behaviour under the settings', () => {
    expect(buildTask(config)).toContain(settings);
    expect(buildSystemPrompt()).toContain('Write each requirement for the behaviour under those settings');
    expect(buildTask(TargetConfig.parse(example('target.config.json')))).not.toContain('Settings this application runs with');
  });

  it('is in the test case task and in the review task', () => {
    const task = buildFeatureTask({ feature: { id: 'F-01', name: 'x', description: 'y' }, requirements: [], quota: 1, evidence: { blocks: [], omitted: [] }, config });
    expect(task).toContain(settings);
    const tc = { id: 'TC-001', requirementIds: [], title: 't', layer: 'api', category: 'auth', priority: 'high', preconditions: [], fixturesUsed: [], steps: [], expected: [{ id: 'E1', description: 'd', value: 401 }] } as never;
    const review = buildReviewTask({ tc, requirements: [], expectationId: 'E1', message: 'm', received: '201', context: {}, script: 's', settings });
    expect(review).toContain(settings);
    expect(buildReviewTask({ tc, requirements: [], expectationId: 'E1', message: 'm', received: '201', context: {}, script: 's' })).not.toContain('## Settings');
  });

  it('never reaches the failure analyzer: its code does not use the settings', () => {
    const dir = path.join(PROJECT_ROOT, 'src/modules/failure-analyzer');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      expect(readFileSync(path.join(dir, file), 'utf8'), file).not.toMatch(/renderSettings|target-settings|visibleEnv/);
    }
  });
});

describe('the real targets', () => {
  it('Kutt shows the switch that made TC-007 a false alarm, and no secret anywhere', async () => {
    for (const name of ['mern-ecommerce', 'kutt', 'kutt-pg']) {
      const { config } = await loadTargetConfig(name);
      const text = renderSettings(config) ?? '';
      expect(text, name).not.toMatch(/SECRET|PASSWORD|TOKEN|KEY/i);
      if (name !== 'mern-ecommerce') expect(text).toContain('DISALLOW_ANONYMOUS_LINKS=false');
    }
    expect(renderSettings((await loadTargetConfig('kutt-pg')).config)).toContain('DB_CLIENT=pg');
  });
});
