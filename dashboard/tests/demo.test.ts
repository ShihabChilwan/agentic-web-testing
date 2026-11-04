import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// A recorded real run (PRD with 16 features, 134 test cases). The tests skip when the run folder is not there.
const REAL = path.resolve(import.meta.dirname, '../../runs/mern-ecommerce-20261104-143721');
const have = existsSync(path.join(REAL, 'prd.json')) && existsSync(path.join(REAL, 'testcases.json'));

let root: string;
let demo: typeof import('../demo.js');
const RUN = 'demo-test-run';

beforeAll(async () => {
  if (!have) return;
  root = await mkdtemp(path.join(tmpdir(), 'dash-demo-'));
  process.env.DASHBOARD_RUNS_DIR = root;
  await mkdir(path.join(root, RUN), { recursive: true });
  for (const f of ['prd.json', 'testcases.json']) await cp(path.join(REAL, f), path.join(root, RUN, f));
  await writeFile(path.join(root, RUN, 'run.json'), JSON.stringify({ target: 'mern-ecommerce', createdAt: '2026-11-01T00:00:00Z', stages: { prd: { status: 'done' }, cases: { status: 'done' } }, executions: [] }));
  demo = await import('../demo.js');
  await demo.markDemo(RUN, 'mern-ecommerce');
});
afterAll(() => root ? rm(root, { recursive: true, force: true }) : undefined);

describe.skipIf(!have)('demo mode on a recorded run', () => {
  it('marks the run demo-only and lists features with their counts', async () => {
    expect(existsSync(path.join(root, RUN, 'DEMO-ONLY.txt'))).toBe(true);
    const o = await demo.featureOverview(RUN);
    expect(o.length).toBe(16);
    expect(o.filter((f) => f.requirements > 0).length).toBeGreaterThan(10);
    console.log(o.map((f) => `${f.name}: ${f.requirements} req, ${f.endpoints} endpoints, ${f.pages} pages`).join('\n'));
  });

  it('scopes the PRD to the ticked features, keeps the full PRD, and the result passes the schema', async () => {
    const full = JSON.parse(await readFile(path.join(root, RUN, 'prd.json'), 'utf8'));
    const ids = full.features.filter((f: { name: string }) => ['Contact and newsletter', 'Cart and checkout', 'Brand management'].includes(f.name)).map((f: { id: string }) => f.id);
    expect(ids).toHaveLength(3);
    const r = await demo.scopePrd(RUN, ids);
    const scoped = JSON.parse(await readFile(path.join(root, RUN, 'prd.json'), 'utf8'));
    expect(scoped.features).toHaveLength(3);
    expect(scoped.requirements.every((q: { featureId: string }) => ids.includes(q.featureId))).toBe(true);
    expect(scoped.requirements.length).toBe(r.requirements);
    expect(existsSync(path.join(root, RUN, 'prd.full.json'))).toBe(true);
    console.log('scoped', r);
    // a second call starts again from the full PRD, not from the scoped one
    await demo.scopePrd(RUN, ids.slice(0, 1));
    expect(JSON.parse(await readFile(path.join(root, RUN, 'prd.json'), 'utf8')).features).toHaveLength(1);
    await demo.scopePrd(RUN, ids);
  });

  it('caps the cases, one per requirement first, with a coverage block that matches', async () => {
    // the recorded cases belong to the full PRD, so the cap here works on the 3 scoped features' cases only
    const prd = JSON.parse(await readFile(path.join(root, RUN, 'prd.json'), 'utf8'));
    const reqIds = new Set(prd.requirements.map((q: { id: string }) => q.id));
    const all = JSON.parse(await readFile(path.join(root, RUN, 'testcases.json'), 'utf8'));
    all.testCases = all.testCases.filter((c: { requirementIds: string[] }) => c.requirementIds.every((id) => reqIds.has(id)));
    await writeFile(path.join(root, RUN, 'testcases.json'), JSON.stringify(all));
    const r = await demo.capCases(RUN, 12);
    const out = JSON.parse(await readFile(path.join(root, RUN, 'testcases.json'), 'utf8'));
    expect(out.testCases.length).toBeLessThanOrEqual(12);
    expect(out.testCases.length).toBe(r.after);
    expect(out.coverage.requirementsTotal).toBe(prd.requirements.length);
    const covered = new Set(out.testCases.flatMap((c: { requirementIds: string[] }) => c.requirementIds));
    expect(out.coverage.requirementsCovered).toBe(covered.size);
    expect(out.coverage.uncovered.length).toBe(prd.requirements.length - covered.size);
    expect(existsSync(path.join(root, RUN, 'testcases.full.json'))).toBe(true);
    // with room for every requirement, each gets a case
    await demo.capCases(RUN, 40);
    const wide = JSON.parse(await readFile(path.join(root, RUN, 'testcases.json'), 'utf8'));
    expect(wide.coverage.requirementsCovered).toBeGreaterThanOrEqual(Math.min(prd.requirements.length, wide.testCases.length));
    expect(await readdir(path.join(root, RUN))).toContain('prd.full.json');
  });

  it('refuses a selection without features, a bad cap, and a buggy version without confirmation', async () => {
    await expect(demo.saveSelection(RUN, { featureIds: [] })).rejects.toThrow(/Tick at least one/);
    await expect(demo.saveSelection(RUN, { featureIds: ['F-01'], cap: 1 })).rejects.toThrow(/between 3 and 250/);
    await expect(demo.saveSelection(RUN, { featureIds: ['F-01'], buggy: 'draw:bug-012' })).rejects.toThrow(/confirmation/);
  });

  it('plans the steps in order and skips what is done', async () => {
    await demo.saveSelection(RUN, { featureIds: ['F-01'], cap: 20, analyze: true });
    const steps = await demo.planDemo(RUN);
    expect(steps.map((s) => s.label)).toEqual([
      'Limit the requirements to the chosen features', 'Keep at most 20 test cases', 'Scripts', 'Coverage (measured)', 'Execute the correct version', 'Diagnose the correct version',
    ]);
    expect(steps.find((s) => s.label === 'Coverage (measured)')?.argv).toEqual(['agent', 'gaps', '--run', RUN, '--measure-only']);
    expect(steps.find((s) => s.label === 'Execute the correct version')?.argv).toEqual(['agent', 'execute', '--run', RUN, '--exec-id', 'x-01']);
  });
});
