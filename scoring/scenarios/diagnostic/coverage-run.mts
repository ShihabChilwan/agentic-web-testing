// Diagnostic: backend V8 line coverage of one scripts folder of a run, on the generation version. Same steps as
// src/modules/execution-engine/coverage.ts measureCoverage, but with the request's scriptsDir (measureCoverage always
// runs scripts/). Uses only exported framework functions; changes nothing under src/.
// Usage: npx tsx scoring/scenarios/diagnostic/coverage-run.mts <target> <run dir> <scripts dir in the run> <out.json>
import { execFile } from 'node:child_process';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { loadTargetConfig } from '../../../src/shared/target-config.js';
import { readRunManifest } from '../../../src/shared/run-manifest.js';
import { executeVersion, sourceTreeFor } from '../../../src/modules/execution-engine/execute.js';
import { COVERAGE_PRELOAD, readV8Coverage } from '../../../src/modules/execution-engine/coverage.js';

const run = promisify(execFile);
const [target, runDirArg, scriptsDir, outFile] = process.argv.slice(2);
if (!target || !runDirArg || !scriptsDir || !outFile) throw new Error('usage: <target> <run dir> <scripts dir> <out.json>');
const runDir = path.resolve(runDirArg);
const { config, repoDir, targetDir } = await loadTargetConfig(target);
const manifest = await readRunManifest(path.join(runDir, 'run.json'));
const work = path.join(runDir, `coverage-${scriptsDir}`);
const rawDir = path.join(work, 'v8');
const preload = path.join(work, 'flush-on-signal.cjs');
const execId = `cov-${scriptsDir}`;
await rm(work, { recursive: true, force: true });
await mkdir(rawDir, { recursive: true });
await writeFile(preload, COVERAGE_PRELOAD, 'utf8');
const request = { execId, ref: manifest.generationRef, scriptsDir };
const { commit, tree } = await sourceTreeFor(config, repoDir, request);
const env = { NODE_V8_COVERAGE: rawDir, NODE_OPTIONS: `--require "${preload}"` };
const { results } = await executeVersion({
  runDir, config, repoDir, targetDir, generationRef: manifest.generationRef,
  request: { ...request, configOverride: { backend: { env } } }, sourceTree: tree, log: (m) => console.log(m),
});
await rename(path.join(runDir, 'executions', execId), path.join(work, 'execution'));
const source = (rel: string) => run('git', ['-C', repoDir, 'show', `${commit}:${rel}`], { maxBuffer: 64 * 1024 * 1024 }).then((r) => r.stdout, () => null);
const read = await readV8Coverage(rawDir, tree.dir, source);
await rm(rawDir, { recursive: true, force: true });
await writeFile(outFile, `${JSON.stringify({ target, run: path.basename(runDir), scriptsDir, commit, summary: results.summary, incidents: results.incidents, processes: read.processes, files: read.files })}\n`);
console.log(`${scriptsDir}: ${results.summary.passed}/${results.summary.total} passed, ${read.processes} processes, ${Object.keys(read.files).length} files -> ${outFile}`);
