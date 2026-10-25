import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pageSnapshot, pageSnapshots } from '../../src/modules/execution-engine/probe.js';
import { TargetConfig } from '../../src/shared/schemas.js';
import { example } from '../shared/schemas/helpers.js';

// A tiny app: a frontend whose page shows a form, and "Signed in as <token>" when the token is in localStorage;
// a backend whose login returns a token for the fixture user's password.
let frontend: Server;
let backend: Server;
let config: TargetConfig;

const PAGE = `<!doctype html><html><body><main>
<h1>Sign in</h1>
<label>Email <input name="email" placeholder="Your email"></label>
<button>Log in</button>
<p id="who"></p>
<script>const t = localStorage.getItem('token'); document.getElementById('who').textContent = t ? 'Signed in as ' + t : 'Not signed in';</script>
</main></body></html>`;

const listen = (server: Server) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));

beforeAll(async () => {
  frontend = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE));
  backend = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const ok = req.url === '/api/auth/login' && JSON.parse(body || '{}').password === 'Passw0rd!alice';
      res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' }).end(JSON.stringify(ok ? { token: 'tok-123' } : { error: 'no' }));
    });
  });
  const [fp, bp] = await Promise.all([listen(frontend), listen(backend)]);
  const c = structuredClone(example('target.config.json'));
  c.frontend.baseUrl = `http://127.0.0.1:${fp}`;
  c.backend.baseUrl = `http://127.0.0.1:${bp}`;
  config = TargetConfig.parse(c);
});

afterAll(async () => {
  await Promise.all([new Promise((r) => frontend.close(r)), new Promise((r) => backend.close(r))]);
});

describe('pageSnapshot', () => {
  it('returns the accessibility tree of a page, not logged in', async () => {
    const snap = await pageSnapshot(config, '/login');
    expect(snap?.finalPath).toBe('/login');
    expect(snap?.aria).toContain('heading "Sign in" [level=1]');
    expect(snap?.aria).toContain('textbox "Email"');
    expect(snap?.aria).toContain('button "Log in"');
    expect(snap?.aria).toContain('Not signed in');
  }, 60_000);

  it('starts logged in as a fixture user, with the token in the configured storage', async () => {
    expect(config.auth?.storage).toEqual({ kind: 'localStorage', key: 'token' });
    const snap = await pageSnapshot(config, '/dashboard', 'users.alice');
    expect(snap?.aria).toContain('Signed in as tok-123');
  }, 60_000);

  it('takes several pages in one browser, each in a fresh context (a login does not leak into the next page)', async () => {
    const snaps = await pageSnapshots(config, [{ path: '/a', user: 'users.alice' }, { path: '/b' }]);
    expect(snaps.map((x) => /Signed in as tok-123/.test(x?.aria ?? ''))).toEqual([true, false]);
    expect(snaps[1]?.aria).toContain('Not signed in');
  }, 60_000);

  it('returns null when the page cannot be opened', async () => {
    const c = TargetConfig.parse({ ...structuredClone(config), frontend: { ...config.frontend, baseUrl: 'http://127.0.0.1:9' } });
    expect(await pageSnapshot(c, '/login')).toBeNull();
  }, 60_000);
});
