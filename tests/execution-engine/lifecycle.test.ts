import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTarget, withTarget, type StartOptions } from '../../src/modules/execution-engine/lifecycle.js';
import { isPortInUse } from '../../src/modules/execution-engine/ports.js';
import { TargetConfig } from '../../src/shared/schemas.js';

// A fake two-service app in a temporary git repo: each service is a tiny Node HTTP server
// that records its env var names and request bodies, so the lifecycle runs end to end
// without the real target.
const FAKE_SERVICE = `
const http = require('http');
const fs = require('fs');
fs.writeFileSync('env-keys.json', JSON.stringify(Object.keys(process.env)));
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (body) fs.appendFileSync('requests.log', body + '\\n');
    res.writeHead(200).end('ok');
  });
}).listen(Number(process.env.PORT), '127.0.0.1');
`;

let root: string;
let repoDir: string;
let targetDir: string;
let logsDir: string;
let backendPort: number;
let frontendPort: number;
const parentKey = process.env.LLM_API_KEY;

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function makeConfig(changes: (c: Record<string, any>) => void = () => {}): TargetConfig { // eslint-disable-line @typescript-eslint/no-explicit-any
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const frontendUrl = `http://127.0.0.1:${frontendPort}`;
  const raw = {
    schemaVersion: '1.0',
    name: 'fake',
    repoPath: 'targets/fake/repo',
    repoUrl: 'https://example.test/fake',
    goldenRef: 'golden',
    backend: {
      cwd: 'api',
      install: 'echo api >> ../installs.txt',
      start: 'node ../fake-service.cjs',
      baseUrl: backendUrl,
      apiPrefix: '/api',
      healthCheckUrl: `${backendUrl}/health`,
      env: { PORT: String(backendPort), MONGO_URI: 'mongodb://db/test' },
      disabledServices: { MAIL_KEY: '' },
    },
    frontend: {
      cwd: 'web',
      install: 'echo web >> ../installs.txt',
      start: 'node ../fake-service.cjs',
      baseUrl: frontendUrl,
      healthCheckUrl: frontendUrl,
      env: { PORT: String(frontendPort), API_URL: `${backendUrl}/api` },
      envFile: '.env',
    },
    lifecycle: {
      reset: 'echo reset >> resets.txt',
      resetCwd: '.',
      seedCommand: 'echo "$MONGO_URI {{targetDir}}" > seed.txt',
      seedCwd: 'api',
      startupTimeoutMs: 5000,
    },
    fixtures: { users: { alice: { email: 'alice@x.test', password: 'pw', role: 'member' } } },
    seed: [{ method: 'POST', path: '/api/auth/register', body: { email: '{{fixtures.users.alice.email}}' } }],
    sourceHints: { include: [], exclude: [] },
    forbiddenPaths: [],
  };
  changes(raw);
  return TargetConfig.parse(raw);
}

const options = (extra: Partial<StartOptions> = {}): StartOptions => ({
  ref: 'golden',
  repoDir,
  targetDir,
  logsDir,
  ...extra,
});

const read = (file: string) => readFile(path.join(repoDir, file), 'utf8');

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'awt-lifecycle-'));
  targetDir = path.join(root, 'targets', 'fake');
  repoDir = path.join(targetDir, 'repo');
  for (const sub of ['api', 'web']) {
    await mkdir(path.join(repoDir, sub), { recursive: true });
    await writeFile(path.join(repoDir, sub, 'package-lock.json'), '{}');
  }
  await writeFile(path.join(repoDir, 'fake-service.cjs'), FAKE_SERVICE);
  await writeFile(path.join(repoDir, '.gitignore'), '*.txt\n*.log\n*.json\n!package-lock.json\n.env\nnode_modules\n');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repoDir, '-c', 'user.name=t', '-c', 'user.email=t@x.test', ...args], { stdio: 'pipe' });
  git('init', '--quiet');
  git('add', '.');
  git('commit', '--quiet', '-m', 'fake app');
  git('branch', 'golden');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  backendPort = await freePort();
  frontendPort = await freePort();
  logsDir = await mkdtemp(path.join(root, 'logs-'));
  process.env.LLM_API_KEY = 'must-not-leak';
});

afterEach(() => {
  if (parentKey === undefined) delete process.env.LLM_API_KEY;
  else process.env.LLM_API_KEY = parentKey;
});

async function portsFree(): Promise<boolean> {
  return !(await isPortInUse('127.0.0.1', backendPort)) && !(await isPortInUse('127.0.0.1', frontendPort));
}

describe('startTarget', () => {
  it('runs the whole lifecycle and stops cleanly', async () => {
    const target = await startTarget(makeConfig(), options());
    try {
      expect(target.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(target.healthChecks.map((c) => [c.name, c.ok])).toEqual([
        ['backend', true],
        ['frontend', true],
      ]);
      expect(target.seed).toEqual([{ request: 'POST /api/auth/register', status: 200, ok: true }]);
      expect(await read('api/requests.log')).toBe('{"email":"alice@x.test"}\n');
      expect((await read('api/seed.txt')).trim()).toBe(`mongodb://db/test ${targetDir}`);
      expect(await read('web/.env')).toBe(`PORT=${frontendPort}\nAPI_URL=http://127.0.0.1:${backendPort}/api\n`);

      const backendKeys: string[] = JSON.parse(await read('api/env-keys.json'));
      expect(backendKeys).toContain('MAIL_KEY');
      expect(backendKeys).toContain('PATH');
      expect(backendKeys).not.toContain('LLM_API_KEY');
      expect(await readFile(path.join(logsDir, 'setup.log'), 'utf8')).toContain('$ echo reset');
    } finally {
      await target.stop();
    }
    expect(await portsFree()).toBe(true);
    await target.stop(); // a second stop is harmless
  });

  it('installs only when the lockfile changed', async () => {
    for (const sub of ['api', 'web']) await rm(path.join(repoDir, sub, 'node_modules'), { recursive: true, force: true });
    await rm(path.join(repoDir, 'installs.txt'), { force: true });
    await withTarget(makeConfig(), options(), async () => {});
    await withTarget(makeConfig(), options(), async () => {});
    expect(await read('installs.txt')).toBe('api\nweb\n'); // the second start installed nothing
  });

  it('records a failed health check without throwing when a service dies', async () => {
    const config = makeConfig((c) => (c.backend.start = 'exit 1'));
    const t0 = Date.now();
    await withTarget(config, options(), async (target) => {
      expect(target.healthChecks.map((c) => [c.name, c.ok])).toEqual([
        ['backend', false],
        ['frontend', true],
      ]);
      expect(target.seed[0]).toMatchObject({ status: null, ok: false });
    });
    expect(Date.now() - t0).toBeLessThan(4000); // did not wait for the 5 s startup timeout
  });

  it('applies the override, including null removal, and skips seeding when asked', async () => {
    await withTarget(
      makeConfig(),
      options({ configOverride: { backend: { env: { MAIL_KEY: null } } }, skipSeed: true }),
      async (target) => {
        expect(target.seed).toEqual([]);
        expect(JSON.parse(await read('api/env-keys.json'))).not.toContain('MAIL_KEY');
      },
    );
  });

  it('stops the services when a later step throws', async () => {
    const config = makeConfig((c) => (c.seed[0].body.email = '{{fixtures.users.nobody.email}}'));
    await expect(startTarget(config, options())).rejects.toThrow(/Unknown placeholder/);
    expect(await portsFree()).toBe(true);
  });

  it('stops the services when the caller throws', async () => {
    await expect(
      withTarget(makeConfig(), options(), async () => {
        throw new Error('test failure');
      }),
    ).rejects.toThrow('test failure');
    expect(await portsFree()).toBe(true);
  });

  it('stops when aborted during start-up', async () => {
    const neverReady = makeConfig((c) => (c.frontend.start = 'sleep 30'));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    await expect(startTarget(neverReady, options({ signal: controller.signal }))).rejects.toThrow(/aborted/);
    expect(await portsFree()).toBe(true);
  });

  it('fails when the reset command fails, before starting anything', async () => {
    const config = makeConfig((c) => (c.lifecycle.reset = 'exit 2'));
    await expect(startTarget(config, options())).rejects.toThrow(/Reset command failed/);
    expect(await portsFree()).toBe(true);
  });

  it('refuses to start when a port is already in use', async () => {
    const squatter = http.createServer((_req, res) => res.end());
    await new Promise<void>((resolve) => squatter.listen(backendPort, '127.0.0.1', resolve));
    try {
      await expect(startTarget(makeConfig(), options())).rejects.toThrow(/already in use/);
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
  });

  it('fails clearly for an unknown ref', async () => {
    await expect(startTarget(makeConfig(), options({ ref: 'no-such-ref' }))).rejects.toThrow(/git checkout/);
  });
});
