import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkFixtureLogins } from '../../src/modules/execution-engine/guard.js';
import { TargetConfig } from '../../src/shared/schemas.js';
import { example } from '../shared/schemas/helpers.js';

let server: http.Server;
let url: string;
let alicePassword = 'Passw0rd!alice';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { email, password } = JSON.parse(body || '{}');
      const ok = { 'admin@example.com': 'admin123', 'alice@example.test': alicePassword, 'bob@example.test': 'Passw0rd!bob' }[email as string] === password;
      res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' }).end(JSON.stringify(ok ? { token: 'Bearer t' } : { error: 'no' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const config = (baseUrl: string, auth = true) => {
  const c = structuredClone(example('target.config.json'));
  c.backend.baseUrl = baseUrl;
  if (!auth) delete c.auth;
  return TargetConfig.parse(c);
};

describe('checkFixtureLogins', () => {
  it('finds no problem while every fixture user can log in', async () => {
    expect(await checkFixtureLogins(config(url))).toEqual({ broken: [], unreachable: false });
  });

  it('names the fixture user a test broke', async () => {
    alicePassword = 'changed';
    try {
      expect(await checkFixtureLogins(config(url))).toEqual({ broken: ['users.alice'], unreachable: false });
    } finally {
      alicePassword = 'Passw0rd!alice';
    }
  });

  it('reports an app that does not answer as unreachable, not as a fixture change', async () => {
    expect(await checkFixtureLogins(config('http://127.0.0.1:1'))).toEqual({ broken: [], unreachable: true });
  });

  it('has nothing to check without auth settings', async () => {
    expect(await checkFixtureLogins(config(url, false))).toEqual({ broken: [], unreachable: false });
  });
});
