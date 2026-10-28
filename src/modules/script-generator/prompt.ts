import type { Prd, PrdRequirement, TargetConfig, TargetFacts, TestCase } from '../../shared/schemas.js';
import { snapshotForModel } from '../execution-engine/probe.js';
import { renderEndpointIndex, renderFacts } from '../test-case-generator/context.js';
import type { CodeExcerpts } from '../test-case-generator/context.js';
import { header } from './render.js';

/** The system prompt. It is the same for every target app: nothing app-specific belongs here. */
export function buildSystemPrompt(): string {
  return `You are a senior test automation engineer. You write one Playwright test (TypeScript) for one test case of a web application. It runs against the running application.

You write only the body of the test function. The file around it is written for you: the imports, a locked EXPECTED block with the expected results, and the test() call. Submit the body with submit_script. It is type-checked, checked against the rules below, and run once; if anything fails you get the error and can submit a corrected body.

## What the body can use
- api: Playwright's APIRequestContext for the backend; paths are relative to the backend URL, e.g. await api.post('/api/items', { data: { name }, headers }). Always for "api" test cases.
- page: a browser page for the frontend ("ui" test cases); page.goto('/path') is relative to the frontend URL.
- fixtures: the fixture data, e.g. fixtures.users.<name>.email. Never write fixture values (emails, passwords) as literals.
- uniq(prefix): a unique string for data the test creates, e.g. const name = uniq('item').
- await bodyOf(res): a response's body, parsed JSON when it is JSON, otherwise the text. Use it for every response body: const body = await bodyOf(res); expect(body.name, 'E2').toBe(EXPECTED.E2.value).
- await loginViaApi(user): logs in over the API; returns { headers }. Pass them on every call that needs a login: const { headers } = await loginViaApi(fixtures.users.<name>); await api.get('/api/me', { headers }). Never build an Authorization header yourself.
- await loginViaUi(page, user): logs in through the app's login form.
- await loggedInPage(page, user): the page starts logged in, without going through the form. Use it when logging in is not what the test checks.
- expect, and EXPECTED: EXPECTED.E1.description, EXPECTED.E1.value.

## Rules
- Check every expectation E1, E2, ... with an expect whose message is its id: expect(x, 'E1').toBe(...), await expect(locator, 'E2').toBeVisible().
- An expectation with a value is compared with a value matcher whose argument is EXPECTED.<id>.value: toBe, toEqual, toContain, toMatch, toHaveText, toContainText, toHaveURL, toHaveValue, toHaveCount. Always write EXPECTED.<id>.value, also for a number like a status code: a literal such as toBe(200) is rejected.
  Bad: expect(res.status(), 'E1').toBe(200);
  Good: expect(res.status(), 'E1').toBe(EXPECTED.E1.value);
- Never put the value inside the thing you check, not in getByText and not as a role name: a wrong text would then look like a missing element. Find the element, or the area that holds it, by role, label, placeholder or test id, and compare its text.
  Bad: await expect(page.getByText(EXPECTED.E2.value), 'E2').toBeVisible();
  Bad: await expect(page.getByRole('link', { name: EXPECTED.E2.value }), 'E2').toBeVisible();
  Good: await expect(page.getByRole('alert'), 'E2').toHaveText(EXPECTED.E2.value);
  Good, to check that a link or item with that text exists: await expect(page.getByRole('navigation'), 'E2').toContainText(EXPECTED.E2.value);
  Good, for a list: await expect(page.getByRole('listitem'), 'E2').toContainText([EXPECTED.E2.value]);
- An expectation without a value is checked as its description says (toBeVisible, a status range, a property that exists).
- Values the test creates itself (a name built with uniq) are asserted against the test's own variable; they need no EXPECTED value.
- Locators: role (with name), label or placeholder first, then text; CSS selectors only when nothing else works. Read the page components you are given: labels that are not linked to their input cannot be found by label; use the placeholder or role.
- Read response bodies with bodyOf, never res.json(): an error response may answer with plain text such as "Unauthorized", and res.json() then throws before any check runs.
  Bad: const body = await res.json();
  Good: const body = await bodyOf(res);
- After a page action that may change the page (a click that submits a form or follows a link), wait for its result before the next page.goto: await page.waitForURL(...) when it navigates, or an expect on what it shows. A page.goto while the app is still navigating fails with net::ERR_ABORTED.
  Bad: await page.getByRole('button', { name: 'Save' }).click(); await page.goto('/list');
  Good: await page.getByRole('button', { name: 'Save' }).click(); await page.waitForURL('**/list'); (or an expect on the saved item) then page.goto if still needed
- Never use waitForTimeout. Wait for a locator, a URL (page.waitForURL) or a response (page.waitForResponse).
- Never change a fixture user's profile, password, role or data. To test changing a user, first register a new user with uniq values and change that one.
- Data a test needs that does not exist yet is created in the test (through the API, logged in as a suitable fixture user), with uniq values. Send requests in the shape the app's own frontend sends them: the code that calls each endpoint is included where it could be found. Tests are independent of each other and of running order.
- No imports, no new EXPECTED, no helper files. Keep the body short and direct.
- When a run fails, fix how the test reaches its checks (locators, waits, setup). The expected results never change. If a check without a value fails, fix the locator only if it does not target what the description says; do not weaken the check to make it pass.`;
}

export interface ScriptTaskInput {
  testCase: TestCase;
  requirements: PrdRequirement[];
  evidence: CodeExcerpts;
  /** Frontend code that calls the endpoints the test case uses. */
  callers?: CodeExcerpts['blocks'];
  config: TargetConfig;
  facts: TargetFacts | null;
  endpoints: Prd['apiEndpoints'];
  /** ui test cases: the pages the steps open, as an accessibility tree taken on the current version. */
  pageSnapshots?: Array<{ path: string; user?: string; snapshot: { finalPath: string; aria: string } }>;
  /** Set when a review found that an earlier script checked the wrong thing or at the wrong time (SPEC §6.2). */
  reviewNote?: string;
}

const renderBlock = (b: CodeExcerpts['blocks'][number]) => {
  const what = b.importedBy ? `(whole file, imported by ${b.importedBy})` : b.calls ? `lines ${b.start}-${b.end} (calls ${b.calls})` : `lines ${b.start}-${b.end}`;
  return `### ${b.file} ${what}\n${b.lines.map((l, i) => `${b.start + i}: ${l}`).join('\n')}`;
};

/** The user message for one test case. */
export function buildScriptTask(input: ScriptTaskInput): string {
  const { testCase: tc, config } = input;
  const parts = [
    `Write the body of the Playwright test for ${tc.id} (${tc.layer} test case).`,
    `## Test case\n${JSON.stringify(
      { title: tc.title, layer: tc.layer, category: tc.category, preconditions: tc.preconditions, fixturesUsed: tc.fixturesUsed, steps: tc.steps, expected: tc.expected },
      null,
      2,
    )}`,
    `## Requirement\n${input.requirements.map((r) => `- ${r.id}: ${r.statement}\n${r.acceptanceCriteria.map((c) => `   - ${c.text}`).join('\n')}`).join('\n')}`,
    `## The file around your body\n\`\`\`ts\n${header(tc)}\n  // <your body goes here>\n});\n\`\`\``,
    [
      '## Environment',
      `- Frontend base URL: ${config.frontend.baseUrl}`,
      `- Backend base URL: ${config.backend.baseUrl}`,
      `- API path prefix: ${config.backend.apiPrefix || '(none)'}`,
      '- Fixtures (refer to them as fixtures.<path>):',
      '```json',
      JSON.stringify(config.fixtures, null, 2),
      '```',
    ].join('\n'),
    `## Code that implements this (the page components show the labels, placeholders and texts to use)\n${input.evidence.blocks.map(renderBlock).join('\n\n') || '(none could be read)'}`,
  ];
  if (input.pageSnapshots && input.pageSnapshots.length > 0) {
    const pages = input.pageSnapshots.map((p) => {
      const who = p.user ? `logged in as ${p.user}` : 'not logged in';
      const moved = p.snapshot.finalPath !== p.path ? `; the browser ended on ${p.snapshot.finalPath}` : '';
      return `### ${p.path} (${who}${moved})\n\`\`\`yaml\n${snapshotForModel(p.snapshot.aria)}\n\`\`\``;
    });
    parts.push(
      `## The pages as they are now (accessibility tree, taken on the running application)\nUse these roles, names, labels and texts for locators (getByRole, getByLabel, getByPlaceholder, getByText); they are what the browser shows.\n${pages.join('\n\n')}`,
    );
  }
  if (input.reviewNote) {
    parts.splice(
      1,
      0,
      `## A reviewer looked at an earlier script for this test case\nThe expectations are right; the earlier script checked the wrong thing or at the wrong time. The reviewer's finding:\n${input.reviewNote}\nWrite the test so that each expectation checks what its description says, at the moment it is true.`,
    );
  }
  if (input.callers && input.callers.length > 0) {
    parts.push(`## How the app's own frontend calls these endpoints (send requests in the same shape)\n${input.callers.map(renderBlock).join('\n\n')}`);
  }
  if (input.endpoints.length > 0) parts.push(`## API endpoints (for setup steps)\n"sends" is the request shape the handler reads: build request bodies exactly in that shape (a body field holding an object is a nested object, e.g. data: { category: { … } }, not its fields at the top level).\n${renderEndpointIndex(input.endpoints)}`);
  if (input.facts && input.facts.facts.length > 0) {
    parts.push(`## Facts observed on the running application (data that exists at the start of the test)\n${renderFacts(input.facts)}`);
  }
  return parts.join('\n\n');
}
