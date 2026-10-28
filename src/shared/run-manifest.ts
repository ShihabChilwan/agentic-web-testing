import { access, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readCallLog, upstreamProvidersSeen } from '../llm/call-log.js';
import type { LLMConfig } from './config.js';
import { RUNS_DIR, makeRunId, runPaths } from './paths.js';
import { RunManifest, SCHEMA_VERSION } from './schemas.js';
import type { RunExecution, StageState } from './schemas.js';

export type StageName = keyof RunManifest['stages'];

/** The LLM settings recorded in run.json (never keys, headers or base URLs). */
export function llmSettings(config: LLMConfig): RunManifest['llm'] {
  return {
    provider: config.provider,
    models: { ...config.models, other: config.model },
    temperature: config.temperature,
    topP: config.topP,
    reasoningEffort: { ...config.reasoningEfforts, other: config.reasoningEffort },
    concurrency: config.concurrency,
  };
}

/** Validates and writes run.json via a temporary file, so a crash never leaves half a file. */
export async function writeRunManifest(file: string, manifest: RunManifest): Promise<void> {
  const valid = RunManifest.parse(manifest);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(valid, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

export async function readRunManifest(file: string): Promise<RunManifest> {
  return RunManifest.parse(JSON.parse(await readFile(file, 'utf8')));
}

export interface CreateRunInput {
  target: string;
  generationRef: string;
  generationCommit: string;
  llm: RunManifest['llm'];
  runsDir?: string;
  now?: Date;
}

/** Creates runs/<runId>/ with a fresh run.json. Fails if the folder already exists. */
export async function createRun(input: CreateRunInput) {
  const now = input.now ?? new Date();
  const runId = makeRunId(input.target, now);
  const paths = runPaths(runId, input.runsDir ?? RUNS_DIR);
  await mkdir(path.dirname(paths.dir), { recursive: true });
  try {
    await mkdir(paths.dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Run folder ${paths.dir} already exists; wait a second and try again`, { cause: err });
    }
    throw err;
  }
  const manifest: RunManifest = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    target: input.target,
    generationRef: input.generationRef,
    generationCommit: input.generationCommit,
    createdAt: now.toISOString(),
    llm: input.llm,
    stages: {},
    executions: [],
  };
  await writeRunManifest(paths.runJson, manifest);
  return { runId, paths, manifest };
}

/**
 * Updates one stage's state (fields not given are kept, e.g. startedAt) and refreshes `llm.upstreamProviders` from the run's call log.
 * Read, change and write happen in one step; stages run one after another, so there is no concurrent writer.
 */
export async function setStage(runDir: string, stage: StageName, state: StageState): Promise<RunManifest> {
  const paths = runPaths(path.basename(runDir), path.dirname(runDir));
  const manifest = await readRunManifest(paths.runJson);
  manifest.stages[stage] = { ...manifest.stages[stage], ...state };
  const providers = upstreamProvidersSeen((await readCallLog(paths.llmCalls)).lines);
  if (providers.length > 0) manifest.llm.upstreamProviders = providers;
  await writeRunManifest(paths.runJson, manifest);
  return manifest;
}

/** Adds or replaces one `executions[]` entry (by execId) in run.json. */
export async function setExecution(runDir: string, execution: RunExecution): Promise<RunManifest> {
  const paths = runPaths(path.basename(runDir), path.dirname(runDir));
  const manifest = await readRunManifest(paths.runJson);
  const index = manifest.executions.findIndex((e) => e.execId === execution.execId);
  if (index >= 0) manifest.executions[index] = execution;
  else manifest.executions.push(execution);
  await writeRunManifest(paths.runJson, manifest);
  return manifest;
}

/** `Name: message` for run.json, from any thrown value. */
export function errorSummary(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** The newest run (by run id, which ends in its UTC timestamp) whose folder contains `file`, or null. */
export async function latestRunWith(file: string, runsDir: string = RUNS_DIR): Promise<string | null> {
  const names = await readdir(runsDir).catch(() => [] as string[]);
  const runs = names
    .filter((n) => /-\d{8}-\d{6}$/.test(n))
    .sort((a, b) => a.slice(-15).localeCompare(b.slice(-15)) || a.localeCompare(b));
  for (const name of runs.reverse()) {
    const ok = await access(path.join(runsDir, name, file)).then(() => true, () => false);
    if (ok) return name;
  }
  return null;
}
