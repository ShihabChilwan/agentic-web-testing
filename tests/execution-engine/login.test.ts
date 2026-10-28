import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loginEnv, loginFixture } from '../../src/modules/execution-engine/login.js';
import { TargetConfig } from '../../src/shared/schemas.js';
import { example } from '../shared/schemas/helpers.js';

let server: http.Server;
let url: string;
let lastContentType = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      lastContentType = req.headers['content-type'] ?? '';
      // An app that reads only form data: JSON gets no token.
      const form = new URLSearchParams(body);
      const ok = lastContentType.startsWith('application/x-www-form-urlencoded') && form.get('email') === 'alice@example.test';
      res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' }).end(JSON.stringify(ok ? { token: 'form-token' } : { error: 'no' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const config = (login: Record<string, unknown>, tokenAt: string | undefined = 'token') => {
  const c = structuredClone(example('target.config.json'));
  c.backend.baseUrl = url;
  c.auth.login = login;
  if (tokenAt === undefined) delete c.auth.tokenAt;
  return TargetConfig.parse(c);
};
const alice = { email: 'alice@example.test', password: 'Passw0rd!alice' };

describe('loginFixture: the request login', () => {
  it('sends a form-encoded body when the config says so, and JSON otherwise', async () => {
    const body = { email: '{{user.email}}', password: '{{user.password}}' };
    expect(await loginFixture(config({ method: 'POST', path: '/login', body, encoding: 'form' }), alice)).toEqual({ ok: true, status: 200, token: 'form-token' });
    expect(lastContentType).toBe('application/x-www-form-urlencoded');
    expect((await loginFixture(config({ method: 'POST', path: '/login', body }), alice)).ok).toBe(false);
    expect(lastContentType).toBe('application/json');
  });
});

describe('loginFixture: the login command', () => {
  const command = (text: string) => config({ command: text }, undefined);

  it('takes the command output as the token, with the user fields in AWT_USER_ variables and no secret in the command text', async () => {
    const c = command('printf "%s:%s" "$AWT_USER_EMAIL" "$AWT_USER_PASSWORD"');
    expect(await loginFixture(c, alice, { cwd: '.' })).toEqual({ ok: true, status: null, token: 'alice@example.test:Passw0rd!alice' });
  });

  it('runs in the given folder, with the app URLs, and without the rest of the environment', async () => {
    process.env.AWT_TEST_SECRET = 'must-not-pass';
    try {
      const c = command('printf "%s %s %s" "$(basename "$PWD")" "$AWT_API_URL" "${AWT_TEST_SECRET:-none}"');
      const result = await loginFixture(c, alice, { cwd: 'tests' });
      expect(result.token).toBe(`tests ${url} none`);
    } finally {
      delete process.env.AWT_TEST_SECRET;
    }
  });

  it('is a failed login when the command exits non-zero or prints nothing', async () => {
    expect(await loginFixture(command('echo oops >&2; exit 3'), alice, { cwd: '.' })).toEqual({ ok: false, status: null, token: null });
    expect(await loginFixture(command('true'), alice, { cwd: '.' })).toEqual({ ok: false, status: null, token: null });
  });

  it('turns fixture fields into variable names', () => {
    expect(loginEnv(command('x'), { email: 'a', 'first-name': 'B', age: 3, nested: { x: 1 } })).toMatchObject({ AWT_USER_EMAIL: 'a', AWT_USER_FIRST_NAME: 'B', AWT_USER_AGE: '3' });
  });
});

describe('the auth schema', () => {
  it('needs tokenAt for a login request, and not for a command', () => {
    const c = structuredClone(example('target.config.json'));
    delete c.auth.tokenAt;
    expect(TargetConfig.safeParse(c).success).toBe(false);
    c.auth.login = { command: 'echo t' };
    expect(TargetConfig.safeParse(c).success).toBe(true);
  });
});
