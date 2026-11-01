import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSpec, writePlaywrightConfig } from '../../src/modules/script-generator/dry-run.js';
import { PROJECT_ROOT } from '../../src/shared/paths.js';

// auth.storage.extra and the css locator of auth.uiLogin, with real Playwright and the real helpers against a tiny
// app that drops the session unless a version marker sits next to the token, and whose login inputs have no
// label, placeholder or test id.

const hasBoth = (cookieHeader: string | undefined) => /(?:^|; )session=[^;]+/.test(cookieHeader ?? '') && /(?:^|; )session_version=2(?:;|$)/.test(cookieHeader ?? '');
const tokenOf = (cookieHeader: string | undefined) => /(?:^|; )session=([^;]*)/.exec(cookieHeader ?? '')?.[1];

let server: Server;
let url: string;
const runDirs: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/api/login') {
        const ok = JSON.parse(body || '{}').password === 'Passw0rd!alice';
        return res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' }).end(JSON.stringify(ok ? { token: 'jwt-for-alice' } : { error: 'no' }));
      }
      if (req.url === '/login' && req.method === 'POST') {
        const params = new URLSearchParams(body);
        if (params.get('pw') !== 'Passw0rd!alice') return res.writeHead(401, { 'content-type': 'text/html' }).end('<p>Wrong</p>');
        return res.writeHead(302, { location: '/', 'set-cookie': ['session=jwt-for-alice; Path=/', 'session_version=2; Path=/'] }).end();
      }
      if (req.url === '/login') {
        return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><form method="post" action="/login"><input name="who"><input name="pw" type="password"><button>Log in</button></form>');
      }
      if (req.url === '/ls') {
        return res.writeHead(200, { 'content-type': 'text/html' }).end(
          '<!doctype html><main><p id="s"></p></main><script>const t=localStorage.getItem("token");document.getElementById("s").textContent=t&&localStorage.getItem("token_version")==="2"?"Signed in with "+t:"Signed out";</script>',
        );
      }
      const token = tokenOf(req.headers.cookie);
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><main><p>${hasBoth(req.headers.cookie) ? `Signed in with ${token}` : 'Signed out'}</p></main>`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  for (const dir of runDirs) await rm(dir, { recursive: true, force: true });
});

async function prepare(storage: Record<string, unknown>, spec: string): Promise<string> {
  await mkdir(path.join(PROJECT_ROOT, 'runs'), { recursive: true });
  const runDir = await mkdtemp(path.join(PROJECT_ROOT, 'runs', '.storage-extra-test-'));
  runDirs.push(runDir);
  const scripts = path.join(runDir, 'scripts');
  await mkdir(scripts, { recursive: true });
  await copyFile(path.join(PROJECT_ROOT, 'src/modules/script-generator/template/_helpers.ts'), path.join(scripts, '_helpers.ts'));
  await writeFile(
    path.join(scripts, '_target.json'),
    JSON.stringify({
      apiUrl: url,
      uiUrl: url,
      fixtures: { users: { alice: { email: 'alice@x.test', password: 'Passw0rd!alice' } } },
      auth: {
        login: { method: 'POST', path: '/api/login', body: { email: '{{user.email}}', password: '{{user.password}}' } },
        tokenAt: 'token',
        header: 'Authorization',
        prefix: 'Bearer ',
        storage,
        uiLogin: {
          path: '/login',
          fields: { email: { css: 'input[name="who"]' }, password: { css: 'input[name="pw"]' } },
          submit: { role: 'button', name: 'Log in' },
          waitFor: { urlNot: '/login' },
        },
      },
    }),
  );
  await writePlaywrightConfig(runDir, url);
  await writeFile(path.join(scripts, 'TC-001.spec.ts'), spec);
  return runDir;
}

const run = async (runDir: string) => runSpec(runDir, path.join(runDir, 'scripts', 'TC-001.spec.ts'), path.join(runDir, 'out'));

describe('auth.storage.extra', () => {
  it('sets the extra cookies next to the token, and a css locator fills a form whose inputs have no label', { timeout: 120_000 }, async () => {
    const runDir = await prepare(
      { kind: 'cookie', key: 'session', extra: { session_version: '2' } },
      `import { expect, fixtures, loggedInPage, loginViaUi, test } from './_helpers.js';

test('TC-001: cookie with a marker, and the form login by css', async ({ page, browser }) => {
  await loggedInPage(page, fixtures.users.alice);
  await page.goto('/');
  await expect(page.getByText('Signed in with jwt-for-alice')).toBeVisible();

  // A second tab that logs in through the form: the inputs are found by their css selectors.
  const other = await browser.newContext();
  const form = await other.newPage();
  await loginViaUi(form, fixtures.users.alice);
  await form.goto('/');
  await expect(form.getByText('Signed in with jwt-for-alice')).toBeVisible();
  await other.close();
});
`,
    );
    const result = await run(runDir);
    expect(result.message).toBe('');
    expect(result.status).toBe('passed');
  });

  it('without the extra cookie the same app drops the session', { timeout: 120_000 }, async () => {
    const runDir = await prepare(
      { kind: 'cookie', key: 'session' },
      `import { expect, fixtures, loggedInPage, test } from './_helpers.js';

test('TC-001: only the token', async ({ page }) => {
  await loggedInPage(page, fixtures.users.alice);
  await page.goto('/');
  await expect(page.getByText('Signed out')).toBeVisible();
});
`,
    );
    expect((await run(runDir)).status).toBe('passed');
  });

  it('sets extra items in localStorage too', { timeout: 120_000 }, async () => {
    const runDir = await prepare(
      { kind: 'localStorage', key: 'token', extra: { token_version: '2' } },
      `import { expect, fixtures, loggedInPage, test } from './_helpers.js';

test('TC-001: localStorage with a marker', async ({ page }) => {
  await loggedInPage(page, fixtures.users.alice);
  await page.goto('/ls');
  await expect(page.getByText('Signed in with jwt-for-alice')).toBeVisible();
});
`,
    );
    const result = await run(runDir);
    expect(result.message).toBe('');
    expect(result.status).toBe('passed');
  });
});
