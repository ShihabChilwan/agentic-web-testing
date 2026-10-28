import { mkdir, mkdtemp, rm, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Mutex, trimDom } from '../../src/modules/script-generator/dry-run.js';
import { scriptsSummary } from '../../src/modules/script-generator/generate.js';
import { findExpects, gotoAfterAction, lockCheck } from '../../src/modules/script-generator/lock-check.js';
import { bodyLineOffset, renderExpected, renderScript } from '../../src/modules/script-generator/render.js';
import { TypeChecker } from '../../src/modules/script-generator/typecheck.js';
import { PROJECT_ROOT } from '../../src/shared/paths.js';
import type { ScriptManifestEntry, TestCase } from '../../src/shared/schemas.js';

const tc: TestCase = {
  id: 'TC-004',
  requirementIds: ['REQ-002'],
  title: "Login with a wrong password is rejected",
  layer: 'ui',
  category: 'error-handling',
  priority: 'high',
  preconditions: [],
  fixturesUsed: ['users.alice'],
  steps: ['Open /login'],
  expected: [
    { id: 'E1', description: 'An error message is visible' },
    { id: 'E2', description: "The message says it's wrong", value: "Password isn't right" },
    { id: 'E3', description: 'Status', value: 400 },
  ],
};
const fixtures = { users: { alice: { email: 'alice@example.test', password: 'Passw0rd!alice' } } };
const good = `await page.goto('/login');
await expect(page.getByRole('alert'), 'E1').toBeVisible();
await expect(page.getByRole('alert'), 'E2').toHaveText(EXPECTED.E2.value);
const res = await api.post('/api/auth/login', { data: { email: fixtures.users.alice.email, password: 'x' } });
expect(res.status(), 'E3').toBe(EXPECTED.E3.value);`;
const check = (body: string, file = renderScript(tc, body)) => lockCheck(tc, file, body, fixtures);

describe('render', () => {
  it('renders the EXPECTED block from the test case, escaping quotes', () => {
    expect(renderExpected(tc)).toBe(
      [
        '// @locked-expected TC-004: generated from testcases.json. Do not edit.',
        'const EXPECTED = {',
        "  E1: { description: 'An error message is visible' },",
        "  E2: { description: 'The message says it\\'s wrong', value: 'Password isn\\'t right' },",
        "  E3: { description: 'Status', value: 400 },",
        '} as const;',
        '// @end-locked-expected',
      ].join('\n'),
    );
  });

  it('wraps the body in the test, with page only for ui test cases', () => {
    const file = renderScript(tc, 'await page.goto("/");');
    expect(file).toContain("test('TC-004: Login with a wrong password is rejected', async ({ page, api }) => {\n  await page.goto(\"/\");\n});");
    expect(renderScript({ ...tc, layer: 'api' }, 'x();')).toContain('async ({ api }) => {');
    expect(file.split('\n')[bodyLineOffset(tc)]).toBe('  await page.goto("/");');
  });
});

describe('lockCheck', () => {
  it('accepts a body that checks every expectation the right way', () => {
    expect(check(good)).toEqual([]);
  });

  it('requires an expect with the id as message for every expectation', () => {
    expect(check(good.replace("'E1'", "'first'"))).toEqual([
      "E1 is not checked: add an expect whose message is 'E1', e.g. expect(x, 'E1').toBe(...)",
    ]);
  });

  it('rejects a value used inside the locator, and a value not compared by a value matcher', () => {
    const inLocator = good.replace("await expect(page.getByRole('alert'), 'E2').toHaveText(EXPECTED.E2.value);", "await expect(page.getByText(EXPECTED.E2.value), 'E2').toBeVisible();");
    const problems = check(inLocator);
    expect(problems[0]).toMatch(/^E2: EXPECTED.E2.value must not be used inside expect's first argument/);
    expect(problems[1]).toMatch(/^E2 has a locked value: compare it with a value matcher/);
    expect(check(good.replace('toBe(EXPECTED.E3.value)', 'toBe(400)'))).toEqual([
      expect.stringMatching(/^E3 has a locked value/),
    ]);
  });

  it('finds expects through .not and expect.soft', () => {
    const uses = findExpects("await expect.soft(page.getByRole('alert', { name: 'x' }), 'E2').not.toHaveText(EXPECTED.E2.value);");
    expect(uses).toEqual([{ id: 'E2', subject: "page.getByRole('alert', { name: 'x' })", matcher: 'toHaveText', matcherArgs: 'EXPECTED.E2.value' }]);
  });

  it('rejects edits to EXPECTED, imports, fixed sleeps and literal fixture credentials', () => {
    expect(check(good, renderScript(tc, good).replace('value: 400', 'value: 200'))).toContain(
      'The locked EXPECTED block was changed; it is written for you and must stay as it is.',
    );
    expect(check(`${good}\nconst EXPECTED = {};`)).toContain('The body must not define or edit EXPECTED; use the block that is already in the file.');
    expect(check(`${good}\nimport x from 'y';`)).toContain('The body must not import anything; everything you need is already imported.');
    expect(check(`${good}\nawait page.waitForTimeout(500);`)).toContain('Do not use waitForTimeout; wait for a locator, a URL or a response instead.');
    expect(check(good.replace('fixtures.users.alice.email', "'alice@example.test'"))).toEqual([
      'Do not write fixture data as a literal ("alice@example.test"); use fixtures.<path>, e.g. fixtures.users.<name>.email.',
    ]);
  });

  it('rejects a page.goto right after a page action with nothing awaited between (TC-018)', () => {
    const racing = "await page.getByRole('button', { name: 'Add Address' }).click();\n\nawait page.goto('/dashboard/address');";
    expect(gotoAfterAction(racing)).toEqual([
      expect.stringMatching(/^Body line 3: page.goto follows a page action with nothing awaited in between/),
    ]);
    expect(check(`${good}\n${racing}`).some((p) => p.includes('net::ERR_ABORTED'))).toBe(true);
    for (const wait of ["await page.waitForURL('**/dashboard/address');", "await expect(page.getByRole('alert')).toBeVisible();", "await page.waitForResponse((r) => r.url().includes('/api/address'));", "await page.getByText('Saved').waitFor();"]) {
      expect(gotoAfterAction(racing.replace('\n\n', `\n${wait}\n`))).toEqual([]);
    }
    expect(gotoAfterAction("await page.goto('/a');\nawait page.goto('/b');")).toEqual([]); // no action before
    expect(gotoAfterAction("await page.getByRole('button').click(); await expect(x).toBeVisible(); await page.goto('/b');")).toEqual([]);
  });

  it('rejects res.json(), which throws on an error body that is not JSON', () => {
    const rule = 'Read response bodies with await bodyOf(res), not res.json(): an error response may not be JSON (e.g. a plain "Unauthorized"), and res.json() then throws before any check runs.';
    expect(check(`${good}\nconst body = await res.json();`)).toEqual([rule]);
    expect(check(`${good}\nconst body = await (await api.get('/api/me')).json( );`)).toEqual([rule]);
    expect(check(`${good}\nconst body = await bodyOf(res);\nawait page.route('**/x', (r) => r.fulfill({ json: body }));`)).toEqual([]);
  });
});

describe('TypeChecker', () => {
  let dir: string;
  beforeAll(async () => {
    await mkdir(path.join(PROJECT_ROOT, 'runs'), { recursive: true });
    dir = await mkdtemp(path.join(PROJECT_ROOT, 'runs', '.typecheck-test-'));
    await copyFile(path.join(PROJECT_ROOT, 'src/modules/script-generator/template/_helpers.ts'), path.join(dir, '_helpers.ts'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('passes a valid script and reports errors with body line numbers', { timeout: 60_000 }, async () => {
    const checker = new TypeChecker();
    const file = path.join(dir, 'TC-004.spec.ts');
    await writeFile(file, renderScript(tc, good));
    expect(checker.check(file, bodyLineOffset(tc))).toEqual([]);
    await writeFile(file, renderScript(tc, `${good}\nawait page.evaluate(() => localStorage.getItem('token'));`));
    expect(checker.check(file, bodyLineOffset(tc))).toEqual([]); // browser names are known inside page.evaluate
    await writeFile(file, renderScript(tc, `${good}\nconst { token } = await loginViaApi(fixtures.users.alice);`));
    expect(checker.check(file, bodyLineOffset(tc))[0]).toMatch(/Property 'token' does not exist/); // only headers are handed out
    await writeFile(file, renderScript(tc, `${good}\nconst n: number = 'text';`));
    expect(checker.check(file, bodyLineOffset(tc))).toEqual([
      expect.stringMatching(/^body line 6, column \d+: Type 'string' is not assignable to type 'number'\./),
    ]);
  });
});

describe('dry-run helpers', () => {
  it('runs mutex tasks one at a time, in order, even when one fails', async () => {
    const mutex = new Mutex();
    const log: string[] = [];
    let running = 0;
    const task = (name: string, fail = false) =>
      mutex.run(async () => {
        running++;
        expect(running).toBe(1);
        log.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, 10));
        log.push(`end ${name}`);
        running--;
        if (fail) throw new Error(name);
        return name;
      });
    const results = await Promise.allSettled([task('a'), task('b', true), task('c')]);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });

  it('trims page HTML for the model', () => {
    expect(trimDom('<html><script>x()</script><style>p{}</style><svg><path/></svg><!-- c --><p>  Hi  </p></html>')).toBe('<html><svg/><p> Hi </p></html>');
    expect(trimDom('x'.repeat(20), 10)).toBe('xxxxxxxxxx… [trimmed]');
  });
});

describe('scriptsSummary', () => {
  it('counts outcomes, attempts, failures by stage and invalid cases by category', () => {
    const entry = (id: string, over: Partial<ScriptManifestEntry>): ScriptManifestEntry => ({
      testCaseId: id, file: `scripts/${id}.spec.ts`, status: 'validated', validationOutcome: 'passed', attempts: 1,
      attemptLog: [{ attempt: 1, stage: 'dry-run', error: null, durationMs: 1 }], failureCategory: null, ...over,
    });
    const s = scriptsSummary(
      [
        entry('TC-001', {}),
        entry('TC-002', { validationOutcome: 'assertion_failed' }),
        entry('TC-003', {
          status: 'invalid', validationOutcome: null, attempts: 3, failureCategory: 'value-less-expect',
          attemptLog: [
            { attempt: 1, stage: 'typecheck', error: 'x', category: 'typecheck', durationMs: 1 },
            { attempt: 2, stage: 'dry-run', error: 'x', category: 'locator', durationMs: 1 },
            { attempt: 3, stage: 'dry-run', error: 'x', category: 'value-less-expect', durationMs: 1 },
          ],
        }),
      ],
      { calls: 5, costUsd: 0.01, dryRunMs: 100, playwrightVersion: '1.64.0', warnings: [] },
    );
    expect(s).toMatchObject({
      cases: 3,
      validated: { passed: 1, assertionFailed: 1 },
      invalid: 1,
      attemptsHistogram: { '1': 2, '2': 0, '3': 1 },
      failuresByStage: { submit: 0, typecheck: 1, 'lock-check': 0, 'dry-run': 2 },
      invalidByCategory: { 'value-less-expect': 1, locator: 0 },
      invalidCases: { 'value-less-expect': ['TC-003'] },
    });
  });
});
