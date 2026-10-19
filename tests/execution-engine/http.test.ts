import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { waitForHealthy } from '../../src/modules/execution-engine/health.js';
import { assertPortsFree, isPortInUse, urlPort } from '../../src/modules/execution-engine/ports.js';
import { runSeedCheck, sendSeedRequests, valueAtPath } from '../../src/modules/execution-engine/seed.js';

const servers: http.Server[] = [];

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A port that nothing listens on. */
async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

describe('waitForHealthy', () => {
  it('keeps polling through errors until the server answers 200', async () => {
    let calls = 0;
    const url = await serve((_req, res) => res.writeHead(++calls <= 3 ? 503 : 200).end());
    const result = await waitForHealthy('backend', url, { timeoutMs: 5000, intervalMs: 20 });
    expect(result).toMatchObject({ name: 'backend', url, ok: true });
    expect(calls).toBe(4);
  });

  it('counts a redirect as healthy without following it', async () => {
    const url = await serve((_req, res) => res.writeHead(302, { location: 'http://127.0.0.1:1/' }).end());
    expect((await waitForHealthy('frontend', url, { timeoutMs: 2000 })).ok).toBe(true);
  });

  it('gives up after the timeout when nothing listens', async () => {
    const url = `http://127.0.0.1:${await freePort()}`;
    const t0 = Date.now();
    const result = await waitForHealthy('backend', url, { timeoutMs: 300, intervalMs: 50 });
    expect(result.ok).toBe(false);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(300);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('treats a server that never answers as not ready (per-request timeout)', async () => {
    const url = await serve(() => {}); // accepts, never responds
    const result = await waitForHealthy('backend', url, { timeoutMs: 600, requestTimeoutMs: 100, intervalMs: 50 });
    expect(result.ok).toBe(false);
    expect(result.elapsedMs).toBeLessThan(1500);
  });

  it('stops early when giveUp resolves (the service process exited)', async () => {
    const url = `http://127.0.0.1:${await freePort()}`;
    const result = await waitForHealthy('backend', url, {
      timeoutMs: 10_000,
      intervalMs: 20,
      giveUp: new Promise((resolve) => setTimeout(resolve, 100)),
    });
    expect(result.ok).toBe(false);
    expect(result.elapsedMs).toBeLessThan(2000);
  });
});

describe('sendSeedRequests', () => {
  it('fills placeholders, sends JSON in order and records each status', async () => {
    const received: unknown[] = [];
    const url = await serve((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received.push({ method: req.method, path: req.url, type: req.headers['content-type'], body: JSON.parse(body) });
        res.writeHead(received.length === 1 ? 200 : 400).end('{}');
      });
    });
    const fixtures = { users: { alice: { email: 'a@x.test', password: 'pw', role: 'member' } } };
    const results = await sendSeedRequests(
      url,
      [
        { method: 'POST', path: '/api/auth/register', body: { email: '{{fixtures.users.alice.email}}', n: 1 } },
        { method: 'POST', path: '/api/auth/register', body: { email: 'dup' } },
      ],
      fixtures,
    );
    expect(results).toEqual([
      { request: 'POST /api/auth/register', status: 200, ok: true },
      { request: 'POST /api/auth/register', status: 400, ok: false },
    ]);
    expect(received[0]).toEqual({
      method: 'POST',
      path: '/api/auth/register',
      type: 'application/json',
      body: { email: 'a@x.test', n: 1 },
    });
  });

  it('records status null when no response comes back', async () => {
    const url = `http://127.0.0.1:${await freePort()}`;
    const results = await sendSeedRequests(url, [{ method: 'POST', path: '/x', body: {} }], { users: {} });
    expect(results).toEqual([{ request: 'POST /x', status: null, ok: false }]);
  });
});

describe('runSeedCheck', () => {
  const json = (status: number, body: unknown) => (_req: http.IncomingMessage, res: http.ServerResponse) =>
    res
      .writeHead(status, { 'content-type': 'application/json' })
      .end(typeof body === 'string' ? body : JSON.stringify(body));
  const check = (expect: { status: number; nonEmptyArrayAt?: string }) => ({
    method: 'GET' as const,
    path: '/list?q=1',
    expect,
  });
  const fixtures = { users: {} };

  it('passes for the expected status and a non-empty array at the path', async () => {
    const url = await serve(json(200, { products: [{ name: 'a' }] }));
    expect(await runSeedCheck(url, check({ status: 200, nonEmptyArrayAt: 'products' }), fixtures)).toEqual({
      ok: true,
      status: 200,
      detail: 'ok',
    });
    expect((await runSeedCheck(url, check({ status: 200 }), fixtures)).ok).toBe(true);
  });

  it('says what was wrong', async () => {
    const wrongStatus = await serve(json(400, { error: 'Your request could not be processed.' }));
    expect(await runSeedCheck(wrongStatus, check({ status: 200 }), fixtures)).toEqual({
      ok: false,
      status: 400,
      detail: 'expected status 200, got 400: {"error":"Your request could not be processed."}',
    });
    const withArray = check({ status: 200, nonEmptyArrayAt: 'products' });
    const empty = await serve(json(200, { products: [] }));
    expect((await runSeedCheck(empty, withArray, fixtures)).detail).toMatch(/non-empty array at "products", got an empty one/);
    const notArray = await serve(json(200, { products: { count: 3 } }));
    expect((await runSeedCheck(notArray, withArray, fixtures)).detail).toBe('expected an array at "products", got object');
    const missing = await serve(json(200, {}));
    expect((await runSeedCheck(missing, withArray, fixtures)).detail).toMatch(/got nothing/);
    const html = await serve(json(200, '<html>'));
    expect(await runSeedCheck(html, withArray, fixtures)).toMatchObject({ ok: false, status: 200, detail: /JSON/ });
    const down = `http://127.0.0.1:${await freePort()}`;
    expect(await runSeedCheck(down, check({ status: 200 }), fixtures)).toMatchObject({
      ok: false,
      status: null,
      detail: /^no response/,
    });
  });

  it('sends the path with its query string', async () => {
    let seen = '';
    const url = await serve((req, res) => ((seen = req.url ?? ''), res.end('{}')));
    const path = '/api/product/list?sortOrder=%7B%22_id%22%3A-1%7D&min=1';
    await runSeedCheck(url, { method: 'GET', path, expect: { status: 200 } }, fixtures);
    expect(seen).toBe(path);
  });

  it('valueAtPath walks objects and returns undefined for missing steps', () => {
    expect(valueAtPath({ a: { b: [1] } }, 'a.b')).toEqual([1]);
    expect(valueAtPath({ a: null }, 'a.b')).toBeUndefined();
    expect(valueAtPath({ a: [{ b: 2 }] }, 'a.0.b')).toBe(2);
  });
});

describe('ports', () => {
  it('reads ports from URLs, with protocol defaults', () => {
    expect(urlPort('http://localhost:3000/api')).toEqual({ host: 'localhost', port: 3000 });
    expect(urlPort('https://example.test')).toEqual({ host: 'example.test', port: 443 });
  });

  it('detects a port in use and refuses to start on it', async () => {
    const url = await serve((_req, res) => res.end());
    const { port } = urlPort(url);
    expect(await isPortInUse('localhost', port)).toBe(true);
    await expect(assertPortsFree([{ name: 'backend', url }])).rejects.toThrow(/already in use/);
    const free = await freePort();
    expect(await isPortInUse('localhost', free)).toBe(false);
    await expect(assertPortsFree([{ name: 'backend', url: `http://localhost:${free}` }])).resolves.toBeUndefined();
  });
});
