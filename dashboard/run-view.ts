/* eslint-disable @typescript-eslint/no-explicit-any */
// Reads a run folder (runs/<id>/) and turns it into one JSON view for the page. Read-only: it never writes,
// never starts anything, and never imports pipeline logic. File formats are the ones the pipeline writes today
// (run.json, scripts/manifest.json, testcases.json, prd.json, coverage via run.json, executions/x-NN/*).
import { readdir, readFile, stat, open } from 'node:fs/promises';
import path from 'node:path';
import { shortError } from './redact.js';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const RUNS_DIR = process.env.DASHBOARD_RUNS_DIR ?? path.join(ROOT, 'runs');
export const TARGETS_DIR = process.env.DASHBOARD_TARGETS_DIR ?? path.join(ROOT, 'targets');

type J = any;

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const isRunId = (id: unknown): id is string => typeof id === 'string' && RUN_ID.test(id) && id.length < 120;

// ---------------------------------------------------------------- reading with a small cache

const cache = new Map<string, { sig: string; value: unknown }>();

export async function readJson(file: string): Promise<J | null> {
  try {
    const s = await stat(file);
    const sig = `${s.mtimeMs}:${s.size}`;
    const hit = cache.get(file);
    if (hit?.sig === sig) return hit.value;
    const value = JSON.parse(await readFile(file, 'utf8'));
    cache.set(file, { sig, value });
    return value;
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

// ---------------------------------------------------------------- run list

export interface RunSummary {
  id: string;
  target: string;
  createdAt: string;
  stages: Record<string, string>;
  executions: number;
}

export async function listRuns(runsDir = RUNS_DIR): Promise<RunSummary[]> {
  const names = await readdir(runsDir).catch(() => [] as string[]);
  const out: RunSummary[] = [];
  for (const id of names) {
    if (!isRunId(id)) continue;
    const m = await readJson(path.join(runsDir, id, 'run.json'));
    if (!m?.target || !m.createdAt) continue;
    const stages: Record<string, string> = {};
    for (const [k, v] of Object.entries<J>(m.stages ?? {})) stages[k] = v?.status ?? 'pending';
    out.push({ id, target: m.target, createdAt: m.createdAt, stages, executions: (m.executions ?? []).length });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listTargets(targetsDir = TARGETS_DIR): Promise<string[]> {
  const names = await readdir(targetsDir).catch(() => [] as string[]);
  const out: string[] = [];
  for (const n of names) if (await exists(path.join(targetsDir, n, 'target.config.json'))) out.push(n);
  return out.sort();
}

// ---------------------------------------------------------------- variants (ids only)

export interface VariantChoice {
  /** What the page sends back: "<set>:<id>" where set is "draw" or "dev:<folder>". */
  value: string;
  id: string;
  group: 'draw' | 'dev';
}

async function variantFiles(target: string, targetsDir: string): Promise<Array<{ set: string; group: 'draw' | 'dev'; file: string; dir: string }>> {
  const base = path.join(targetsDir, target);
  const files: Array<{ set: string; group: 'draw' | 'dev'; file: string; dir: string }> = [{ set: 'draw', group: 'draw', file: path.join(base, 'variants.json'), dir: path.join(base, 'variants') }];
  const devRoot = path.join(base, 'dev-bugs');
  for (const n of await readdir(devRoot).catch(() => [] as string[])) {
    files.push({ set: `dev:${n}`, group: 'dev', file: path.join(devRoot, n, 'variants.json'), dir: path.join(devRoot, n, 'variants') });
  }
  return files;
}

/** Ids of the code variants a person may run. Never the patch, the file, the mutator or the description. */
export async function listVariants(target: string, targetsDir = TARGETS_DIR): Promise<VariantChoice[]> {
  if (!isRunId(target)) return [];
  const out: VariantChoice[] = [];
  for (const f of await variantFiles(target, targetsDir)) {
    const v = await readJson(f.file);
    for (const x of v?.variants ?? []) {
      if (x.kind === 'code' && typeof x.id === 'string' && x.patch) out.push({ value: `${f.set}:${x.id}`, id: x.id, group: f.group });
    }
  }
  return out;
}

/** Path of the patch for a chosen variant, relative to the project root (for `--patch`). */
export async function resolveVariantPatch(target: string, value: string, targetsDir = TARGETS_DIR): Promise<string | null> {
  const i = value.lastIndexOf(':');
  if (i < 0) return null;
  const set = value.slice(0, i);
  const id = value.slice(i + 1);
  for (const f of await variantFiles(target, targetsDir)) {
    if (f.set !== set) continue;
    const v = await readJson(f.file);
    const x = (v?.variants ?? []).find((y: J) => y.id === id && y.kind === 'code');
    if (!x?.patch) return null;
    const abs = path.resolve(path.dirname(f.file), x.patch);
    if (!abs.startsWith(path.resolve(targetsDir) + path.sep) || !(await exists(abs))) return null;
    return path.relative(path.dirname(targetsDir), abs);
  }
  return null;
}

// ---------------------------------------------------------------- playwright.log (live progress)

const logCache = new Map<string, { size: number; total: number; started: number; failed: number }>();

/** Progress from Playwright's line reporter: "Running N tests", "[k/N]" per test start, "  n) [chromium] ..." per failure. */
async function readPlaywrightProgress(file: string): Promise<{ total: number; started: number; failed: number } | null> {
  let s;
  try {
    s = await stat(file);
  } catch {
    return null;
  }
  const prev = logCache.get(file) ?? { size: 0, total: 0, started: 0, failed: 0 };
  const state = s.size < prev.size ? { size: 0, total: 0, started: 0, failed: 0 } : { ...prev };
  if (s.size > state.size) {
    const fh = await open(file, 'r');
    try {
      const buf = Buffer.alloc(s.size - state.size);
      await fh.read(buf, 0, buf.length, state.size);
      for (const line of buf.toString('utf8').split('\n')) {
        const run = /^Running (\d+) tests?/.exec(line);
        if (run) state.total = Number(run[1]);
        const k = /^\[(\d+)\/(\d+)\]/.exec(line);
        if (k) {
          state.started = Number(k[1]);
          state.total = Number(k[2]);
        }
        if (/^\s+\d+\) \[/.test(line)) state.failed += 1;
      }
    } finally {
      await fh.close();
    }
    state.size = s.size;
  }
  logCache.set(file, state);
  return state;
}

export async function tailFile(file: string, maxLines = 300): Promise<string[]> {
  try {
    const s = await stat(file);
    const len = Math.min(s.size, 256 * 1024);
    const fh = await open(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, s.size - len);
      const lines = buf.toString('utf8').split('\n');
      return lines.slice(-maxLines);
    } finally {
      await fh.close();
    }
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- cost from llm-calls.jsonl

const costCache = new Map<string, { size: number; byPurpose: Record<string, number>; calls: number }>();

async function readCost(file: string): Promise<{ total: number; calls: number; byPurpose: Record<string, number> } | null> {
  let s;
  try {
    s = await stat(file);
  } catch {
    return null;
  }
  const prev = costCache.get(file);
  if (prev?.size === s.size) return { total: Object.values(prev.byPurpose).reduce((a, b) => a + b, 0), calls: prev.calls, byPurpose: prev.byPurpose };
  const byPurpose: Record<string, number> = {};
  let calls = 0;
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      calls += 1;
      if (typeof r.costUsd === 'number') byPurpose[r.purpose ?? 'other'] = (byPurpose[r.purpose ?? 'other'] ?? 0) + r.costUsd;
    } catch {
      // a half-written last line
    }
  }
  costCache.set(file, { size: s.size, byPurpose, calls });
  return { total: Object.values(byPurpose).reduce((a, b) => a + b, 0), calls, byPurpose };
}

// ---------------------------------------------------------------- the view

const ms = (a?: string | null, b?: string | null): number | null => (a && b ? Math.max(0, Date.parse(b) - Date.parse(a)) : null);

const STAGE_LABELS: Array<[string, string]> = [
  ['prd', 'Requirements'],
  ['cases', 'Test cases'],
  ['scripts', 'Scripts'],
  ['gaps', 'Coverage round'],
  ['execute', 'Execution'],
  ['analyze', 'Diagnosis'],
];

export interface ViewOptions {
  runsDir?: string;
  targetsDir?: string;
  now?: number;
}

export async function buildView(runId: string, options: ViewOptions = {}): Promise<J | null> {
  const runsDir = options.runsDir ?? RUNS_DIR;
  const now = options.now ?? Date.now();
  if (!isRunId(runId)) return null;
  const dir = path.join(runsDir, runId);
  const run = await readJson(path.join(dir, 'run.json'));
  if (!run) return null;

  const [prd, cases, manifest, mapping, cost] = await Promise.all([
    readJson(path.join(dir, 'prd.json')),
    readJson(path.join(dir, 'testcases.json')),
    readJson(path.join(dir, 'scripts', 'manifest.json')),
    readJson(path.join(dir, 'eval', 'mapping.json')),
    readCost(path.join(dir, 'llm-calls.jsonl')),
  ]);

  const stageOf = (k: string): J => run.stages?.[k] ?? { status: 'pending' };

  // --- executions
  const versionOf = new Map<string, string>();
  for (const v of mapping?.versions ?? []) versionOf.set(v.execId, v.version);
  const executions: J[] = [];
  const diagnoses: J[] = [];
  let modeSeen: string | null = null;
  for (const e of run.executions ?? []) {
    const xdir = path.join(dir, 'executions', e.execId);
    const results = await readJson(path.join(xdir, 'results.json'));
    const progress = results ? null : await readPlaywrightProgress(path.join(xdir, 'playwright.log'));
    const full = await readJson(path.join(xdir, 'diagnoses.json'));
    const noTools = full ? null : await readJson(path.join(xdir, 'diagnoses.no-tools.json'));
    const diag = full ?? noTools;
    if (diag?.mode) modeSeen = diag.mode;
    const patchId = typeof e.patch === 'string' ? path.basename(e.patch).replace(/\.patch$/, '') : null;
    const label = versionOf.get(e.execId) ?? patchId ?? 'golden';
    const kind = label.startsWith('env') ? 'environment' : label === 'golden' ? 'golden' : 'code';
    const s = results?.summary;
    let total = 0;
    let passed = 0;
    let failed = 0;
    let errored = 0;
    let done = 0;
    let skipped = 0;
    if (s) {
      total = s.total;
      passed = s.passed;
      failed = s.failed;
      errored = s.errored;
      skipped = s.skipped ?? 0;
      done = total;
    } else if (progress) {
      total = progress.total;
      done = Math.max(0, Math.min(total, progress.started - (e.executeStatus === 'running' ? 1 : 0)));
      failed = Math.min(done, progress.failed);
      passed = done - failed;
    }
    const seq = (results?.results ?? []).map((r: J) => (r.status === 'passed' ? 'p' : r.status === 'failed' ? 'f' : 'e')).join('');
    executions.push({
      execId: e.execId,
      label,
      kind,
      executeStatus: e.executeStatus,
      analyzeStatus: e.analyzeStatus,
      startedAt: results?.startedAt ?? null,
      finishedAt: results?.finishedAt ?? null,
      durationMs: ms(results?.startedAt, results?.finishedAt),
      total, done, passed, failed, errored, skipped, seq,
      incidents: (results?.incidents ?? []).length,
      analysisMs: diag?.summary?.durationMs ?? null,
    });
    if (diag) {
      diagnoses.push({
        execId: e.execId,
        label,
        mode: diag.mode ?? 'full',
        generatedAt: diag.generatedAt,
        summary: diag.summary ?? null,
        items: (diag.diagnoses ?? []).map((d: J) => ({
          id: d.id,
          testCaseIds: d.testCaseIds ?? [],
          classification: d.classification,
          confidence: d.confidence,
          summary: d.summary,
          rootCause: d.rootCause,
          location: d.location ?? null,
          suggestedFix: d.suggestedFix?.description ?? null,
          evidence: (d.evidence ?? []).map((x: J) => ({ source: x.source, detail: x.detail })),
        })),
      });
    }
  }
  // Newest first: running ones, then by start time, then by id.
  executions.sort((a, b) => (b.startedAt ?? '9').localeCompare(a.startedAt ?? '9') || b.execId.localeCompare(a.execId));

  // --- stages
  const stages = STAGE_LABELS.map(([key, label]) => {
    if (key === 'execute' || key === 'analyze') return { key, label } as J;
    const st = stageOf(key);
    const running = st.status === 'running';
    return {
      key, label,
      status: st.status,
      startedAt: st.startedAt ?? null,
      finishedAt: st.finishedAt ?? null,
      elapsedMs: running ? 0 : (ms(st.startedAt, st.finishedAt) ?? 0),
      runningSince: running ? st.startedAt ?? null : null,
      error: st.status === 'failed' ? shortError(st.error) : '',
    };
  });
  const execStage = stages.find((s: J) => s.key === 'execute');
  const diagStage = stages.find((s: J) => s.key === 'analyze');
  const runningExecView = executions.find((e) => e.executeStatus === 'running');
  Object.assign(execStage, stepStage(run.executions ?? [], 'executeStatus', executions.reduce((a, e) => a + (e.durationMs ?? 0), 0), runningExecView?.startedAt ?? null));
  const analysisStartMs = (x: J) => (x.analysisMs ?? 0);
  Object.assign(diagStage, stepStage(run.executions ?? [], 'analyzeStatus', executions.reduce((a, e) => a + analysisStartMs(e), 0), null));
  // A running analysis has no start time of its own; the page counts from when it first saw it running.
  if (diagStage.status === 'running') diagStage.runningSince = null;

  // --- demo runs: the coverage stage only measures
  const demo = await readJson(path.join(dir, 'demo.json'));
  let measured: J = null;
  if (demo) {
    const g = stages.find((x: J) => x.key === 'gaps');
    const st = demo.steps?.coverage;
    Object.assign(g, {
      label: 'Coverage (measured)',
      status: st?.finishedAt ? 'done' : st?.startedAt ? 'running' : 'pending',
      startedAt: st?.startedAt ?? null,
      finishedAt: st?.finishedAt ?? null,
      elapsedMs: st?.finishedAt ? (ms(st.startedAt, st.finishedAt) ?? 0) : 0,
      runningSince: st?.finishedAt ? null : st?.startedAt ?? null,
    });
    const c = await readJson(path.join(dir, 'coverage', 'coverage.json'));
    if (c?.endpoints) {
      const reached = c.endpoints.filter((e: J) => e.reached || e.observed).length;
      measured = { reached, total: c.endpoints.length, unreached: c.endpoints.length - reached, asked: 0, measuredOnly: true };
    }
  }
  const purposeCost = (names: string[]) => (cost ? names.reduce((a, n) => a + (cost.byPurpose[n] ?? 0), 0) : null);
  const stageCost: Record<string, number | null> = { prd: purposeCost(['prd']), cases: purposeCost(['cases']), scripts: purposeCost(['scripts', 'review']), gaps: purposeCost(['gaps']), analyze: purposeCost(['analyzer']) };
  for (const st of stages) st.costUsd = stageCost[st.key] ?? null;

  // --- generation panels
  const cov = stageOf('gaps').gaps ?? null;
  const featureOfReq = new Map<string, string>();
  const featureName = new Map<string, string>((prd?.features ?? []).map((f: J) => [f.id, f.name]));
  for (const r of prd?.requirements ?? []) featureOfReq.set(r.id, featureName.get(r.featureId) ?? r.featureId);
  const caseList = (cases?.testCases ?? []).map((t: J) => ({
    id: t.id, title: t.title, layer: t.layer, category: t.category, priority: t.priority,
    requirementIds: t.requirementIds ?? [], feature: featureOfReq.get(t.requirementIds?.[0]) ?? null,
  }));
  const byId = new Map<string, J>((manifest?.scripts ?? []).map((s: J) => [s.testCaseId, s]));
  const scriptList = [...byId.values()].map((s: J) => ({
    id: s.testCaseId,
    status: scriptStatus(s),
    attempts: s.attempts ?? 1,
    category: s.failureCategory ?? null,
  }));
  const totals = { passed: 0, repaired: 0, suspected: 0, invalid: 0, pending: 0, total: caseList.length };
  for (const s of scriptList) totals[s.status as 'passed' | 'repaired' | 'suspected' | 'invalid'] += 1;
  totals.pending = Math.max(0, totals.total - scriptList.length);
  const scriptsStage = stageOf('scripts').scripts ?? null;

  // --- headline
  const stageMs = stages.reduce((a: number, s: J) => a + (s.elapsedMs ?? 0), 0);
  const modes = new Set(diagnoses.map((d) => d.mode));
  return {
    now,
    run: {
      id: runId,
      target: run.target,
      createdAt: run.createdAt,
      generationRef: run.generationRef,
      generationCommit: run.generationCommit,
      model: run.llm?.models?.scripts ?? run.llm?.models?.other ?? null,
      models: run.llm?.models ?? {},
      efforts: run.llm?.reasoningEffort ?? {},
      frozenTag: run.frozen?.tag ?? null,
      mode: modes.size === 0 ? null : modes.size === 1 ? [...modes][0] : 'mixed',
      cost: cost?.total ?? null,
      calls: cost?.calls ?? 0,
      workMs: stageMs,
    },
    stages,
    prd: prd
      ? {
          features: prd.features.length,
          endpoints: prd.apiEndpoints.length,
          uiRoutes: prd.uiRoutes.length,
          requirements: prd.requirements.length,
          featureNames: prd.features.map((f: J) => f.name),
        }
      : null,
    cases: {
      total: caseList.length,
      api: caseList.filter((c: J) => c.layer === 'api').length,
      browser: caseList.filter((c: J) => c.layer === 'ui').length,
      list: caseList,
      cost: stageOf('cases').generation?.costUsd ?? null,
    },
    scripts: { totals, list: scriptList, removed: scriptsStage?.removedExpectations?.length ?? 0, repairedCases: scriptsStage?.repaired?.cases ?? 0 },
    coverage: measured ?? (cov?.endpoints ? { reached: cov.endpoints.reached, total: cov.endpoints.total, unreached: (cov.unreached ?? []).length, asked: (cov.asked ?? []).length } : null),
    executions,
    diagnoses,
    modeSeen,
    demo: demo
      ? {
          demoOnly: true,
          selection: demo.selection ?? null,
          awaiting: !demo.selection && stageOf('prd').status === 'done',
          steps: demo.steps ?? {},
          executions: demo.executions ?? {},
        }
      : null,
  };
}

function scriptStatus(s: J): 'passed' | 'repaired' | 'suspected' | 'invalid' {
  if (s.status === 'invalid') return 'invalid';
  if (s.validationOutcome === 'assertion_failed') return 'suspected';
  return (s.attempts ?? 1) > 1 ? 'repaired' : 'passed';
}

function stepStage(executions: J[], field: string, doneMs: number, runningSince: string | null): J {
  const states = executions.map((e) => e[field]);
  let status = 'pending';
  if (states.includes('running')) status = 'running';
  else if (states.includes('failed') && !states.includes('pending')) status = 'failed';
  else if (states.length > 0 && states.every((s) => s === 'done')) status = 'done';
  else if (states.includes('done')) status = 'running';
  return { status, startedAt: null, finishedAt: null, elapsedMs: doneMs, runningSince: status === 'running' ? runningSince : null, error: '' };
}

// ---------------------------------------------------------------- the files the page may read

/** Whitelisted logs of an execution, as lines. */
export async function readExecutionLog(runId: string, execId: string, name: string, runsDir = RUNS_DIR): Promise<string[] | null> {
  if (!isRunId(runId) || !/^x-\d+$/.test(execId)) return null;
  const files: Record<string, string> = { playwright: 'playwright.log', backend: 'server/backend.log', frontend: 'server/frontend.log', setup: 'server/setup.log' };
  const rel = files[name];
  if (!rel) return null;
  return tailFile(path.join(runsDir, runId, 'executions', execId, rel), 400);
}

/** Version label of an execution (variant id, env id or golden), the same rule as the view. */
export async function executionInfo(runId: string, execId: string, runsDir = RUNS_DIR): Promise<{ target: string; commit: string; patchRel: string | null; label: string } | null> {
  const run = await readJson(path.join(runsDir, runId, 'run.json'));
  const e = (run?.executions ?? []).find((x: J) => x.execId === execId);
  if (!run || !e) return null;
  const mapping = await readJson(path.join(runsDir, runId, 'eval', 'mapping.json'));
  const mapped = (mapping?.versions ?? []).find((v: J) => v.execId === execId)?.version as string | undefined;
  const patchId = typeof e.patch === 'string' ? path.basename(e.patch).replace(/\.patch$/, '') : null;
  const label = mapped ?? patchId ?? 'golden';
  let patchRel: string | null = null;
  if (typeof e.patch === 'string') patchRel = e.patch;
  else if (mapped && /^bug-\d+$/.test(mapped)) patchRel = path.join('targets', run.target, 'variants', `${mapped}.patch`);
  return { target: run.target, commit: e.commit ?? run.generationCommit, patchRel, label };
}

// ---------------------------------------------------------------- the results tab

function mdTable(text: string, heading: RegExp): { headers: string[]; rows: string[][] } | null {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && heading.test(l));
  if (start < 0) return null;
  let i = start + 1;
  while (i < lines.length && !lines[i]!.startsWith('|')) {
    if (/^#{1,6}\s/.test(lines[i]!)) return null;
    i += 1;
  }
  const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const headers = cells(lines[i]!);
  i += 2;
  const rows: string[][] = [];
  while (i < lines.length && lines[i]!.startsWith('|')) rows.push(cells(lines[i++]!));
  return { headers, rows };
}

export async function readResults(scoringDir = path.join(ROOT, 'scoring', 'out')): Promise<J | null> {
  const scores = await readJson(path.join(scoringDir, 'scores.json'));
  if (!scores) return null;
  const read = (f: string) => readFile(path.join(scoringDir, f), 'utf8').catch(() => '');
  const [review, tables] = await Promise.all([read('final-review.md'), read('results-tables.md')]);
  const ablation = await readJson(path.join(scoringDir, '..', 'out-notools', 'scores.json'));
  const a = scores.aggregate;
  return {
    protocolSha256: scores.protocolSha256,
    suites: scores.suites.map((s: J) => ({ repeatId: s.repeatId, counts: s.counts, totals: s.totals, rates: s.rates, golden: s.golden })),
    rates: a.rates,
    variants: a.variants,
    cost: a.cost,
    confusion: a.confusion,
    caughtByNoSuite: a.caughtByNoSuite,
    goldenFalseAlarm: a.goldenFalseAlarm,
    warnings: a.warnings,
    whyNot: mdTable(review, /^#{1,6}\s+Counts/),
    sensitivity: mdTable(review, /Sensitivity/),
    ablation: mdTable(tables, /3d\.\s+Ablation/),
    realBugs: mdTable(tables, /5\.\s+Real bugs/),
    ablationRates: ablation?.aggregate?.rates ?? null,
  };
}
