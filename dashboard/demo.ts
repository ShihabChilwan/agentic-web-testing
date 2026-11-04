// Demo mode: a run limited to chosen features and a case cap, built only by editing the run folder's own files
// between the existing CLI stages (no option exists for this in the CLI, and src/ stays unchanged).
// Everything written here is recorded in runs/<id>/demo.json and marked DEMO-ONLY.txt; the full PRD and the full
// test case list are kept as prd.full.json and testcases.full.json.
import { readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Prd, TestCases, requirementEvidence } from '../src/shared/schemas.js';
import type { PrdRequirement } from '../src/shared/schemas.js';
import { RUNS_DIR, readJson, resolveVariantPatch } from './run-view.js';

export const DEFAULT_CAP = 20;
export const DEMO_STEPS = ['scope', 'cases', 'cap', 'scripts', 'coverage', 'golden', 'buggy', 'analyze'] as const;

export interface DemoSelection {
  featureIds: string[];
  cap: number;
  /** "<set>:<id>" from the variant dropdown, or null for the correct version only. */
  buggy: string | null;
  analyze: boolean;
}

export interface DemoRecord {
  demoOnly: true;
  note: string;
  target: string;
  createdAt: string;
  selection: DemoSelection | null;
  /** Time of each demo step; the coverage step also keeps what it measured. */
  steps: Record<string, { startedAt: string; finishedAt?: string; detail?: Record<string, unknown> }>;
  /** Execution ids this demo started, by version ("golden" or the variant id). */
  executions: Record<string, string>;
}

const demoFile = (runId: string) => path.join(RUNS_DIR, runId, 'demo.json');

export async function readDemo(runId: string): Promise<DemoRecord | null> {
  return (await readJson(demoFile(runId))) as DemoRecord | null;
}

async function writeAtomic(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

export async function writeDemo(runId: string, demo: DemoRecord) {
  await writeAtomic(demoFile(runId), demo);
}

/** Marks a run folder as a demo run. Called as soon as the run exists, before any stage can fail. */
export async function markDemo(runId: string, target: string): Promise<DemoRecord> {
  const existing = await readDemo(runId);
  if (existing) return existing;
  const demo: DemoRecord = {
    demoOnly: true,
    note: 'Demo run: limited to chosen features and a case cap by editing prd.json and testcases.json between stages. Not an evaluation run; never score it.',
    target, createdAt: new Date().toISOString(), selection: null, steps: {}, executions: {},
  };
  await writeFile(path.join(RUNS_DIR, runId, 'DEMO-ONLY.txt'), `${demo.note}\n`, 'utf8');
  await writeDemo(runId, demo);
  return demo;
}

// ---------------------------------------------------------------- which endpoints and pages belong to a feature

interface Ev { file: string; lines: [number, number] | number[] }
const overlaps = (a: Ev, b: Ev) => a.file === b.file && a.lines[0]! <= b.lines[1]! && b.lines[0]! <= a.lines[1]!;
const textOf = (r: PrdRequirement) => `${r.statement}\n${r.acceptanceCriteria.map((c) => c.text).join('\n')}`;

/**
 * Endpoints and pages carry no feature id, so they follow the requirements: one belongs to a requirement when their
 * evidence overlaps (same file, overlapping lines) or the requirement's text names the endpoint's path.
 */
export function relatedTo(prd: Prd, requirements: PrdRequirement[]) {
  const evidence = requirements.flatMap((r) => requirementEvidence(r) as Ev[]);
  const text = requirements.map(textOf).join('\n');
  const endpoints = prd.apiEndpoints.filter((e) => (e.evidence as Ev[]).some((x) => evidence.some((y) => overlaps(x, y))) || text.includes(e.path));
  const routes = prd.uiRoutes.filter((r) => (r.evidence as Ev[]).some((x) => evidence.some((y) => overlaps(x, y))) || (r.path.length > 1 && text.includes(r.path)));
  return { endpoints, routes };
}

async function readFullPrd(runId: string): Promise<Prd> {
  const dir = path.join(RUNS_DIR, runId);
  const raw = (await readJson(path.join(dir, 'prd.full.json'))) ?? (await readJson(path.join(dir, 'prd.json')));
  if (!raw) throw new Error('prd.json not found: the requirements stage is not done');
  return Prd.parse(raw);
}

export async function featureOverview(runId: string) {
  const prd = await readFullPrd(runId);
  return prd.features.map((f) => {
    const reqs = prd.requirements.filter((r) => r.featureId === f.id);
    const rel = relatedTo(prd, reqs);
    return { id: f.id, name: f.name, description: f.description, requirements: reqs.length, endpoints: rel.endpoints.length, pages: rel.routes.length };
  });
}

// ---------------------------------------------------------------- scope the PRD

export async function scopePrd(runId: string, featureIds: string[]) {
  const dir = path.join(RUNS_DIR, runId);
  const full = await readFullPrd(runId);
  const original = (await readJson(path.join(dir, 'prd.full.json'))) ? null : await readJson(path.join(dir, 'prd.json'));
  if (original) await writeAtomic(path.join(dir, 'prd.full.json'), original);
  const chosen = new Set(featureIds);
  const features = full.features.filter((f) => chosen.has(f.id));
  if (features.length === 0) throw new Error('No feature selected');
  const requirements = full.requirements.filter((r) => chosen.has(r.featureId));
  const rel = relatedTo(full, requirements);
  const scoped = Prd.parse({ ...full, features, requirements, apiEndpoints: rel.endpoints, uiRoutes: rel.routes });
  await writeAtomic(path.join(dir, 'prd.json'), scoped);
  return { features: features.length, requirements: requirements.length, endpoints: rel.endpoints.length, pages: rel.routes.length };
}

// ---------------------------------------------------------------- cap the test cases

const PRIORITY = { high: 0, medium: 1, low: 2 } as const;
const CATEGORY = ['functional', 'error-handling', 'auth', 'boundary', 'e2e-journey'];

/** Keeps at most `cap` cases: one per requirement first (high priority first), then the rest in the same order. */
export async function capCases(runId: string, cap: number) {
  const dir = path.join(RUNS_DIR, runId);
  const prd = Prd.parse(await readJson(path.join(dir, 'prd.json')));
  const source = (await readJson(path.join(dir, 'testcases.full.json'))) ?? (await readJson(path.join(dir, 'testcases.json')));
  if (!source) throw new Error('testcases.json not found: the test case stage is not done');
  const full = TestCases.parse(source);
  if (!(await readJson(path.join(dir, 'testcases.full.json')))) await writeAtomic(path.join(dir, 'testcases.full.json'), source);

  const priorityOf = new Map(prd.requirements.map((r) => [r.id, PRIORITY[r.priority as keyof typeof PRIORITY] ?? 1]));
  const rank = (c: TestCases['testCases'][number]) => [priorityOf.get(c.requirementIds[0]!) ?? 1, Math.max(0, CATEGORY.indexOf(c.category)), c.id] as const;
  const cmp = (a: TestCases['testCases'][number], b: TestCases['testCases'][number]) => {
    const [pa, ca, ia] = rank(a), [pb, cb, ib] = rank(b);
    return pa - pb || ca - cb || ia.localeCompare(ib, undefined, { numeric: true });
  };
  const sorted = [...full.testCases].sort(cmp);
  const kept = new Map<string, TestCases['testCases'][number]>();
  const seen = new Set<string>();
  for (const c of sorted) {
    const req = c.requirementIds[0]!;
    if (kept.size < cap && !seen.has(req)) { seen.add(req); kept.set(c.id, c); }
  }
  for (const c of sorted) if (kept.size < cap && !kept.has(c.id)) kept.set(c.id, c);
  const testCases = [...kept.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

  const covered = new Set(testCases.flatMap((c) => c.requirementIds));
  const uncovered = prd.requirements.filter((r) => !covered.has(r.id)).map((r) => {
    const earlier = full.coverage.uncovered.find((u) => u.requirementId === r.id);
    return earlier ?? { requirementId: r.id, reasonKind: 'other' as const, reason: `Left out by the demo cap of ${cap} test cases` };
  });
  const result = TestCases.parse({
    ...full,
    testCases,
    // The page-coverage block described all cases; it is left out rather than shown wrong.
    coverage: {
      requirementsTotal: prd.requirements.length,
      requirementsCovered: prd.requirements.length - uncovered.length,
      uncovered,
      partial: full.coverage.partial.filter((p) => covered.has(p.requirementId)),
    },
  });
  await writeAtomic(path.join(dir, 'testcases.json'), result);
  return { before: full.testCases.length, after: testCases.length, requirementsCovered: result.coverage.requirementsCovered, requirementsTotal: result.coverage.requirementsTotal };
}

// ---------------------------------------------------------------- the steps of a demo run

export interface Step {
  label: string;
  argv?: string[];
  run?: () => Promise<void>;
  /** Called when the step starts and when it ends well (the demo record keeps the times). */
  before?: () => Promise<void>;
  after?: () => Promise<void>;
}

export class DemoError extends Error {}

async function nextExecNumber(runId: string): Promise<number> {
  const run = (await readJson(path.join(RUNS_DIR, runId, 'run.json'))) as { executions?: Array<{ execId: string }> };
  const used = [...(await readdir(path.join(RUNS_DIR, runId, 'executions')).catch(() => [] as string[])), ...(run.executions ?? []).map((e) => e.execId)];
  const nums = used.map((id) => /^x-(\d+)$/.exec(id)?.[1]).filter((n): n is string => n !== undefined).map(Number);
  return Math.max(0, ...nums) + 1;
}

async function stamp(runId: string, name: string, phase: 'start' | 'end', detail?: Record<string, unknown>) {
  const demo = (await readDemo(runId))!;
  const now = new Date().toISOString();
  const prev = demo.steps[name];
  demo.steps[name] = phase === 'start' ? { startedAt: now } : { startedAt: prev?.startedAt ?? now, finishedAt: now, ...(detail ? { detail } : {}) };
  await writeDemo(runId, demo);
}

async function coverageDetail(runId: string): Promise<Record<string, unknown>> {
  const c = (await readJson(path.join(RUNS_DIR, runId, 'coverage', 'coverage.json'))) as { endpoints?: Array<{ reached: boolean }>; scripts?: { run: number } } | null;
  const list = c?.endpoints ?? [];
  return { reached: list.filter((e) => e.reached).length, total: list.length, scripts: c?.scripts?.run ?? 0 };
}

/** Checks a selection against the PRD and saves it. */
export async function saveSelection(runId: string, input: Partial<DemoSelection> & { confirm?: boolean }): Promise<DemoSelection> {
  const demo = await readDemo(runId);
  if (!demo) throw new DemoError('This is not a demo run');
  const prd = await readFullPrd(runId);
  const ids = [...new Set(input.featureIds ?? [])];
  if (ids.length === 0 || ids.some((id) => !prd.features.some((f) => f.id === id))) throw new DemoError('Tick at least one feature from the list');
  const cap = Number.isInteger(input.cap) ? (input.cap as number) : DEFAULT_CAP;
  if (cap < 3 || cap > 250) throw new DemoError('The cap must be between 3 and 250 test cases');
  const buggy = input.buggy ?? null;
  if (buggy) {
    if (input.confirm !== true) throw new DemoError('Running a buggy version needs confirmation');
    if (!(await resolveVariantPatch(demo.target, buggy))) throw new DemoError('Unknown variant');
  }
  const selection: DemoSelection = { featureIds: ids, cap, buggy, analyze: input.analyze !== false };
  demo.selection = selection;
  await writeDemo(runId, demo);
  return selection;
}

/**
 * What is left to do for a demo run, from the files: stages already done are skipped, so the same call serves the
 * first start and every Continue. A demo run that has not finished the requirements stage cannot continue (the
 * `prd` command always makes a new run).
 */
export async function planDemo(runId: string): Promise<Step[]> {
  const dir = path.join(RUNS_DIR, runId);
  const run = (await readJson(path.join(dir, 'run.json'))) as { target: string; stages: Record<string, { status: string }>; executions?: Array<{ execId: string; patch?: string; executeStatus: string; analyzeStatus: string }> } | null;
  const demo = await readDemo(runId);
  if (!run || !demo) throw new DemoError('This is not a demo run');
  if (run.stages.prd?.status !== 'done') throw new DemoError('The requirements stage did not finish. Start a new demo run.');
  const sel = demo.selection;
  if (!sel) throw new DemoError('Choose the features first');
  const done = (name: string) => Boolean(demo.steps[name]?.finishedAt);
  const timed = (name: string, step: Step): Step => ({
    ...step,
    before: async () => { await stamp(runId, name, 'start'); },
    after: async () => { await stamp(runId, name, 'end', name === 'coverage' ? await coverageDetail(runId) : undefined); },
  });
  const steps: Step[] = [];
  if (!done('scope')) steps.push(timed('scope', { label: 'Limit the requirements to the chosen features', run: async () => { await scopePrd(runId, sel.featureIds); } }));
  if (run.stages.cases?.status !== 'done') steps.push(timed('cases', { label: 'Test cases', argv: ['agent', 'cases', '--run', runId] }));
  if (!done('cap')) steps.push(timed('cap', { label: `Keep at most ${sel.cap} test cases`, run: async () => { await capCases(runId, sel.cap); } }));
  if (run.stages.scripts?.status !== 'done') steps.push(timed('scripts', { label: 'Scripts', argv: ['agent', 'scripts', '--run', runId] }));
  if (!done('coverage')) steps.push(timed('coverage', { label: 'Coverage (measured)', argv: ['agent', 'gaps', '--run', runId, '--measure-only'] }));

  // executions: golden first, then the one buggy version, each analysed afterwards when asked
  let n = await nextExecNumber(runId);
  const exec = (version: string, patchRel: string | null) => {
    let id = demo.executions[version];
    const existing = id ? run.executions?.find((e) => e.execId === id) : undefined;
    if (!existing || existing.executeStatus !== 'done') {
      if (!id || existing) id = `x-${String(n++).padStart(2, '0')}`;
      const execId = id;
      demo.executions[version] = execId;
      steps.push({
        label: `Execute ${version === 'golden' ? 'the correct version' : version}`,
        argv: ['agent', 'execute', '--run', runId, '--exec-id', execId, ...(patchRel ? ['--patch', patchRel] : [])],
        before: async () => { const d = (await readDemo(runId))!; d.executions[version] = execId; await writeDemo(runId, d); await stamp(runId, version === 'golden' ? 'golden' : 'buggy', 'start'); },
        after: async () => { await stamp(runId, version === 'golden' ? 'golden' : 'buggy', 'end'); },
      });
    }
    if (sel.analyze && (!existing || existing.analyzeStatus !== 'done')) {
      steps.push(timed(`analyze:${version}`, { label: `Diagnose ${version === 'golden' ? 'the correct version' : version}`, argv: ['agent', 'analyze', '--run', runId, '--exec', demo.executions[version]!] }));
    }
  };
  exec('golden', null);
  if (sel.buggy) {
    const patchRel = await resolveVariantPatch(run.target, sel.buggy);
    if (!patchRel) throw new DemoError('Unknown variant');
    exec(sel.buggy.slice(sel.buggy.lastIndexOf(':') + 1), patchRel);
  }
  return steps;
}
