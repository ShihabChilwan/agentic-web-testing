// Live dashboard: `npx tsx dashboard/server.ts` (default http://localhost:4000, env PORT / DASHBOARD_PORT).
// A small HTTP server with server-sent events. It reads runs/<id>/ and starts the existing CLI commands
// as child processes; it contains no pipeline logic.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { buildSourceTree, type SourceTree } from '../src/modules/execution-engine/source-tree.js';
import { DEFAULT_CAP, DemoError, featureOverview, markDemo, planDemo, readDemo, saveSelection, type Step } from './demo.js';
import { redactLine, shortError } from './redact.js';
import {
  ROOT, RUNS_DIR, TARGETS_DIR, buildView, executionInfo, isRunId, listRuns, listTargets, listVariants,
  readExecutionLog, readResults, resolveVariantPatch,
} from './run-view.js';

const PORT = Number(process.env.DASHBOARD_PORT ?? process.env.PORT ?? 4000);
const PUBLIC_DIR = path.join(ROOT, 'dashboard', 'public');
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');

// ---------------------------------------------------------------- jobs (one at a time: the target app uses fixed ports)

interface Job {
  id: number;
  title: string;
  runId: string | null;
  target: string | null;
  state: 'running' | 'done' | 'failed' | 'stopped';
  step: number;
  steps: Step[];
  demo: boolean;
  startedAt: number;
  finishedAt: number | null;
}

let job: Job | null = null;
let child: ChildProcess | null = null;
let jobCounter = 0;
let logSeq = 0;
const logLines: Array<{ n: number; text: string }> = [];
const clients = new Set<ServerResponse>();

function send(res: ServerResponse, event: string, data: unknown, id?: number) {
  res.write(`${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
const broadcast = (event: string, data: unknown, id?: number) => clients.forEach((c) => send(c, event, data, id));

function pushLog(text: string) {
  const entry = { n: ++logSeq, text: redactLine(text) };
  logLines.push(entry);
  if (logLines.length > 3000) logLines.splice(0, logLines.length - 3000);
  broadcast('log', entry, entry.n);
}
const publicJob = () => (job ? { ...job, steps: undefined, stepCount: job.steps.length } : null);
const pushJob = () => broadcast('job', publicJob());

function runStep() {
  if (!job) return;
  const step = job.steps[job.step]!;
  const advance = () => {
    if (!job) return;
    if (job.state === 'stopped') return finish('stopped');
    if (job.step + 1 < job.steps.length) {
      job.step += 1;
      pushJob();
      return runStep();
    }
    finish('done');
  };
  const fail = (err: unknown) => {
    pushLog(`failed: ${shortError(err instanceof Error ? err.message : err)}`);
    finish('failed');
  };
  void (async () => {
    try { await step.before?.(); } catch (err) { return fail(err); }
    if (!step.argv) {
      pushLog(`-- ${step.label}`);
      try { await step.run?.(); await step.after?.(); } catch (err) { return fail(err); }
      return advance();
    }
    pushLog(`$ npx tsx src/cli.ts ${step.argv.join(' ')}`);
    const proc = spawn(TSX, ['src/cli.ts', ...step.argv], { cwd: ROOT, detached: true, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child = proc;
    for (const stream of [proc.stdout, proc.stderr]) {
      let rest = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        const parts = (rest + chunk).split(/\r?\n/);
        rest = parts.pop() ?? '';
        parts.forEach(pushLog);
      });
      stream.on('end', () => rest && pushLog(rest));
    }
    proc.on('error', (err) => fail(err));
    proc.on('close', (code, signal) => {
      if (child !== proc || !job) return;
      child = null;
      if (job.state === 'stopped') return finish('stopped');
      if (code !== 0) {
        pushLog(`exit ${code ?? signal}`);
        return finish('failed');
      }
      void (async () => {
        try { await step.after?.(); } catch (err) { return fail(err); }
        advance();
      })();
    });
  })();
}

function finish(state: Job['state']) {
  if (!job) return;
  job.state = state;
  job.finishedAt = Date.now();
  pushLog(`-- ${job.title}: ${state}`);
  pushJob();
}

const argvSteps = (...list: string[][]): Step[] => list.map((argv) => ({ label: argv.join(' '), argv }));

function startJob(title: string, steps: Step[], target: string | null, runId: string | null, demo = false): Job {
  job = { id: ++jobCounter, title, runId, target, state: 'running', step: 0, steps, demo, startedAt: Date.now(), finishedAt: null };
  pushLog(`-- ${title}`);
  pushJob();
  runStep();
  return job;
}

function stopJob() {
  if (!job || job.state !== 'running') return false;
  job.state = 'stopped';
  if (child?.pid) {
    // the CLI handles SIGTERM (saves progress, stops the app); the group also catches its children
    const proc = child;
    try { process.kill(-proc.pid!, 'SIGTERM'); } catch { /* already gone */ }
    // a CLI that ignores SIGTERM is killed after 10 s so the job never stays "running"
    setTimeout(() => { if (child === proc) { try { process.kill(-proc.pid!, 'SIGKILL'); } catch { /* gone */ } } }, 10000).unref();
  } else finish('stopped');
  return true;
}

/** A job that creates a run does not know its id up front: find the folder the CLI created after the job started. */
async function attachNewRun() {
  if (!job || job.state !== 'running' || job.runId || !job.target) return;
  const mine = (await listRuns()).find((r) => r.target === job!.target && Date.parse(r.createdAt) >= job!.startedAt - 2000);
  if (mine) {
    job.runId = mine.id;
    if (job.demo) await markDemo(mine.id, mine.target);
    pushJob();
  }
}

// ---------------------------------------------------------------- execution ids

async function nextExecId(runId: string): Promise<string> {
  const run = JSON.parse(await readFile(path.join(RUNS_DIR, runId, 'run.json'), 'utf8')) as { executions?: Array<{ execId: string }> };
  const used = [...(await readdir(path.join(RUNS_DIR, runId, 'executions')).catch(() => [] as string[])), ...(run.executions ?? []).map((e) => e.execId)];
  const nums = used.map((id) => /^x-(\d+)$/.exec(id)?.[1]).filter((n): n is string => n !== undefined).map(Number);
  return `x-${String(Math.max(0, ...nums) + 1).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- code excerpts (source tree of the executed version)

const trees = new Map<string, Promise<SourceTree>>();

async function excerpt(runId: string, execId: string, file: string, from: number, to: number) {
  const info = await executionInfo(runId, execId);
  if (!info || !file || file.includes('..') || path.isAbsolute(file)) return null;
  const key = `${runId}/${execId}`;
  if (!trees.has(key)) {
    trees.set(key, buildSourceTree({
      repoDir: path.join(TARGETS_DIR, info.target, 'repo'),
      commit: info.commit,
      ...(info.patchRel ? { patchFile: path.join(ROOT, info.patchRel) } : {}),
    }));
    trees.get(key)!.catch(() => trees.delete(key));
  }
  const tree = await trees.get(key)!;
  const abs = path.resolve(tree.dir, file);
  if (!abs.startsWith(tree.dir + path.sep) || /(^|\/)(\.git|node_modules)(\/|$)/.test(file)) return null;
  const lines = (await readFile(abs, 'utf8').catch(() => null))?.split('\n');
  if (!lines) return null;
  const a = Math.max(1, from - 4);
  const b = Math.min(lines.length, Math.max(to, from) + 4, a + 59);
  return { file, from: a, to: b, mark: [from, to], lines: lines.slice(a - 1, b) };
}

async function cleanup() {
  for (const t of trees.values()) await t.then((x) => x.remove()).catch(() => undefined);
}

// ---------------------------------------------------------------- http

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

async function serveStatic(urlPath: string, res: ServerResponse) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const abs = path.resolve(PUBLIC_DIR, rel);
  if (!abs.startsWith(PUBLIC_DIR + path.sep)) return notFound(res);
  try {
    const body = await readFile(abs);
    res.writeHead(200, { 'content-type': TYPES[path.extname(abs)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    notFound(res);
  }
}

function notFound(res: ServerResponse) {
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"not found"}');
}
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of req) text += chunk;
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

async function handleStart(body: Record<string, unknown>, res: ServerResponse) {
  try {
    await handleStartInner(body, res);
  } catch (err) {
    json(res, err instanceof DemoError ? 400 : 500, { error: shortError(err instanceof Error ? err.message : err) });
  }
}

async function handleStartInner(body: Record<string, unknown>, res: ServerResponse) {
  if (job?.state === 'running') return json(res, 409, { error: 'A job is already running. Stop it first.' });
  const action = str(body.action);
  const runId = str(body.run);
  const targetOk = async (t: string | null) => Boolean(t && isRunId(t) && (await listTargets()).includes(t));
  if (action === 'demo-new') {
    const target = str(body.target);
    if (!(await targetOk(target))) return json(res, 400, { error: 'unknown target' });
    return json(res, 200, publicJobOf(startJob(`New demo run on ${target}`, argvSteps(['agent', 'prd', '--target', target!]), target, null, true)));
  }
  if (action === 'demo-start') {
    if (!runId || !isRunId(runId)) return json(res, 400, { error: 'bad run id' });
    const saved = (await readDemo(runId))?.selection;
    if (!saved || body.featureIds) {
      if (saved) throw new DemoError('The features of this demo run are already chosen');
      await saveSelection(runId, {
        featureIds: Array.isArray(body.featureIds) ? body.featureIds.filter((x): x is string => typeof x === 'string') : [],
        ...(typeof body.cap === 'number' ? { cap: body.cap } : {}),
        buggy: str(body.buggy),
        analyze: body.analyze !== false,
        confirm: body.confirm === true,
      });
    }
    const steps = await planDemo(runId);
    if (steps.length === 0) throw new DemoError('Nothing left to do for this demo run');
    return json(res, 200, publicJobOf(startJob(`Demo run ${runId}`, steps, null, runId, true)));
  }
  if (action === 'all' || action === 'continue') {
    const target = str(body.target);
    const fresh = body.fresh === true;
    if (runId && !fresh) {
      if (!isRunId(runId)) return json(res, 400, { error: 'bad run id' });
      // A demo run continues with its own steps: `agent all` would run every feature without the cap.
      if (await readDemo(runId)) {
        const steps = await planDemo(runId);
        if (steps.length === 0) throw new DemoError('Nothing left to do for this demo run');
        return json(res, 200, publicJobOf(startJob(`Continue demo run ${runId}`, steps, null, runId, true)));
      }
      return json(res, 200, publicJobOf(startJob(`Continue ${runId}`, argvSteps(['agent', 'all', '--run', runId]), null, runId)));
    }
    if (!(await targetOk(target))) return json(res, 400, { error: 'unknown target' });
    return json(res, 200, publicJobOf(startJob(`New run on ${target}`, argvSteps(['agent', 'all', '--target', target!, '--fresh']), target, null)));
  }
  if (action === 'execute') {
    if (!runId || !isRunId(runId)) return json(res, 400, { error: 'bad run id' });
    const run = (await listRuns()).find((r) => r.id === runId);
    if (!run) return json(res, 404, { error: 'unknown run' });
    if (run.stages.scripts !== 'done') return json(res, 400, { error: 'The scripts stage of this run is not done.' });
    const analyze = body.analyze !== false;
    const variant = str(body.variant);
    let patch: string | null = null;
    if (variant) {
      if (body.confirm !== true) return json(res, 400, { error: 'Running a buggy version needs confirmation.' });
      patch = await resolveVariantPatch(run.target, variant);
      if (!patch) return json(res, 400, { error: 'unknown variant' });
    }
    // Optionally the correct version first (the page asks for it when the run has none yet), then the chosen one.
    const versions: Array<string | null> = body.alsoGolden === true && patch ? [null, patch] : [patch];
    const first = await nextExecId(runId);
    const base = Number(first.slice(2));
    const lists: string[][] = [];
    versions.forEach((pt, i) => {
      const execId = `x-${String(base + i).padStart(2, '0')}`;
      lists.push(['agent', 'execute', '--run', runId, '--exec-id', execId, ...(pt ? ['--patch', pt] : [])]);
      if (analyze) lists.push(['agent', 'analyze', '--run', runId, '--exec', execId]);
    });
    const steps = argvSteps(...lists);
    const shown = variant ? variant.slice(variant.lastIndexOf(':') + 1) : 'golden';
    const started = startJob(`Execute ${versions.length > 1 ? 'golden + ' : ''}${shown}${analyze ? ' and analyze' : ''}`, steps, null, runId);
    return json(res, 200, publicJobOf(started));
  }
  if (action === 'analyze') {
    const execId = str(body.exec);
    if (!runId || !isRunId(runId) || !execId || !/^x-\d+$/.test(execId)) return json(res, 400, { error: 'bad run or execution id' });
    const started = startJob(`Analyze ${execId}`, argvSteps(['agent', 'analyze', '--run', runId, '--exec', execId]), null, runId);
    return json(res, 200, publicJobOf(started));
  }
  json(res, 400, { error: 'unknown action' });
}
const publicJobOf = (j: Job) => ({ ...j, steps: undefined, stepCount: j.steps.length });

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const p = url.pathname;
  const q = url.searchParams;

  if (req.method === 'GET' && p === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    const watch = { run: str(q.get('run')) };
    (res as ServerResponse & { watch?: typeof watch }).watch = watch;
    clients.add(res);
    req.on('close', () => clients.delete(res));
    send(res, 'job', publicJob());
    for (const l of logLines.slice(-500)) send(res, 'log', l, l.n);
    return;
  }
  if (req.method === 'GET' && p === '/api/runs') return json(res, 200, { runs: await listRuns(), targets: await listTargets() });
  if (req.method === 'GET' && p.startsWith('/api/run/')) {
    const view = await buildView(decodeURIComponent(p.slice('/api/run/'.length)));
    return view ? json(res, 200, view) : json(res, 404, { error: 'unknown run' });
  }
  if (req.method === 'GET' && p === '/api/variants') return json(res, 200, { variants: await listVariants(q.get('target') ?? '') });
  if (req.method === 'GET' && p === '/api/results') {
    const r = await readResults();
    return r ? json(res, 200, r) : json(res, 404, { error: 'scoring/out/scores.json not found' });
  }
  if (req.method === 'GET' && p === '/api/log') {
    const lines = await readExecutionLog(q.get('run') ?? '', q.get('exec') ?? '', q.get('name') ?? '');
    return lines ? json(res, 200, { lines: lines.map(redactLine) }) : json(res, 404, { error: 'no such log' });
  }
  if (req.method === 'GET' && p === '/api/excerpt') {
    try {
      const from = Number(q.get('from') ?? 1);
      const to = Number(q.get('to') ?? from);
      const x = await excerpt(q.get('run') ?? '', q.get('exec') ?? '', q.get('file') ?? '', from, to);
      return x ? json(res, 200, x) : json(res, 404, { error: 'no excerpt' });
    } catch (err) {
      return json(res, 500, { error: (err as Error).message });
    }
  }
  if (req.method === 'GET' && p === '/api/demo') {
    const id = q.get('run') ?? '';
    if (!isRunId(id) || !(await readDemo(id))) return json(res, 404, { error: 'not a demo run' });
    try {
      return json(res, 200, { features: await featureOverview(id), defaultCap: DEFAULT_CAP });
    } catch (err) {
      return json(res, 409, { error: shortError(err instanceof Error ? err.message : err) });
    }
  }
  if (req.method === 'POST' && p === '/api/start') return handleStart(await readBody(req), res);
  if (req.method === 'POST' && p === '/api/stop') return json(res, 200, { stopped: stopJob() });
  if (req.method === 'GET') return serveStatic(p, res);
  notFound(res);
}

// ---------------------------------------------------------------- push loop: the watched runs, once a second

const lastSent = new Map<string, string>();

async function tick() {
  await attachNewRun().catch(() => undefined);
  const wanted = new Set<string>();
  for (const c of clients) {
    const w = (c as ServerResponse & { watch?: { run: string | null } }).watch;
    if (w?.run) wanted.add(w.run);
  }
  for (const id of wanted) {
    const view = await buildView(id).catch(() => null);
    if (!view) continue;
    const { now: _now, ...rest } = view;
    const text = JSON.stringify(rest);
    if (lastSent.get(id) === text) continue;
    lastSent.set(id, text);
    for (const c of clients) {
      if ((c as ServerResponse & { watch?: { run: string | null } }).watch?.run === id) send(c, 'view', view);
    }
  }
  for (const id of [...lastSent.keys()]) if (!wanted.has(id)) lastSent.delete(id);
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!res.headersSent) json(res, 500, { error: (err as Error).message });
    else res.end();
  });
});

// The page opens /events?run=<id> and reconnects when the picked run changes.

setInterval(() => void tick(), 1000).unref();
setInterval(() => clients.forEach((c) => c.write(': keep-alive\n\n')), 15000).unref();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopJob();
    void cleanup().finally(() => process.exit(0));
  });
}

void stat(PUBLIC_DIR).then(
  () => server.listen(PORT, () => console.log(`Dashboard: http://localhost:${PORT}  (runs: ${RUNS_DIR})`)),
  () => { console.error(`Missing ${PUBLIC_DIR}`); process.exit(1); },
);
