import { mkdtemp, readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { observeFacts, project, redactValue, trimBody, writeFactsFile } from '../../src/modules/execution-engine/facts.js';
import { TargetConfig, TargetFacts } from '../../src/shared/schemas.js';
import { example } from '../shared/schemas/helpers.js';

const TOKEN = 'tok-SECRET-0123456789abcdef';
let server: http.Server;
let baseUrl: string;
let logins = 0;
const seen: Array<{ url: string; auth: string | undefined }> = [];

const items = Array.from({ length: 8 }, (_, i) => ({ name: `Item ${i + 1}`, slug: `item-${i + 1}`, price: 10 + i, secretField: 'x' }));

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const auth = req.headers.authorization;
      seen.push({ url: req.url ?? '', auth });
      const json = (status: number, value: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      if (req.url === '/api/auth/login') {
        const { email, password } = JSON.parse(body || '{}');
        logins++;
        if (email === 'alice@example.test' && password === 'Passw0rd!alice') return json(200, { success: true, token: `Bearer ${TOKEN}` });
        return json(400, { success: false, error: 'Password Incorrect' });
      }
      if (req.url === '/api/items') return json(200, { items, count: items.length });
      if (req.url?.startsWith('/api/items/')) {
        const slug = decodeURIComponent(req.url.slice('/api/items/'.length));
        const item = items.find((i) => i.slug === slug || i.name === slug);
        return item ? json(200, { item }) : json(404, { message: 'No item found.' });
      }
      if (req.url === '/api/me') {
        if (auth !== `Bearer ${TOKEN}`) return res.writeHead(401).end('Unauthorized');
        // A careless endpoint that echoes the auth header: the token must still never be stored.
        return json(200, { user: { email: 'alice@example.test', role: 'ROLE MEMBER' }, debug: { header: auth } });
      }
      res.writeHead(404).end('Not found');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

function config(facts: unknown[]): TargetConfig {
  const c = structuredClone(example('target.config.json'));
  c.backend.baseUrl = baseUrl;
  c.facts = facts;
  return TargetConfig.parse(c);
}

describe('observeFacts', () => {
  it('runs the requests in order, logs in once per user, chains values and trims', async () => {
    logins = 0;
    seen.length = 0;
    const facts = await observeFacts(
      config([
        { name: 'list', method: 'GET', path: '/api/items', keep: ['items[].name', 'items[].slug', 'count'], maxItems: 3 },
        { name: 'one', method: 'GET', path: '/api/items/{{facts.list.body.items.4.slug}}' },
        { name: 'byName', method: 'GET', path: '/api/items/{{facts.list.body.items.0.name}}' },
        { name: 'me', method: 'GET', path: '/api/me', as: 'users.alice', keep: ['user.email', 'user.role'] },
        { name: 'meAgain', method: 'GET', path: '/api/me', as: 'users.alice' },
        { name: 'meNoToken', method: 'GET', path: '/api/me' },
        { name: 'missing', method: 'GET', path: '/api/items/nope' },
        { name: 'wrongPassword', method: 'POST', path: '/api/auth/login', body: { email: '{{fixtures.users.alice.email}}', password: 'x' } },
      ]),
    );
    const byName = Object.fromEntries(facts.map((f) => [f.name, f]));
    expect(byName.list).toMatchObject({
      status: 200,
      truncated: true,
      body: { items: [{ name: 'Item 1', slug: 'item-1' }, { name: 'Item 2', slug: 'item-2' }, { name: 'Item 3', slug: 'item-3' }], count: 8 },
    });
    // Chaining reads the full earlier response, not the trimmed one (item 5 was trimmed away).
    expect(byName.one).toMatchObject({ status: 200, request: { path: '/api/items/item-5', as: null } });
    expect(byName.byName?.request.path).toBe('/api/items/Item%201');
    expect(byName.me).toMatchObject({ status: 200, body: { user: { email: 'alice@example.test', role: 'ROLE MEMBER' } } });
    expect(byName.meNoToken).toMatchObject({ status: 401, body: 'Unauthorized' });
    expect(byName.missing).toMatchObject({ status: 404, body: { message: 'No item found.' } });
    expect(byName.wrongPassword).toMatchObject({ status: 400, body: { error: 'Password Incorrect' } });
    expect(logins).toBe(2); // one login for users.alice, plus the wrongPassword fact itself
    expect(seen.find((s) => s.url === '/api/me' && s.auth)?.auth).toBe(`Bearer ${TOKEN}`);
  });

  it('never writes a token or an auth header to facts.json, even when an endpoint echoes it', async () => {
    const facts = await observeFacts(config([{ name: 'me', method: 'GET', path: '/api/me', as: 'users.alice' }]));
    const dir = await mkdtemp(path.join(tmpdir(), 'facts-'));
    const file = path.join(dir, 'facts.json');
    await writeFactsFile(file, 'fake', 'abc1234', facts);
    const text = await readFile(file, 'utf8');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('Passw0rd!alice');
    expect(text).not.toMatch(/authorization/i);
    expect(TargetFacts.parse(JSON.parse(text)).facts[0]?.body).toMatchObject({ debug: { header: '[redacted]' } });
  });

  it('fails clearly on a failed login, a refused connection and an unknown placeholder', async () => {
    const bad = TargetConfig.parse({
      ...structuredClone(example('target.config.json')),
      backend: { ...example('target.config.json').backend, baseUrl },
      fixtures: { users: { alice: { email: 'alice@example.test', password: 'wrong', role: 'member' } } },
      facts: [],
    });
    await expect(observeFacts(bad, [{ name: 'me', method: 'GET', path: '/api/me', as: 'users.alice', maxItems: 5 }])).rejects.toThrow(
      'Login as users.alice failed: status 400, no token at "token"',
    );
    const down = config([]);
    down.backend.baseUrl = 'http://127.0.0.1:1';
    await expect(observeFacts(down, [{ name: 'list', method: 'GET', path: '/api/items', as: null, maxItems: 5 }])).rejects.toThrow(/^Fact list: no response/);
    await expect(
      observeFacts(config([]), [{ name: 'one', method: 'GET', path: '/api/items/{{facts.nothing.body.x}}', as: null, maxItems: 5 }]),
    ).rejects.toThrow(/Unknown placeholder \{\{facts.nothing.body.x\}\}/);
  });
});

describe('fact trimming', () => {
  it('keeps the named paths, mapping over arrays', () => {
    const body = { products: [{ name: 'A', slug: 'a', brand: { name: 'B', id: 1 } }], count: 3, extra: true };
    expect(project(body, ['products[].name', 'products[].brand.name', 'count'])).toEqual({
      products: [{ name: 'A', brand: { name: 'B' } }],
      count: 3,
    });
    expect(project([{ a: 1, b: 2 }], ['[].a'])).toEqual([{ a: 1 }]);
  });

  it('cuts arrays, long strings and big bodies, and says so', () => {
    expect(trimBody({ a: [1, 2, 3, 4, 5, 6] }, 5)).toEqual({ body: { a: [1, 2, 3, 4, 5] }, truncated: true });
    expect(trimBody({ a: [1, 2] }, 5)).toEqual({ body: { a: [1, 2] }, truncated: false });
    const long = trimBody('x'.repeat(400), 5);
    expect(long.truncated).toBe(true);
    expect(String(long.body)).toHaveLength(301);
    const big = trimBody({ rows: Array.from({ length: 5 }, () => 'y'.repeat(299)).map((s) => ({ s, t: s })) }, 5);
    expect(JSON.stringify(big.body).length).toBeLessThanOrEqual(3_000);
    expect(big.truncated).toBe(true);
  });

  it('redacts secrets anywhere, ignoring very short strings', () => {
    expect(redactValue({ a: ['x Bearer abcdefgh123 y'] }, ['Bearer abcdefgh123', 'ab'])).toEqual({ a: ['x [redacted] y'] });
  });
});
