import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DryRunQueue, filesThatFailedToLoad, Mutex, playwrightBatch, writePlaywrightConfig } from '../../src/modules/script-generator/dry-run.js';
import type { DryRunItem, DryRunResult } from '../../src/modules/script-generator/dry-run.js';
import { PROJECT_ROOT } from '../../src/shared/paths.js';
import { TargetConfig } from '../../src/shared/schemas.js';
import { example } from '../shared/schemas/helpers.js';

const passed: DryRunResult = { status: 'passed', message: '', durationMs: 1 };
const item = (id: string): DryRunItem => ({ testId: id, file: `${id}.spec.ts`, outputDir: `out/${id}` });

describe('DryRunQueue', () => {
  it('starts at once, then puts whatever waited into the next batch, up to the limit', async () => {
    const seen: string[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const queue = new DryRunQueue(new Mutex(), async (items) => {
      seen.push(items.map((i) => i.testId));
      if (seen.length === 1) await gate; // the first batch is still running while the others arrive
      return items.map(() => passed);
    }, 3);
    const first = queue.run(item('TC-001'));
    await new Promise((r) => setTimeout(r, 0)); // the first batch has started
    const rest = ['TC-002', 'TC-003', 'TC-004', 'TC-005'].map((id) => queue.run(item(id)));
    release();
    const results = await Promise.all([first, ...rest]);
    expect(seen).toEqual([['TC-001'], ['TC-002', 'TC-003', 'TC-004'], ['TC-005']]);
    expect(queue.batches).toEqual([1, 3, 1]);
    expect(results.every((r) => r.result.status === 'passed' && r.waitedMs >= 0)).toBe(true);
  });

  it('a batch that throws rejects its own dry runs only; the queue goes on', async () => {
    let calls = 0;
    const queue = new DryRunQueue(new Mutex(), async (items) => {
      if (++calls === 1) throw new Error('Interrupted');
      return items.map(() => passed);
    });
    await expect(queue.run(item('TC-001'))).rejects.toThrow('Interrupted');
    await expect(queue.run(item('TC-002'))).resolves.toMatchObject({ result: { status: 'passed' } });
  });

  it('shares the mutex with other work (page snapshots): a batch waits for it', async () => {
    const mutex = new Mutex();
    const order: string[] = [];
    const snapshot = mutex.run(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('snapshot');
    });
    const queue = new DryRunQueue(mutex, async (items) => {
      order.push('batch');
      return items.map(() => passed);
    });
    await Promise.all([snapshot, queue.run(item('TC-001'))]);
    expect(order).toEqual(['snapshot', 'batch']);
  });
});

describe('filesThatFailedToLoad', () => {
  it('names the file of a top-level load error in a recorded Playwright 1.64.0 report', () => {
    const report = JSON.parse(readFileSync(new URL('../fixtures/playwright-json-report/load-error-1.64.0.json', import.meta.url), 'utf8'));
    expect(report.suites).toEqual([]); // no test ran, not even the file that loads
    expect([...filesThatFailedToLoad(report)]).toEqual(['TC-003.spec.ts']);
    expect(filesThatFailedToLoad({})).toEqual(new Set());
  });
});

// Real Playwright: three scripts in one batch, one of which fails to load.
const script = (id: string, body: string, top = '') => `// ${id}: case ${id}
import { expect, test } from './_helpers.js';
${top}
test('${id}: case ${id}', async () => {
${body}
});
`;

let runDir: string;
beforeAll(async () => {
  await mkdir(path.join(PROJECT_ROOT, 'runs'), { recursive: true });
  runDir = await mkdtemp(path.join(PROJECT_ROOT, 'runs', '.batch-test-'));
  const scripts = path.join(runDir, 'scripts');
  await mkdir(scripts, { recursive: true });
  await copyFile(path.join(PROJECT_ROOT, 'src/modules/script-generator/template/_helpers.ts'), path.join(scripts, '_helpers.ts'));
  await writeFile(path.join(scripts, '_target.json'), JSON.stringify({ apiUrl: 'http://127.0.0.1:9', uiUrl: 'http://127.0.0.1:9', fixtures: { users: {} } }));
  await writeFile(path.join(scripts, 'TC-001.spec.ts'), script('TC-001', "  expect(1 + 1, 'E1').toBe(2);"));
  await writeFile(path.join(scripts, 'TC-002.spec.ts'), script('TC-002', "  expect(1 + 1, 'E1').toBe(3);"));
  await writeFile(path.join(scripts, 'TC-003.spec.ts'), script('TC-003', "  expect(true, 'E1').toBe(true);", "throw new Error('broken at load');"));
  await writePlaywrightConfig(runDir, 'http://127.0.0.1:9');
});
afterAll(async () => {
  await rm(runDir, { recursive: true, force: true });
});

describe('playwrightBatch (real Playwright)', () => {
  it('runs the scripts in one process with the check after each, moves each output, and runs a script that failed to load on its own', { timeout: 180_000 }, async () => {
    const config = TargetConfig.parse(example('target.config.json'));
    const runs: string[][] = [];
    const run = playwrightBatch({ runDir, scriptsDir: path.join(runDir, 'scripts'), config, onRun: (ids) => runs.push(ids) });
    const items = ['TC-001', 'TC-002', 'TC-003'].map((id) => ({ testId: id, file: path.join(runDir, 'scripts', `${id}.spec.ts`), outputDir: path.join(runDir, 'dry-runs', id, 'attempt-1') }));
    const after: string[] = [];
    const results = await run(items, async (i) => void after.push(i.testId));

    expect(results.map((r) => r.status)).toEqual(['passed', 'failed', 'error']);
    // The load error stopped the first run; TC-001 and TC-002 ran again as a smaller batch, TC-003 on its own.
    expect(runs).toEqual([['TC-001', 'TC-002', 'TC-003'], ['TC-001', 'TC-002']]);
    expect(results[1]!.message).toMatch(/^Error: E1/);
    expect(results[2]!.message).toContain('broken at load');
    // The check and restore ran once after every script, in order (the load failure after its run on its own).
    expect(after).toEqual(['TC-001', 'TC-002', 'TC-003']);
    // Each failing test's output is in its own attempt folder; the batch folder is gone.
    const attempt = path.join(runDir, 'dry-runs', 'TC-002', 'attempt-1');
    const [testDir] = (await readdir(attempt)).filter((n) => !n.startsWith('.'));
    expect(await readdir(path.join(attempt, testDir!))).toContain('error-context.md');
    expect((await readdir(path.join(runDir, 'dry-runs'))).filter((n) => n.startsWith('.batch'))).toEqual([]);
  });
});
