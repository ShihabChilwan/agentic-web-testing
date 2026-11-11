import { describe, expect, it } from 'vitest';
import { compareResponses, findNoise, matchResponses, pageRecords } from '../../src/modules/differential/index.js';
import { applyVariableSegments, learnVariableSegments } from '../../src/modules/differential/diff.js';
import { diffHtml, htmlLines, pageLineShare } from '../../src/modules/differential/pages.js';
import { relativeTimeOnly } from '../../src/modules/differential/shapes.js';
import type { RecordedPage, RecordedResponse } from '../../src/shared/schemas.js';

const now = new Date('2026-11-11T00:00:00Z');
const meta = { run: 'r', sourceRunId: 'r', executions: ['x-01', 'x-02'], now };
const cmeta = { run: 'r', base: 'x-01', other: 'x-03', noiseFile: 'noise-fields.json', now };
const api = (testCaseId: string, seq: number, method: string, path: string, body: unknown, status = 200): RecordedResponse => ({
  testCaseId, seq, source: 'api', method, path, status, contentType: 'application/json', bodyKind: 'json', body,
});
const html = (testCaseId: string, seq: number, path: string, body: string, source: 'api' | 'page' = 'api'): RecordedResponse => ({
  testCaseId, seq, source, method: 'GET', path, status: 200, contentType: 'text/html; charset=utf-8', bodyKind: 'text', body,
});
const page = (testCaseId: string, seq: number, path: string, snapshot: string): RecordedPage => ({ testCaseId, seq, kind: 'navigation', path, snapshot });
const strongOf = (c: ReturnType<typeof compareResponses>) => c.tests.flatMap((t) => t.endpoints.flatMap((e) => e.differences.filter((d) => d.strength === 'strong')));

describe('path parts that vary between correct runs', () => {
  // A short link the app makes up: a new random address in every run.
  const run = (address: string, target = 'https://example.com/a') => [
    api('TC-040', 1, 'POST', '/api/v2/links', { address, target }, 201),
    { ...api('TC-040', 2, 'GET', `/${address}`, null, 302), bodyKind: 'none' as const },
  ];

  it('learns the part and matches the call across runs; another kind of path still stands out', () => {
    const noise = findNoise([run('2H3EbB'), run('ubELTW')], meta);
    expect(noise.variableSegments).toEqual([expect.objectContaining({ endpoint: 'GET /*', position: 1, tests: ['TC-040'] })]);
    expect(compareResponses(run('2H3EbB'), run('Xk9_qZ'), noise, cmeta).summary.strong).toBe(0);
    // The part only becomes :var in the tests it was learned in, and only in its shape.
    expect(applyVariableSegments('GET /settings', 'TC-040', noise.variableSegments)).toBe('GET /settings');
    expect(applyVariableSegments('GET /Ab3dEf', 'TC-041', noise.variableSegments)).toBe('GET /Ab3dEf');
    const moved = [run('2H3EbB')[0]!, { ...run('x')[1]!, path: '/settings' }];
    expect(strongOf(compareResponses(run('2H3EbB'), moved, noise, cmeta)).map((d) => d.field)).toContain('(response)');
  });

  it('needs exactly one differing part with no common start, in the same test and method', () => {
    const pairs = matchResponses(
      [api('TC-001', 1, 'GET', '/a/b1x', {}), api('TC-001', 2, 'GET', '/links/kQ8zPw', {})],
      [api('TC-001', 1, 'GET', '/c/d2y', {}), api('TC-002', 2, 'GET', '/links/Zm4TbN', {})],
    );
    expect(learnVariableSegments(pairs)).toEqual([]);
  });
});

describe('relative times', () => {
  it('are a known shape: a few seconds or one unit apart is noise, a larger move is not', () => {
    expect(relativeTimeOnly('0 seconds ago', '1 second ago')).toBe(true);
    expect(relativeTimeOnly('created 1 minute ago', 'created 2 minutes ago')).toBe(true);
    expect(relativeTimeOnly('3 days ago', '4 days ago')).toBe(true);
    expect(relativeTimeOnly('less than a minute ago', 'about 1 minute ago')).toBe(true);
    expect(relativeTimeOnly('expires in 2 hours', 'expires in 2 hours')).toBe(false); // equal: no difference at all
    expect(relativeTimeOnly('0 seconds ago', '2 days ago')).toBe(false);
    expect(relativeTimeOnly('0 seconds ago', 'in 1 second')).toBe(false);
    expect(relativeTimeOnly('alice 0 seconds ago', 'bob 1 second ago')).toBe(false);
    expect(relativeTimeOnly(5, 6)).toBe(false);
  });

  it('are ignored in a comparison even where the correct runs never varied', () => {
    const body = (rel: string, email = 'a@x.test') => ({ data: [{ id: 4, email, relative_created_at: rel }] });
    const runOf = (rel: string, email?: string) => [api('TC-064', 1, 'GET', '/api/users', body(rel, email))];
    const noise = findNoise([runOf('0 seconds ago'), runOf('0 seconds ago')], meta);
    expect(compareResponses(runOf('0 seconds ago'), runOf('1 second ago'), noise, cmeta).summary).toMatchObject({ strong: 0, weak: 0, ignoredAsNoise: 1 });
    expect(compareResponses(runOf('0 seconds ago'), runOf('3 months ago'), noise, cmeta).summary.strong).toBe(1);
  });
});

describe('HTML element by element', () => {
  const doc = (nav: string, rows: string[]) =>
    `<!DOCTYPE html><html><head><title>App</title><script>var t = ${Date.now()};</script></head><body><!-- c -->
     <header><nav><ul>${nav}</ul></nav></header>
     <table hx-get="/api/links"><tbody>${rows.map((r) => `<tr><td>${r}</td></tr>`).join('')}</tbody></table>
     <form action="/login" method="post"><input name="email" placeholder="Email..."><br><button type="submit">Log in</button></form></body></html>`;

  it('reads elements with their own text and compared attributes; scripts and comments are left out', () => {
    const lines = htmlLines(doc('<li><a href="/settings" class="x">Settings</a></li>', ['one']));
    expect(lines.map((l) => `${l.path} ${l.text}`)).toEqual([
      'html>head>title title "App"',
      'html>body>header>nav>ul>li>a a[href="/settings"] "Settings"',
      'html>body>table table[hx-get="/api/links"]',
      'html>body>table>tbody>tr>td td "one"',
      'html>body>form form[action="/login" method="post"]',
      'html>body>form>input input[name="email" placeholder="Email..."]',
      'html>body>form>button button[type="submit"] "Log in"',
    ]);
  });

  it('a changed element is one difference, reordered identical elements are none, an extra element stands alone', () => {
    const a = doc('<li><a href="/settings">Settings</a></li>', ['one', 'two']);
    expect(diffHtml(a, doc('<li><a href="/settings">Settings</a></li>', ['two', 'one']))).toEqual([]);
    expect(diffHtml(a, doc('<li><a href="/login">Log in</a></li>', ['one', 'two']))).toEqual([
      { field: 'html>body>header>nav>ul>li>a', path: 'html>body>header>nav>ul>li>a#1', a: 'a[href="/settings"] "Settings"', b: 'a[href="/login"] "Log in"' },
    ]);
    expect(diffHtml(a, doc('<li><a href="/settings">Settings</a></li>', ['one', 'two', 'three']))).toEqual([
      { field: 'html>body>table>tbody>tr>td(element)', path: 'html>body>table>tbody>tr>td', a: '(absent)', b: 'td "three"' },
    ]);
  });

  it('an htmx fragment that changes is strong in a comparison, field by element', () => {
    const fragment = (msg: string) => [html('TC-054', 1, '/api/links/delete', `<div class="content"><p>${msg}</p></div>`)];
    const noise = findNoise([fragment('Deleted.'), fragment('Deleted.')], meta);
    const c = compareResponses(fragment('Deleted.'), fragment('Could not delete.'), noise, cmeta);
    expect(strongOf(c)).toEqual([expect.objectContaining({ field: 'div>p', base: 'p "Deleted."', other: 'p "Could not delete."' })]);
  });
});

describe('snapshots of different pages at one step', () => {
  const frame = '- banner:\n  - link "Home":\n    - /url: /\n  - navigation:\n    - link "Log in":\n      - /url: /login\n';
  const settings = `${frame}- heading "Welcome, alice." [level=1]\n- heading "API" [level=2]\n- button "Generate key"\n- heading "Change password" [level=2]\n- textbox "Current password..."\n- textbox "New password..."\n- button "Update"\n- heading "Delete account" [level=2]\n- button "Delete"`;
  const loggedOut = `${frame}- heading "Logged out. Redirecting to homepage..." [level=1]`;

  it('share few lines, so their differences are weak (other-page); one changed line on one page stays strong', () => {
    expect(pageLineShare(settings, loggedOut)).toBeLessThan(0.5);
    expect(pageLineShare(settings, settings.replace('Welcome, alice.', 'Welcome, bob.'))).toBeGreaterThan(0.5);
    const runOf = (snapshot: string) => pageRecords([page('TC-088', 1, '/login', snapshot)]);
    const noise = findNoise([runOf(settings), runOf(settings)], meta);
    const race = compareResponses(runOf(settings), runOf(loggedOut), noise, cmeta);
    expect(race.summary.strong).toBe(0);
    expect(race.tests[0]!.endpoints[0]!.differences.every((d) => d.strength === 'weak' && d.reason === 'other-page')).toBe(true);
    const changed = compareResponses(runOf(settings), runOf(settings.replace('Welcome, alice.', 'Welcome, bob.')), noise, cmeta);
    expect(changed.summary.strong).toBe(1);
  });
});
