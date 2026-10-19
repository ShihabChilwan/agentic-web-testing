import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { waitForHealthy } from '../../src/modules/execution-engine/health.js';
import { assertPortsFree, isPortInUse, urlPort } from '../../src/modules/execution-engine/ports.js';
import { sendSeedRequests } from '../../src/modules/execution-engine/seed.js';

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
