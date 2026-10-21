import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RUNS_DIR, runPaths } from '../../shared/paths.js';
import { latestRunWith } from '../../shared/run-manifest.js';
import { renderReport } from './html.js';
import { buildRunView } from './view-model.js';

export { buildRunView, callsInWindow, executionLabel } from './view-model.js';
export { allComparisons, compareTests } from './compare.js';
export { renderReport } from './html.js';

/** `agent report` (SPEC §9.2): builds the run's view model and writes runs/<runId>/report.html. Reads files only. */
export async function writeReport(options: { runId?: string; runsDir?: string } = {}): Promise<{ file: string; bytes: number }> {
  const runsDir = options.runsDir ?? RUNS_DIR;
  const runId = options.runId ?? (await latestRunWith('run.json', runsDir));
  if (!runId) throw new Error(`No run in ${runsDir}`);
  const paths = runPaths(runId, runsDir);
  const html = renderReport(await buildRunView(paths.dir));
  const file = path.join(paths.dir, 'report.html');
  await writeFile(file, html, 'utf8');
  return { file, bytes: Buffer.byteLength(html) };
}
