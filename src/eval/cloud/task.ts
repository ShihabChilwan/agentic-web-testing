import { execFile } from 'node:child_process';
import { copyFile, cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { executeRun } from '../../modules/execution-engine/index.js';
import { PROJECT_ROOT, RUNS_DIR, runPaths } from '../../shared/paths.js';
import { readRunManifest, errorSummary } from '../../shared/run-manifest.js';
import { CloudBuild, CloudTaskStatus } from '../../shared/schemas.js';
import { taskVersion } from './versions.js';

const execFileAsync = promisify(execFile);

/** Where the image keeps its build.json and the suite's run folder (SPEC §11.7). */
export const IMAGE_DIR = path.join(PROJECT_ROOT, 'image');

export interface CloudTaskOptions {
  /** The bucket mount (or a local bind mount): results go to <resultsDir>/<repeat>/<version>/. */
  resultsDir: string;
  imageDir?: string;
  runsDir?: string;
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  /** Logs of services started before the task (e.g. the database), copied next to status.json. */
  serviceLogs?: string[];
  /** Folder holding the container's cgroup files (memory.peak, memory.max, memory.events). */
  cgroupDir?: string;
  /** Replaces executeRun (tests). */
  execute?: typeof executeRun;
  log?: (message: string) => void;
}

async function readNumber(file: string): Promise<number | null> {
  const text = await readFile(file, 'utf8').then((t) => t.trim(), () => null);
  return text !== null && /^\d+$/.test(text) ? Number(text) : null;
}

/** Peak and limit memory and OOM kills of the container, from cgroup v2; null where unreadable. */
export async function memoryUsage(cgroupDir: string): Promise<CloudTaskStatus['memory']> {
  const events = await readFile(path.join(cgroupDir, 'memory.events'), 'utf8').catch(() => null);
  const oom = events ? /^oom_kill (\d+)$/m.exec(events) : null;
  return {
    peakBytes: await readNumber(path.join(cgroupDir, 'memory.peak')),
    limitBytes: await readNumber(path.join(cgroupDir, 'memory.max')),
    oomKills: oom ? Number(oom[1]) : null,
  };
}

/**
 * `eval cloud-task` (SPEC §11.7): one Cloud Run task = one version. Looks the version up from
 * CLOUD_RUN_TASK_INDEX, runs it with the Execution Engine under its opaque id, and writes
 * execution.tar.gz and status.json to <resultsDir>/<repeat>/<version>/. Returns the exit code:
 * 0 when the execution finished (failing tests are a result), 1 when it could not run.
 */
export async function runCloudTask(options: CloudTaskOptions): Promise<number> {
  const imageDir = options.imageDir ?? IMAGE_DIR;
  const runsDir = options.runsDir ?? RUNS_DIR;
  const log = options.log ?? ((m: string) => console.log(m));
  const build = CloudBuild.parse(JSON.parse(await readFile(path.join(imageDir, 'build.json'), 'utf8')));
  const { index, repeatId, version, execId } = taskVersion(build, options.env ?? process.env);
  const outDir = path.join(options.resultsDir, repeatId, version.version);
  if (await stat(path.join(outDir, 'status.json')).then(() => true, () => false)) {
    throw new Error(`${outDir}/status.json exists: this version already ran in repeat ${repeatId}`);
  }
  log(`Task ${index}: ${version.version} as ${execId}, repeat ${repeatId}, image ${build.imageTag}`);

  const paths = runPaths(build.sourceRunId, runsDir);
  if (!(await stat(paths.runJson).then(() => true, () => false))) await cp(path.join(imageDir, 'run'), paths.dir, { recursive: true });

  const startedAt = new Date();
  let error: string | undefined;
  try {
    await (options.execute ?? executeRun)({
      runId: build.sourceRunId,
      ref: build.generationRef,
      ...(version.patch ? { patch: path.join(options.projectRoot ?? PROJECT_ROOT, version.patch) } : {}),
      ...(version.configOverride ? { configOverride: version.configOverride } : {}),
      ...(version.skipSeed ? { skipSeed: true } : {}),
      execId,
      runsDir,
      ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
      log,
    });
  } catch (err) {
    error = errorSummary(err);
    log(`Execution failed: ${error}`);
  }
  const finishedAt = new Date();

  await mkdir(outDir, { recursive: true });
  const execDir = paths.executionDir(execId);
  if (await stat(execDir).then(() => true, () => false)) {
    await execFileAsync('tar', ['-czf', path.join(outDir, 'execution.tar.gz'), '-C', path.dirname(execDir), execId]);
  }
  for (const file of options.serviceLogs ?? []) await copyFile(file, path.join(outDir, path.basename(file))).catch(() => {});

  const entry = (await readRunManifest(paths.runJson).catch(() => null))?.executions.find((e) => e.execId === execId);
  const status = CloudTaskStatus.parse({
    schemaVersion: '1.0',
    repeatId,
    taskIndex: index,
    version: version.version,
    execId,
    imageTag: build.imageTag,
    sourceRunId: build.sourceRunId,
    suiteHash: build.suiteHash,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    outcome: error === undefined ? 'done' : 'failed',
    ...(error !== undefined ? { error } : {}),
    execution: {
      ref: build.generationRef,
      ...(entry?.commit ? { commit: entry.commit } : {}),
      ...(version.patch ? { patch: version.patch } : {}),
      ...(version.configOverride ? { configOverride: version.configOverride } : {}),
      ...(version.skipSeed ? { skipSeed: true } : {}),
    },
    memory: await memoryUsage(options.cgroupDir ?? '/sys/fs/cgroup'),
  });
  await writeFile(path.join(outDir, 'status.json'), `${JSON.stringify(status, null, 2)}\n`);
  const mib = (b: number | null) => (b === null ? 'unknown' : `${Math.round(b / 1024 / 1024)} MiB`);
  log(`${status.outcome} in ${Math.round(status.durationMs / 1000)} s; peak memory ${mib(status.memory.peakBytes)} of ${mib(status.memory.limitBytes)}, OOM kills ${status.memory.oomKills ?? 'unknown'}; results in ${outDir}`);
  return status.outcome === 'done' ? 0 : 1;
}
