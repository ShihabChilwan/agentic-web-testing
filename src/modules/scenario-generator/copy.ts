import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readRunManifest, writeRunManifest } from '../../shared/run-manifest.js';
import type { RunExecution, RunManifest } from '../../shared/schemas.js';

/** Where the suite's own recordings of the correct version are kept in a scenario run (one file per execution). */
export const SUITE_RECORDINGS = path.join('scenarios', 'suite-recordings');

/** An execution of the correct version as generated: the generation ref, no patch, no override, no skipped seed, the run's own scripts. */
export function isGenerationExecution(e: RunExecution, manifest: Pick<RunManifest, 'generationRef'>): boolean {
  return e.ref === manifest.generationRef && !e.patch && !e.configOverride && !e.skipSeed && !e.scriptsDir && e.executeStatus === 'done';
}

const exists = (p: string) => stat(p).then(() => true, () => false);

/**
 * `agent scenarios --from <run>` (SPEC §6.5): a new run folder `<run>-scn` with only what generation needs: run.json
 * without executions, prd.json, testcases.json, scripts/, pages/, coverage/coverage.json, and the recorded responses of
 * executions of the correct version (as scenarios/suite-recordings/<x>.responses.jsonl). Executions of other versions,
 * comparisons, noise files, analyses and evaluation folders are never copied, so nothing about a planted bug can reach
 * the scenario generator. Returns the new folder's name.
 */
export async function copyForScenarios(runsDir: string, fromFolder: string): Promise<{ folder: string; recordings: string[] }> {
  const from = path.join(runsDir, fromFolder);
  const folder = `${fromFolder}-scn`;
  const to = path.join(runsDir, folder);
  if (await exists(to)) throw new Error(`${to} exists; use --run ${folder} to work in it, or remove it first`);
  const manifest = await readRunManifest(path.join(from, 'run.json'));
  if (manifest.stages.scripts?.status !== 'done') throw new Error(`The scripts stage of ${fromFolder} is not done`);
  await mkdir(to, { recursive: true });
  await writeRunManifest(path.join(to, 'run.json'), { ...manifest, executions: [] });
  for (const name of ['prd.json', 'testcases.json']) await cp(path.join(from, name), path.join(to, name));
  await cp(path.join(from, 'scripts'), path.join(to, 'scripts'), { recursive: true });
  if (await exists(path.join(from, 'pages'))) await cp(path.join(from, 'pages'), path.join(to, 'pages'), { recursive: true });
  if (await exists(path.join(from, 'coverage', 'coverage.json'))) {
    await mkdir(path.join(to, 'coverage'), { recursive: true });
    await cp(path.join(from, 'coverage', 'coverage.json'), path.join(to, 'coverage', 'coverage.json'));
  }
  const recordings: string[] = [];
  await mkdir(path.join(to, SUITE_RECORDINGS), { recursive: true });
  for (const e of manifest.executions.filter((x) => isGenerationExecution(x, manifest))) {
    const file = path.join(from, 'executions', e.execId, 'responses.jsonl');
    if (!(await exists(file))) continue;
    await writeFile(path.join(to, SUITE_RECORDINGS, `${e.execId}.responses.jsonl`), await readFile(file));
    recordings.push(e.execId);
  }
  return { folder, recordings };
}
