import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  isCleanStart,
  startTarget,
  withTarget,
  type StartOptions,
} from '../../src/modules/execution-engine/lifecycle.js';
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
    if (req.url === '/items' || req.url === '/empty') {
      const seeded = req.url === '/items' && fs.existsSync('requests.log');
      const items = seeded ? fs.readFileSync('requests.log', 'utf8').trim().split('\\n') : [];
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: { items } }));
    }
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
  git('branch', 'variant');
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

  const itemsCheck = (path: string) => ({ method: 'GET', path, expect: { status: 200, nonEmptyArrayAt: 'data.items' } });

  it('passes the seed check when the seeded data is there and records it', async () => {
    const config = makeConfig((c) => (c.seedCheck = itemsCheck('/items')));
    await withTarget(config, options(), async (target) => {
      expect(target.seedCheck).toEqual({ ok: true, status: 200, detail: 'ok' });
    });
    expect(await readFile(path.join(logsDir, 'setup.log'), 'utf8')).toContain('[seed check] GET /items: ok');
  });

  it('on a clean start, a failed seed check fails the start and stops the services', async () => {
    const config = makeConfig((c) => (c.seedCheck = itemsCheck('/empty')));
    await expect(startTarget(config, options())).rejects.toThrow(
      'Seed check failed: GET /empty: expected a non-empty array at "data.items", got an empty one',
    );
    expect(await portsFree()).toBe(true);
  });

  it('on any other start, a failed seed check is recorded and the start continues', async () => {
    const config = makeConfig((c) => (c.seedCheck = itemsCheck('/empty')));
    const failed = { ok: false, status: 200, detail: 'expected a non-empty array at "data.items", got an empty one' };
    const nonClean: Partial<StartOptions>[] = [
      { ref: 'variant' },
      { configOverride: { backend: { env: { MAIL_KEY: 'x' } } } },
      { generationRef: 'variant' }, // golden is then not this run's generation ref
    ];
    for (const extra of nonClean) {
      await withTarget(config, options(extra), async (target) => {
        expect(target.seedCheck).toEqual(failed);
        expect(target.healthChecks.every((c) => c.ok)).toBe(true);
      });
    }
    expect(await portsFree()).toBe(true);
  });

  it('skips the seed check when the backend is unhealthy or seeding is skipped', async () => {
    const deadBackend = makeConfig((c) => {
      c.seedCheck = itemsCheck('/empty');
      c.backend.start = 'exit 1';
    });
    await withTarget(deadBackend, options(), async (target) => {
      expect(target.healthChecks[0]?.ok).toBe(false);
      expect(target).not.toHaveProperty('seedCheck');
    });
    const config = makeConfig((c) => (c.seedCheck = itemsCheck('/empty')));
    await withTarget(config, options({ skipSeed: true }), async (target) => {
      expect(target).not.toHaveProperty('seedCheck');
    });
  });

  it('isCleanStart: generation ref, no override, no skipSeed', () => {
    const config = makeConfig();
    expect(isCleanStart(config, options())).toBe(true);
    expect(isCleanStart(config, options({ ref: 'variant', generationRef: 'variant' }))).toBe(true);
    expect(isCleanStart(config, options({ ref: 'variant' }))).toBe(false);
    expect(isCleanStart(config, options({ configOverride: {} }))).toBe(true); // changes nothing
    expect(isCleanStart(config, options({ configOverride: { backend: { env: {} } } }))).toBe(true);
    expect(isCleanStart(config, options({ configOverride: { backend: { env: { JWT_SECRET: null } } } }))).toBe(false);
    expect(isCleanStart(config, options({ configOverride: { lifecycle: { startupTimeoutMs: 5000 } } }))).toBe(false);
    expect(isCleanStart(config, options({ skipSeed: true }))).toBe(false);
    expect(isCleanStart(config, options({ prepared: { commit: 'abc1234', patched: false } }))).toBe(true);
    expect(isCleanStart(config, options({ prepared: { commit: 'abc1234', patched: true } }))).toBe(false);
  });

  it('restore() resets and seeds again and restarts only the backend', async () => {
    await withTarget(makeConfig(), options(), async (target) => {
      const backendBefore = target.services.find((s) => s.name === 'backend')!.pid;
      const frontendBefore = target.services.find((s) => s.name === 'frontend')!.pid;
      const resetsBefore = (await read('resets.txt')).split('\n').filter(Boolean).length;
      const requestsBefore = (await read('api/requests.log')).split('\n').filter(Boolean).length;
      const { durationMs } = await target.restore();
      expect(durationMs).toBeGreaterThan(0);
      expect((await read('resets.txt')).split('\n').filter(Boolean).length).toBe(resetsBefore + 1);
      expect((await read('api/requests.log')).split('\n').filter(Boolean).length).toBe(requestsBefore + 1); // the seed request again
      expect(target.services.find((s) => s.name === 'backend')!.pid).not.toBe(backendBefore);
      expect(target.services.find((s) => s.name === 'frontend')!.pid).toBe(frontendBefore);
    });
    expect(await portsFree()).toBe(true); // stop() also stopped the restarted backend
  });

  it('restore() throws when a step fails', async () => {
    // The reset works at start, then fails on the second run.
    const config = makeConfig((c) => (c.lifecycle.reset = 'if [ -f reset-once ]; then exit 3; fi; touch reset-once'));
    await rm(path.join(repoDir, 'reset-once'), { force: true });
    try {
      await withTarget(config, options(), async (target) => {
        await expect(target.restore()).rejects.toThrow(/Reset command failed \(exit 3\)/);
      });
    } finally {
      await rm(path.join(repoDir, 'reset-once'), { force: true });
    }
  });

  it('restore() keeps the execution\'s own settings: with skipSeed it does not seed, and the override stays', async () => {
    const config = makeConfig();
    await rm(path.join(repoDir, 'api', 'requests.log'), { force: true });
    await rm(path.join(repoDir, 'api', 'seed.txt'), { force: true });
    await withTarget(
      config,
      options({ skipSeed: true, configOverride: { backend: { env: { MAIL_KEY: null } } } }),
      async (target) => {
        const backendBefore = target.services.find((s) => s.name === 'backend')!.pid;
        await target.restore();
        expect(target.services.find((s) => s.name === 'backend')!.pid).not.toBe(backendBefore); // it did restart
        // No seed command and no seed request, neither at start nor in the restore.
        await expect(read('api/seed.txt')).rejects.toThrow(/ENOENT/);
        await expect(read('api/requests.log')).rejects.toThrow(/ENOENT/);
        // The restarted backend still runs without the removed variable (an environment fault stays in place).
        expect(JSON.parse(await read('api/env-keys.json'))).not.toContain('MAIL_KEY');
      },
    );
  });

  it('restore() on a start that is not clean returns seed problems instead of throwing', async () => {
    const config = makeConfig((c) => (c.seedCheck = itemsCheck('/empty')));
    await withTarget(config, options({ ref: 'variant' }), async (target) => {
      const result = await target.restore();
      expect(result.backendHealthy).toBe(true);
      expect(result.problems).toEqual(['seed check failed: expected a non-empty array at "data.items", got an empty one']);
    });
  });

  it('restore() on a start that is not clean returns an unhealthy backend instead of throwing', async () => {
    // The backend starts once, then exits at once on its restart.
    const config = makeConfig((c) => (c.backend.start = 'if [ -f started-once ]; then exit 1; fi; touch started-once; node ../fake-service.cjs'));
    await rm(path.join(repoDir, 'api', 'started-once'), { force: true });
    try {
      await withTarget(config, options({ ref: 'variant' }), async (target) => {
        const result = await target.restore();
        expect(result.backendHealthy).toBe(false);
        expect(result.problems[0]).toMatch(/the backend did not become healthy again/);
      });
      await rm(path.join(repoDir, 'api', 'started-once'), { force: true });
      await withTarget(config, options(), async (target) => {
        await expect(target.restore()).rejects.toThrow(/Restore: the backend did not become healthy again/);
      });
    } finally {
      await rm(path.join(repoDir, 'api', 'started-once'), { force: true });
    }
    expect(await portsFree()).toBe(true);
  });

  it('exitOf() reports a crashed service and restartFrontend() brings the frontend back', async () => {
    await withTarget(makeConfig(), options(), async (target) => {
      expect(target.exitOf('frontend')).toBeNull();
      const frontend = target.services.find((s) => s.name === 'frontend')!;
      process.kill(-frontend.pid, 'SIGKILL');
      await frontend.exited;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(target.exitOf('frontend')).not.toBeNull();
      const health = await target.restartFrontend();
      expect(health.ok).toBe(true);
      expect(target.exitOf('frontend')).toBeNull();
      expect(target.services.find((s) => s.name === 'frontend')!.pid).not.toBe(frontend.pid);
    });
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
