import { execFile } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { makeRunId, RUNS_DIR, runPaths } from '../../shared/paths.js';
import { readRunManifest, setExecution, writeRunManifest } from '../../shared/run-manifest.js';
import { CloudTaskStatus, EvalMapping } from '../../shared/schemas.js';
import { findLeaks } from './leaks.js';
import { suiteHash } from './suite.js';

const execFileAsync = promisify(execFile);

export interface ImportRepeatOptions {
  /** One repeat's results folder: <from>/<version>/status.json and execution.tar.gz. */
  from: string;
  runsDir?: string;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface ImportRepeatResult {
  runId: string;
  mapping: EvalMapping;
}

/**
 * `eval import` (SPEC §11.7): turns one repeat's task results into a new local run: the source run's
 * generation files, one execution per version under its opaque id (run.json entries ready for
 * `agent analyze`), and eval/mapping.json. Refuses a suite that differs from the source run's and any
 * execution whose readable files name a version or patch.
 */
export async function importRepeat(options: ImportRepeatOptions): Promise<ImportRepeatResult> {
  const runsDir = options.runsDir ?? RUNS_DIR;
  const log = options.log ?? (() => {});
  const statuses: CloudTaskStatus[] = [];
  for (const name of (await readdir(options.from, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const file = path.join(options.from, name, 'status.json');
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text === null) throw new Error(`${file} is missing: the task for ${name} did not finish writing its results`);
    const status = CloudTaskStatus.parse(JSON.parse(text));
    if (status.version !== name) throw new Error(`${file} is for ${status.version}, not ${name}`);
    statuses.push(status);
  }
  if (statuses.length === 0) throw new Error(`No task results in ${options.from}`);
  const first = statuses[0]!;
  for (const s of statuses) {
    for (const key of ['repeatId', 'sourceRunId', 'suiteHash', 'imageTag'] as const) {
      if (s[key] !== first[key]) throw new Error(`Results mix ${key}s: ${first[key]} (${first.version}) and ${s[key]} (${s.version})`);
    }
  }
  const execIds = statuses.flatMap((s) => (s.execId === null ? [] : [s.execId]));
  if (new Set(execIds).size !== execIds.length) throw new Error(`Two versions share an execution id: ${execIds.join(', ')}`);

  const source = runPaths(first.sourceRunId, runsDir);
  const sourceHash = await suiteHash(source.dir);
  if (sourceHash !== first.suiteHash) {
    throw new Error(`The suite of ${first.sourceRunId} changed since the image was built (${sourceHash.slice(0, 12)} vs ${first.suiteHash.slice(0, 12)}); rebuild the image`);
  }
  const manifest = await readRunManifest(source.runJson);

  const runId = makeRunId(manifest.target, (options.now ?? (() => new Date()))());
  const paths = runPaths(runId, runsDir);
  if (await stat(paths.dir).then(() => true, () => false)) throw new Error(`${paths.dir} exists; import again in a second`);
  await mkdir(paths.dir, { recursive: true });
  try {
    await writeRunManifest(paths.runJson, { ...manifest, runId, executions: [] });
    for (const name of ['prd.json', 'testcases.json']) await cp(path.join(source.dir, name), path.join(paths.dir, name));
    await cp(source.scriptsDir, paths.scriptsDir, { recursive: true });

    for (const s of statuses) {
      if (s.execId === null) {
        log(`${s.version}: failed before it ran, no execution (${s.error ?? 'no error recorded'})`);
        continue;
      }
      const execId = s.execId;
      const tarball = path.join(options.from, s.version, 'execution.tar.gz');
      if (await stat(tarball).then(() => true, () => false)) {
        await mkdir(path.join(paths.dir, 'executions'), { recursive: true });
        await execFileAsync('tar', ['-xzf', tarball, '-C', path.join(paths.dir, 'executions')]);
        const leaks = await findLeaks(paths.executionDir(execId));
        if (leaks.length > 0) {
          throw new Error(`${execId} would show the analyzer what it ran: ${leaks.map((l) => `${l.file}:${l.line} "${l.match}"`).join('; ')}`);
        }
      }
      await setExecution(paths.dir, {
        execId,
        ...s.execution,
        commit: s.execution.commit ?? manifest.generationCommit,
        executeStatus: s.outcome === 'done' ? 'done' : 'failed',
        analyzeStatus: 'pending',
        ...(s.error ? { error: s.error } : {}),
      });
      log(`${execId}: ${s.outcome}${s.error ? ` (${s.error})` : ''}`);
    }

    const mapping = EvalMapping.parse({
      schemaVersion: '1.0',
      repeatId: first.repeatId,
      sourceRunId: first.sourceRunId,
      imageTag: first.imageTag,
      suiteHash: first.suiteHash,
      importedAt: new Date().toISOString(),
      versions: statuses.map((s) => ({ version: s.version, execId: s.execId, outcome: s.outcome, durationMs: s.durationMs, peakMemoryBytes: s.memory.peakBytes })),
    });
    await mkdir(paths.evalDir, { recursive: true });
    await writeFile(path.join(paths.evalDir, 'mapping.json'), `${JSON.stringify(mapping, null, 2)}\n`);
    return { runId, mapping };
  } catch (err) {
    await rm(paths.dir, { recursive: true, force: true });
    throw err;
  }
}
