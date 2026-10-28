import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSpec, writePlaywrightConfig } from '../../src/modules/script-generator/dry-run.js';
import { PROJECT_ROOT } from '../../src/shared/paths.js';

// The generated scripts' loggedInPage helper against an app whose server reads the login token from a cookie
// (auth.storage.kind "cookie"): real Playwright, the real helpers, a tiny server-rendered app.

const COOKIE = 'session';
let server: Server;
let runDir: string;

const who = (cookieHeader: string | undefined) => /(?:^|; )session=([^;]*)/.exec(cookieHeader ?? '')?.[1];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/api/login') {
        const ok = JSON.parse(body || '{}').password === 'Passw0rd!alice';
        return res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' }).end(JSON.stringify(ok ? { token: 'jwt-for-alice' } : { error: 'no' }));
      }
      if (req.url === '/logout') return res.writeHead(200, { 'set-cookie': `${COOKIE}=; Max-Age=0; Path=/`, 'content-type': 'text/html' }).end('<p>Logged out</p>');
      const token = who(req.headers.cookie);
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><main><p>${token ? `Signed in with ${token}` : 'Signed out'}</p></main>`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await mkdir(path.join(PROJECT_ROOT, 'runs'), { recursive: true });
  runDir = await mkdtemp(path.join(PROJECT_ROOT, 'runs', '.cookie-test-'));
  const scripts = path.join(runDir, 'scripts');
  await mkdir(scripts, { recursive: true });
  await copyFile(path.join(PROJECT_ROOT, 'src/modules/script-generator/template/_helpers.ts'), path.join(scripts, '_helpers.ts'));
  await writeFile(
    path.join(scripts, '_target.json'),
    JSON.stringify({
      apiUrl: url,
      uiUrl: url,
      fixtures: { users: { alice: { email: 'alice@x.test', password: 'Passw0rd!alice' } } },
      auth: { login: { method: 'POST', path: '/api/login', body: { email: '{{user.email}}', password: '{{user.password}}' } }, tokenAt: 'token', header: 'Cookie', prefix: `${COOKIE}=`, storage: { kind: 'cookie', key: COOKIE } },
    }),
  );
  await writePlaywrightConfig(runDir, url);
  await writeFile(
    path.join(scripts, 'TC-001.spec.ts'),
    `import { expect, fixtures, loggedInPage, loginViaApi, test } from './_helpers.js';

test('TC-001: the page starts logged in with the cookie, an API call carries it, and logging out stays logged out after a reload', async ({ page, api }) => {
  await page.goto('/');
  await expect(page.getByText('Signed out')).toBeVisible();

  await loggedInPage(page, fixtures.users.alice);
  await page.goto('/');
  await expect(page.getByText('Signed in with jwt-for-alice')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Signed in with jwt-for-alice')).toBeVisible();

  // The same login over the API gives the header the app reads: Cookie: session=<token>.
  const { headers } = await loginViaApi(fixtures.users.alice);
  expect(headers).toEqual({ Cookie: 'session=jwt-for-alice' });
  expect((await api.get('/', { headers })).status()).toBe(200);

  await page.goto('/logout');
  await page.goto('/');
  await expect(page.getByText('Signed out')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Signed out')).toBeVisible();
});
`,
  );
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await rm(runDir, { recursive: true, force: true });
});

describe('loggedInPage with a cookie', () => {
  it('sets the login token as a cookie once, so the page starts logged in and a logout sticks', { timeout: 120_000 }, async () => {
    const result = await runSpec(runDir, path.join(runDir, 'scripts', 'TC-001.spec.ts'), path.join(runDir, 'out'));
    expect(result.message).toBe('');
    expect(result.status).toBe('passed');
  });
});
