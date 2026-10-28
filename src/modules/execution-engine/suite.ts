import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TargetConfig } from '../../shared/schemas.js';
import { uiBaseUrl } from '../../shared/target-ui.js';

/** What the helpers read from `_target.json`: base URLs, fixtures and login settings (SPEC §6.1). */
export function targetSettings(config: TargetConfig) {
  return { apiUrl: config.backend.baseUrl, uiUrl: uiBaseUrl(config), fixtures: config.fixtures, auth: config.auth };
}

/**
 * The suite's `_helpers.ts`: the run's own helpers (copied as `_helpers.base.ts`, so the run's scripts,
 * helpers and helpersHash stay untouched) plus an automatic fixture that asks the Execution Engine's
 * control endpoint to restore the data before every test (SPEC §7.2).
 */
const EXECUTION_HELPERS = `// Execution helpers: the run's helpers plus a data restore before every test, through the
// Execution Engine's control endpoint on 127.0.0.1. Generated for this execution.
import path from 'node:path';
import { test as base } from './_helpers.base.js';

export * from './_helpers.base.js';

const CONTROL_URL = process.env.AWT_CONTROL_URL;
const TIMEOUT_MS = Number(process.env.AWT_RESTORE_TIMEOUT_MS ?? '600000');

async function control(step: 'before' | 'after', body: Record<string, string>): Promise<void> {
  if (!CONTROL_URL) throw new Error('AWT_CONTROL_URL is not set: run this suite through the Execution Engine');
  const res = await fetch(\`\${CONTROL_URL}/\${step}\`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(\`Control endpoint /\${step} answered \${res.status}: \${await res.text()}\`);
}

export const test = base.extend<{ _isolation: void }>({
  // Its own timeout: restore time counts neither against the test timeout nor in the test's duration.
  _isolation: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, testInfo) => {
      const testId = path.basename(testInfo.file).replace(/\\.spec\\.ts$/, '');
      await control('before', { testId });
      await use();
      await control('after', { testId, outputDir: testInfo.outputDir });
    },
    { auto: true, timeout: TIMEOUT_MS },
  ],
});
`;

function playwrightConfig(uiUrl: string): string {
  return `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './suite',
  outputDir: './test-results',
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [['json', { outputFile: 'report.json' }], ['line']],
  use: { baseURL: ${JSON.stringify(uiUrl)}, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
`;
}

/**
 * Writes `<execDir>/suite/` (the scripts to run, the run's helpers as `_helpers.base.ts`, the execution
 * helpers and `_target.json` from the target config) and `<execDir>/playwright.config.ts`.
 */
export async function buildSuite(execDir: string, scriptsDir: string, testIds: readonly string[], config: TargetConfig): Promise<string> {
  const suiteDir = path.join(execDir, 'suite');
  await mkdir(suiteDir, { recursive: true });
  for (const id of testIds) await copyFile(path.join(scriptsDir, `${id}.spec.ts`), path.join(suiteDir, `${id}.spec.ts`));
  await copyFile(path.join(scriptsDir, '_helpers.ts'), path.join(suiteDir, '_helpers.base.ts'));
  await writeFile(path.join(suiteDir, '_helpers.ts'), EXECUTION_HELPERS, 'utf8');
  await writeFile(path.join(suiteDir, '_target.json'), `${JSON.stringify(targetSettings(config), null, 2)}\n`, 'utf8');
  await writeFile(path.join(execDir, 'playwright.config.ts'), playwrightConfig(uiBaseUrl(config)), 'utf8');
  return suiteDir;
}
