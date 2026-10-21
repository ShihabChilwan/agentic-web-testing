import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { readCallLog } from '../llm/call-log.js';
import { RUNS_DIR, runPaths } from '../shared/paths.js';
import { errorSummary, latestRunWith, readRunManifest, setExecution, setStage } from '../shared/run-manifest.js';
import { Diagnoses, ExecutionResults } from '../shared/schemas.js';
import type { RunExecution, RunManifest } from '../shared/schemas.js';
import { executeRun } from './execution-engine/execute.js';
import { analyzeExecution } from './failure-analyzer/analyze.js';
import { generatePrd } from './prd-generator/generate.js';
import { callsInWindow } from './report/view-model.js';
import { generateScripts } from './script-generator/generate.js';
import { generateTestCases } from './test-case-generator/generate.js';

export const PIPELINE_STAGES = ['prd', 'cases', 'scripts', 'execute', 'analyze'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export interface StageReport {
  stage: PipelineStage;
  /** ran: run now; reused: done earlier and still valid; failed: threw now; not-run: an earlier stage failed. */
  action: 'ran' | 'reused' | 'failed' | 'not-run';
  durationMs: number | null;
  costUsd: number | null;
  detail: string;
}

export interface RunAllResult {
  runId: string | null;
  stages: StageReport[];
  /** Set when a stage failed: what went wrong and the command that continues. */
  failure: { stage: PipelineStage; error: string; next: string } | null;
}

/** The stage functions `runAll` calls; tests replace them. */
export interface StageFunctions {
  generatePrd: typeof generatePrd;
  generateTestCases: typeof generateTestCases;
  generateScripts: typeof generateScripts;
  executeRun: typeof executeRun;
  analyzeExecution: typeof analyzeExecution;
}

export interface RunAllOptions {
  target?: string;
  runId?: string;
  /** Start a new run and redo every stage. */
  fresh?: boolean;
  runsDir?: string;
  targetsDir?: string;
  projectRoot?: string;
  /** Stops the scripts and execute stages (Playwright and the app included). */
  signal?: AbortSignal;
  log?: (message: string) => void;
  /** Called when a stage starts, so the CLI can mark it interrupted on Ctrl+C. */
  onStage?: (stage: PipelineStage, at: { runDir: string | null; execId: string | null }) => void;
  stages?: Partial<StageFunctions>;
}

const exists = (file: string) => access(file).then(() => true, () => false);
const durationOf = (start?: string | null, end?: string | null) => (start && end ? Math.max(0, Date.parse(end) - Date.parse(start)) : null);

/** The newest run folder of a target (`<target>-YYYYMMDD-HHmmss` with a run.json), or null. */
export async function newestRunOf(target: string, runsDir: string = RUNS_DIR): Promise<string | null> {
  const names = await readdir(runsDir).catch(() => [] as string[]);
  const ours = names.filter((n) => n.startsWith(`${target}-`) && /^\d{8}-\d{6}$/.test(n.slice(target.length + 1))).sort().reverse();
  for (const name of ours) if (await exists(path.join(runsDir, name, 'run.json'))) return name;
  return null;
}

/**
 * The execution `analyze` and later stages build on: at the generation ref, no patch, no skipped seed,
 * done, and started after the scripts stage finished (older ones ran other scripts). Null when none.
 */
export async function validGoldenExecution(runDir: string, manifest: RunManifest): Promise<RunExecution | null> {
  const paths = runPaths(path.basename(runDir), path.dirname(runDir));
  const scriptsDone = manifest.stages.scripts?.finishedAt;
  const candidates = manifest.executions.filter(
    (e) => e.ref === manifest.generationRef && !e.patch && !e.skipSeed && e.executeStatus === 'done',
  );
  for (const e of candidates.reverse()) {
    const raw = await readFile(paths.results(e.execId), 'utf8').catch(() => null);
    if (raw === null) continue;
    const startedAt = ExecutionResults.parse(JSON.parse(raw)).startedAt;
    if (!scriptsDone || startedAt > scriptsDone) return e;
  }
  return null;
}

/** Marks the stage that was running as interrupted (for stages that cannot be stopped from inside). */
export async function markInterrupted(stage: PipelineStage, at: { runDir: string | null; execId: string | null }): Promise<void> {
  if (!at.runDir) return;
  const finishedAt = new Date().toISOString();
  if (stage === 'prd' || stage === 'cases' || stage === 'scripts') await setStage(at.runDir, stage, { status: 'failed', finishedAt, error: 'Interrupted' });
  if (stage === 'analyze' && at.execId) {
    const entry = (await readRunManifest(path.join(at.runDir, 'run.json'))).executions.find((e) => e.execId === at.execId);
    if (entry) await setExecution(at.runDir, { ...entry, analyzeStatus: 'failed', error: 'Interrupted' });
  }
}

/**
 * `agent all` (SPEC §10.2): prd → cases → scripts → execute (generation ref) → analyze, each through the
 * same function as its own command. Stages that are done and still valid are reused; `fresh` starts a new
 * run. Stops at the first stage that throws.
 */
export async function runAll(options: RunAllOptions = {}): Promise<RunAllResult> {
  const fns: StageFunctions = { generatePrd, generateTestCases, generateScripts, executeRun, analyzeExecution, ...options.stages };
  const runsDir = options.runsDir ?? RUNS_DIR;
  const log = options.log ?? (() => {});
  const common = {
    runsDir,
    ...(options.targetsDir ? { targetsDir: options.targetsDir } : {}),
    ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
    log,
  };
  const signal = options.signal ? { signal: options.signal } : {};

  // Which run: --run, else the newest run of --target, else the newest run; --fresh always starts a new one.
  let runId: string | null = options.fresh ? null : (options.runId ?? (options.target ? await newestRunOf(options.target, runsDir) : await latestRunWith('run.json', runsDir)));
  let target = options.target ?? null;
  if (!target) {
    const from = options.runId ?? runId ?? (await latestRunWith('run.json', runsDir));
    if (from) target = (await readRunManifest(runPaths(from, runsDir).runJson)).target;
  }
  if (!target) throw new Error('No run to continue: give --target <name> to start one');

  const reports: StageReport[] = [];
  const manifestOf = async () => (runId ? readRunManifest(runPaths(runId, runsDir).runJson) : null);
  const stageCost = async (stage: 'prd' | 'cases' | 'scripts', manifest: RunManifest) => {
    const state = manifest.stages[stage];
    const lines = (await readCallLog(runPaths(manifest.runId, runsDir).llmCalls)).lines;
    return { durationMs: durationOf(state?.startedAt, state?.finishedAt), costUsd: callsInWindow(lines, stage, state?.startedAt, state?.finishedAt).costUsd };
  };
  let execId: string | null = null;

  for (const stage of PIPELINE_STAGES) {
    const manifest = await manifestOf();
    const runDir = runId ? runPaths(runId, runsDir).dir : null;
    try {
      if (stage === 'prd' || stage === 'cases' || stage === 'scripts') {
        const done = manifest?.stages[stage]?.status === 'done' && (stage !== 'prd' || (await exists(runPaths(manifest.runId, runsDir).prd)));
        if (manifest && done) {
          reports.push({ stage, action: 'reused', ...(await stageCost(stage, manifest)), detail: manifest.stages[stage]!.status });
          continue;
        }
        options.onStage?.(stage, { runDir, execId });
        if (stage === 'prd') {
          if (manifest) log(`The prd stage of ${manifest.runId} is not done; starting a new run`);
          const result = await fns.generatePrd({ target, ...common, onRunCreated: (dir) => (runId = path.basename(dir)) });
          runId = result.runId;
        } else if (stage === 'cases') {
          await fns.generateTestCases({ runId: runId!, ...common });
        } else {
          await fns.generateScripts({ runId: runId!, ...common, ...signal });
        }
        reports.push({ stage, action: 'ran', ...(await stageCost(stage, (await manifestOf())!)), detail: 'done' });
      } else if (stage === 'execute') {
        const valid = await validGoldenExecution(runDir!, manifest!);
        if (valid) {
          execId = valid.execId;
          const results = ExecutionResults.parse(JSON.parse(await readFile(runPaths(runId!, runsDir).results(execId), 'utf8')));
          reports.push({ stage, action: 'reused', durationMs: durationOf(results.startedAt, results.finishedAt), costUsd: null, detail: describeResults(execId, results) });
          continue;
        }
        options.onStage?.(stage, { runDir, execId });
        const result = await fns.executeRun({ runId: runId!, ...common, ...signal });
        execId = result.execId;
        reports.push({ stage, action: 'ran', durationMs: durationOf(result.results.startedAt, result.results.finishedAt), costUsd: null, detail: describeResults(execId, result.results) });
      } else {
        const entry = manifest!.executions.find((e) => e.execId === execId);
        const diagnosesFile = runPaths(runId!, runsDir).diagnoses(execId!);
        if (entry?.analyzeStatus !== 'done' || !(await exists(diagnosesFile))) {
          options.onStage?.(stage, { runDir, execId });
          await fns.analyzeExecution({ runId: runId!, execId: execId!, ...common });
          reports.push({ stage, action: 'ran', ...(await analysisCost(diagnosesFile)) });
        } else {
          reports.push({ stage, action: 'reused', ...(await analysisCost(diagnosesFile)) });
        }
      }
    } catch (err) {
      const error = options.signal?.aborted ? 'Interrupted' : errorSummary(err);
      reports.push({ stage, action: 'failed', durationMs: null, costUsd: null, detail: error });
      for (const rest of PIPELINE_STAGES.slice(PIPELINE_STAGES.indexOf(stage) + 1)) {
        reports.push({ stage: rest, action: 'not-run', durationMs: null, costUsd: null, detail: '' });
      }
      const next = runId ? `npm run agent -- all --run ${runId}` : `npm run agent -- all --target ${target}`;
      return { runId, stages: reports, failure: { stage, error, next } };
    }
  }
  return { runId, stages: reports, failure: null };
}

function describeResults(execId: string, r: ExecutionResults): string {
  const s = r.summary;
  return `${execId}: ${s.passed} passed, ${s.failed} failed, ${s.errored} errored, ${s.skipped} skipped`;
}

async function analysisCost(file: string): Promise<Pick<StageReport, 'durationMs' | 'costUsd' | 'detail'>> {
  const diagnoses = Diagnoses.parse(JSON.parse(await readFile(file, 'utf8')));
  return {
    durationMs: diagnoses.summary?.durationMs ?? null,
    costUsd: diagnoses.summary?.costUsd ?? null,
    detail: `${diagnoses.diagnoses.length} diagnoses`,
  };
}

/** Lines for the CLI: one per stage (action, time, cost, detail), then the failure and how to continue. */
export function describeRunAll(result: RunAllResult): string[] {
  const time = (ms: number | null) => (ms === null ? '' : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 60_000).toFixed(1)} min`);
  const cost = (c: number | null) => (c === null ? '' : `$${c.toFixed(4)}`);
  const lines = result.stages.map(
    (s) => `${s.stage.padEnd(8)} ${s.action.padEnd(7)} ${time(s.durationMs).padStart(9)} ${cost(s.costUsd).padStart(9)}  ${s.detail}`,
  );
  const costs = result.stages.map((s) => s.costUsd).filter((c): c is number => c !== null);
  if (costs.length > 0) lines.push(`total cost ${cost(costs.reduce((a, b) => a + b, 0))}`);
  if (result.runId) lines.push(`run: ${result.runId}`);
  if (result.failure) lines.push(`Stopped at ${result.failure.stage}: ${result.failure.error}`, `To continue: ${result.failure.next}`);
  return lines;
}
