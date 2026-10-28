import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSpec, writePlaywrightConfig } from '../../src/modules/script-generator/dry-run.js';
import { PROJECT_ROOT } from '../../src/shared/paths.js';

// The generated scripts' loginViaApi helper with the two non-default logins: a form-encoded login request (an app that
// reads only form data) and a login command (auth.login.command). Real Playwright, the real helpers, a tiny app.

let server: Server;
let runDir: string;
let commandRun: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const reply = (status: number, json: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
      if (req.url === '/login') {
        const ok = (req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded') && new URLSearchParams(body).get('password') === 'Passw0rd!alice';
        return reply(ok ? 200 : 400, ok ? { token: 'form-jwt' } : { error: 'form data only' });
      }
      // A route that accepts only a form body and only the token from the login.
      if (req.url === '/items') {
        const ok = req.headers.authorization === 'Bearer form-jwt' || req.headers.authorization === 'Bearer cmd-alice@x.test';
        const form = (req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded');
        return reply(ok && form ? 201 : 400, { name: new URLSearchParams(body).get('name') });
      }
      reply(404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await mkdir(path.join(PROJECT_ROOT, 'runs'), { recursive: true });
  runDir = await mkdtemp(path.join(PROJECT_ROOT, 'runs', '.login-test-'));
  const scripts = path.join(runDir, 'scripts');
  await mkdir(scripts, { recursive: true });
  await copyFile(path.join(PROJECT_ROOT, 'src/modules/script-generator/template/_helpers.ts'), path.join(scripts, '_helpers.ts'));
  const fixtures = { users: { alice: { email: 'alice@x.test', password: 'Passw0rd!alice' } } };
  const common = { apiUrl: url, uiUrl: url, fixtures, targetDir: scripts };
  await writeFile(
    path.join(scripts, '_target.json'),
    JSON.stringify({ ...common, auth: { login: { method: 'POST', path: '/login', body: { email: '{{user.email}}', password: '{{user.password}}' }, encoding: 'form' }, tokenAt: 'token', header: 'Authorization', prefix: 'Bearer ' } }),
  );
  // The command variant lives in a second folder with its own _target.json.
  commandRun = path.join(runDir, 'command-run');
  const commandDir = path.join(commandRun, 'scripts');
  await mkdir(commandDir, { recursive: true });
  await copyFile(path.join(scripts, '_helpers.ts'), path.join(commandDir, '_helpers.ts'));
  await writeFile(
    path.join(commandDir, '_target.json'),
    JSON.stringify({ ...common, targetDir: commandDir, auth: { login: { command: 'printf "cmd-%s" "$AWT_USER_EMAIL"' }, header: 'Authorization', prefix: 'Bearer ' } }),
  );
  const spec = `import { expect, fixtures, loginViaApi, test } from './_helpers.js';

test('TC-001: log in, then send a form-encoded body', async ({ api }) => {
  const { headers } = await loginViaApi(fixtures.users.alice);
  const res = await api.post('/items', { form: { name: 'thing' }, headers });
  expect(res.status()).toBe(201);
  expect(await res.json()).toEqual({ name: 'thing' });
});
`;
  await writeFile(path.join(scripts, 'TC-001.spec.ts'), spec);
  await writeFile(path.join(commandDir, 'TC-001.spec.ts'), spec);
  await writePlaywrightConfig(runDir, url);
  await writePlaywrightConfig(commandRun, url);
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await rm(runDir, { recursive: true, force: true });
});

describe('loginViaApi variants', () => {
  it('logs in with a form-encoded request and sends a form body', { timeout: 120_000 }, async () => {
    const result = await runSpec(runDir, path.join(runDir, 'scripts', 'TC-001.spec.ts'), path.join(runDir, 'out'));
    expect(result.message).toBe('');
    expect(result.status).toBe('passed');
  });

  it('logs in with a command that prints the token', { timeout: 120_000 }, async () => {
    const result = await runSpec(commandRun, path.join(commandRun, 'scripts', 'TC-001.spec.ts'), path.join(commandRun, 'out'));
    expect(result.message).toBe('');
    expect(result.status).toBe('passed');
  });
});
