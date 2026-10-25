import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { COVERAGE_PRELOAD, ranCharacters, ranLines, readV8Coverage } from '../../src/modules/execution-engine/coverage.js';
import { childEnv } from '../../src/modules/execution-engine/env.js';
import { startService, stopProcessGroup } from '../../src/modules/execution-engine/processes.js';

// A tiny backend whose handlers start on the line that registers them, as Express routes do.
const SERVER_JS = [
  "const http = require('node:http');", // 1
  'const routes = {', // 2
  "  '/a': (req, res) => {", // 3
  "    res.end('a');", // 4
  '  },', // 5
  "  '/b': (req, res) => {", // 6
  "    if (req.method === 'POST') return res.end('posted');", // 7
  "    res.end('b');", // 8
  '  },', // 9
  '};', // 10
  "http.createServer((req, res) => (routes[req.url] || ((q, r) => r.end('404')))(req, res)).listen(Number(process.env.PORT));", // 11
].join('\n');

const tempDirs: string[] = [];
afterEach(async () => {
  for (const d of tempDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

describe('backend coverage with NODE_V8_COVERAGE', () => {
  it('a server stopped with SIGTERM writes coverage through the preload; only lines inside called functions count', { timeout: 30_000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'awt-cov-'));
    tempDirs.push(dir);
    const tree = path.join(dir, 'tree');
    const raw = path.join(dir, 'v8');
    await mkdir(path.join(tree, 'server'), { recursive: true });
    await mkdir(raw);
    await writeFile(path.join(tree, 'server', 'index.js'), SERVER_JS);
    await writeFile(path.join(dir, 'flush.cjs'), COVERAGE_PRELOAD);
    const port = await freePort();

    // Started and stopped the way the lifecycle runs a backend: a shell leading its own process group.
    const env = childEnv({ PORT: String(port), NODE_V8_COVERAGE: raw, NODE_OPTIONS: `--require "${path.join(dir, 'flush.cjs')}"` });
    const service = startService('backend', 'node server/index.js', { cwd: tree, env, logFile: path.join(dir, 'backend.log') });
    let body = '';
    for (let i = 0; i < 50 && !body; i++) {
      body = await fetch(`http://127.0.0.1:${port}/b`).then((r) => r.text(), async () => (await new Promise((r) => setTimeout(r, 100)), ''));
    }
    expect(body).toBe('b');
    await stopProcessGroup(service.pid);
    expect((await readdir(raw)).length).toBeGreaterThan(0);

    const coverage = await readV8Coverage(raw, tree, (rel) => readFile(path.join(tree, rel), 'utf8').catch(() => null));
    // /b ran (lines 6-9; on 7 the condition ran, not the POST branch) and the server callback on 11; /a never did,
    // although its registration line 3 ran at load.
    expect(coverage.files).toEqual({ 'server/index.js': [6, 7, 8, 9, 11] });
  });

  it('the innermost range decides, and the top-level function counts as not run', () => {
    const source = 'aaaa\nbbbb\ncccc\n';
    const ran = ranCharacters(
      {
        url: 'file:///x.js',
        functions: [
          { functionName: '', ranges: [{ startOffset: 0, endOffset: 15, count: 1 }] },
          { functionName: 'f', ranges: [{ startOffset: 5, endOffset: 15, count: 2 }, { startOffset: 10, endOffset: 14, count: 0 }] },
        ],
      },
      source.length,
    );
    expect(ranLines(source, ran)).toEqual([2]);
  });
});
