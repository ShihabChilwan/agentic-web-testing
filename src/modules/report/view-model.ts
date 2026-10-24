import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readCallLog } from '../../llm/call-log.js';
import { runPaths } from '../../shared/paths.js';
import { readRunManifest } from '../../shared/run-manifest.js';
import { Diagnoses, ExecutionResults, Prd, RunView, SCHEMA_VERSION, ScriptManifest, TestCases } from '../../shared/schemas.js';
import type {
  Diagnosis,
  LLMCallLogLine,
  RunExecution,
  RunManifest,
  TestCase,
  TestResult,
  ViewExecution,
  ViewFailure,
  ViewRequirement,
  ViewStage,
  ViewTest,
} from '../../shared/schemas.js';
import type { z } from 'zod';
import { messageValue, suspectedDefects } from '../script-generator/suspected.js';
import { allComparisons } from './compare.js';

/** Excerpts are the end of each text artifact, at most this many characters. */
export const MAX_EXCERPT_CHARS = 10_000;

/** A JSON file parsed with its schema, or null when it does not exist. A file that exists but does not parse throws. */
async function readOptional<T extends z.ZodType>(file: string, schema: T): Promise<z.infer<T> | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed = schema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`${file} does not match the current format: ${parsed.error.issues[0]?.message ?? ''}`);
  return parsed.data;
}

async function tail(file: string): Promise<string | null> {
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text === null) return null;
  return text.length > MAX_EXCERPT_CHARS ? `[${text.length - MAX_EXCERPT_CHARS} earlier characters left out]\n${text.slice(-MAX_EXCERPT_CHARS)}` : text;
}

/** Model calls of one purpose inside a stage's time window, and their summed cost (null when none had one). */
export function callsInWindow(lines: readonly LLMCallLogLine[], purpose: string, startedAt?: string | null, finishedAt?: string | null) {
  const inWindow = lines.filter((l) => l.purpose === purpose && (!startedAt || l.ts >= startedAt) && (!finishedAt || l.ts <= finishedAt));
  const costs = inWindow.map((l) => l.costUsd).filter((c): c is number => c !== null);
  return { calls: inWindow.length, costUsd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null };
}

const durationOf = (start?: string | null, end?: string | null) => (start && end ? Math.max(0, Date.parse(end) - Date.parse(start)) : null);

/** "golden", "golden + dev-001-….patch", "golden, seed skipped". */
export function executionLabel(e: Pick<RunExecution, 'ref' | 'patch' | 'skipSeed'>): string {
  return `${e.ref}${e.patch ? ` + ${path.posix.basename(e.patch)}` : ''}${e.skipSeed ? ', seed skipped' : ''}`;
}

async function failureOf(
  result: TestResult,
  runDir: string,
  execRel: string,
  diagnoses: Diagnosis[] | null,
  noTools: Diagnosis[] | null,
): Promise<ViewFailure> {
  const message = result.error?.message ?? '';
  const file = (rel: string | undefined) => (rel ? path.join(runDir, execRel, rel) : null);
  const excerpt = async (rel: string | undefined) => (rel ? tail(file(rel)!) : null);
  const screenshotFile = file(result.artifacts.screenshot);
  const png = screenshotFile ? await readFile(screenshotFile).catch(() => null) : null;
  const diagnosisFor = (list: Diagnosis[] | null) => list?.find((d) => d.testCaseIds.includes(result.testCaseId))?.id ?? null;
  return {
    message,
    expectationId: result.error?.expectationId ?? null,
    category: result.error?.category ?? null,
    expected: messageValue(message, 'Expected'),
    received: messageValue(message, 'Received'),
    screenshot: png ? `data:image/png;base64,${png.toString('base64')}` : null,
    trace: result.artifacts.trace ? path.posix.join(execRel, result.artifacts.trace) : null,
    excerpts: {
      network: await excerpt(result.artifacts.network),
      console: await excerpt(result.artifacts.console),
      serverLog: await excerpt(result.artifacts.serverLog),
      lastResponse: await excerpt(result.artifacts.lastResponse),
    },
    diagnosisId: diagnosisFor(diagnoses),
    noToolsDiagnosisId: diagnosisFor(noTools),
  };
}

async function executionView(
  entry: RunExecution,
  runDir: string,
  testCases: ReadonlyMap<string, TestCase>,
): Promise<ViewExecution> {
  const paths = runPaths(path.basename(runDir), path.dirname(runDir));
  const execRel = path.posix.join('executions', entry.execId);
  const results = await readOptional(paths.results(entry.execId), ExecutionResults);
  const full = await readOptional(paths.diagnoses(entry.execId), Diagnoses);
  const noTools = await readOptional(paths.diagnosesNoTools(entry.execId), Diagnoses);
  const info = (id: string) => ({ title: testCases.get(id)?.title ?? '', requirementIds: testCases.get(id)?.requirementIds ?? [] });
  const tests: ViewTest[] = [];
  for (const r of results?.results ?? []) {
    tests.push({
      testCaseId: r.testCaseId,
      ...info(r.testCaseId),
      status: r.status,
      isolated: r.isolated,
      durationMs: r.durationMs,
      ...(r.status === 'passed' ? {} : { failure: await failureOf(r, runDir, execRel, full?.diagnoses ?? null, noTools?.diagnoses ?? null) }),
    });
  }
  for (const s of results?.skipped ?? []) {
    tests.push({ testCaseId: s.testCaseId, ...info(s.testCaseId), status: 'skipped', skipReason: s.reason, isolated: false, durationMs: 0 });
  }
  return {
    execId: entry.execId,
    label: executionLabel(entry),
    ref: entry.ref,
    commit: entry.commit,
    patch: entry.patch ?? null,
    skipSeed: entry.skipSeed ?? false,
    executeStatus: entry.executeStatus,
    analyzeStatus: entry.analyzeStatus,
    error: entry.error ?? null,
    startedAt: results?.startedAt ?? null,
    finishedAt: results?.finishedAt ?? null,
    summary: results?.summary ?? null,
    timing: results?.timing ?? null,
    environment: results?.environment ?? null,
    incidents: results?.incidents ?? [],
    analysis: { full: full?.summary ?? null, noTools: noTools?.summary ?? null },
    tests,
    diagnoses: full?.diagnoses ?? null,
    noToolsDiagnoses: noTools?.diagnoses ?? null,
  };
}

function stagesView(manifest: RunManifest, calls: readonly LLMCallLogLine[]): ViewStage[] {
  return (['prd', 'cases', 'scripts'] as const).flatMap((name) => {
    const stage = manifest.stages[name];
    if (!stage) return [];
    return [
      {
        name,
        status: stage.status,
        startedAt: stage.startedAt ?? null,
        finishedAt: stage.finishedAt ?? null,
        durationMs: durationOf(stage.startedAt, stage.finishedAt),
        ...callsInWindow(calls, name, stage.startedAt, stage.finishedAt),
      },
    ];
  });
}

/**
 * The run view model (SPEC §9.1): everything the report and the dashboard show, built from the run
 * folder by reading files only. Missing files give empty parts.
 */
export async function buildRunView(runDir: string, now: Date = new Date()): Promise<RunView> {
  const paths = runPaths(path.basename(runDir), path.dirname(runDir));
  const manifest = await readRunManifest(paths.runJson);
  const prd = await readOptional(paths.prd, Prd);
  const testCases = await readOptional(paths.testCases, TestCases);
  const scripts = await readOptional(paths.scriptsManifest, ScriptManifest);
  const calls = (await readCallLog(paths.llmCalls)).lines;

  const cases = new Map((testCases?.testCases ?? []).map((tc) => [tc.id, tc]));
  const outcomeOf = new Map(
    (scripts?.scripts ?? []).map((s) => [s.testCaseId, { outcome: s.status === 'invalid' ? ('invalid' as const) : (s.validationOutcome ?? 'invalid'), failureCategory: s.failureCategory }]),
  );
  const uncovered = new Map((testCases?.coverage.uncovered ?? []).map((u) => [u.requirementId, u.reason]));
  const partial = new Map((testCases?.coverage.partial ?? []).map((p) => [p.requirementId, p.reason]));
  const requirements: ViewRequirement[] = (prd?.requirements ?? []).map((r) => ({
    id: r.id,
    featureId: r.featureId,
    feature: prd?.features.find((f) => f.id === r.featureId)?.name ?? '',
    statement: r.statement,
    priority: r.priority,
    layer: r.layer,
    uncovered: uncovered.get(r.id) ?? null,
    partial: partial.get(r.id) ?? null,
    testCases: [...cases.values()]
      .filter((tc) => tc.requirementIds.includes(r.id))
      .map((tc) => ({
        id: tc.id,
        title: tc.title,
        layer: tc.layer,
        category: tc.category,
        outcome: outcomeOf.get(tc.id)?.outcome ?? 'none',
        failureCategory: outcomeOf.get(tc.id)?.failureCategory ?? null,
      })),
  }));
  const outcomes = [...cases.keys()].map((id) => outcomeOf.get(id)?.outcome ?? 'none');
  const covered = new Set([...cases.values()].flatMap((tc) => tc.requirementIds));

  const executions: ViewExecution[] = [];
  for (const entry of manifest.executions) executions.push(await executionView(entry, paths.dir, cases));

  return RunView.parse({
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    run: {
      runId: manifest.runId,
      target: manifest.target,
      generationRef: manifest.generationRef,
      generationCommit: manifest.generationCommit,
      createdAt: manifest.createdAt,
      models: manifest.llm.models,
      upstreamProviders: manifest.llm.upstreamProviders ?? [],
      playwrightVersion: manifest.stages.scripts?.scripts?.playwrightVersion ?? null,
    },
    stages: stagesView(manifest, calls),
    coverage: {
      requirements: prd?.requirements.length ?? 0,
      covered: (prd?.requirements ?? []).filter((r) => covered.has(r.id)).length,
      partial: testCases?.coverage.partial.length ?? 0,
      testCases: cases.size,
      scripts: {
        passed: outcomes.filter((o) => o === 'passed').length,
        assertionFailed: outcomes.filter((o) => o === 'assertion_failed').length,
        invalid: outcomes.filter((o) => o === 'invalid').length,
        none: outcomes.filter((o) => o === 'none').length,
      },
    },
    requirements,
    suspectedDefects: scripts && testCases ? suspectedDefects(scripts, testCases, prd) : [],
    executions,
    comparisons: allComparisons(executions),
  });
}
