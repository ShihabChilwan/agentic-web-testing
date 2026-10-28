import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readCallLog } from '../../llm/call-log.js';
import { createLLMClient } from '../../llm/client.js';
import type { LLMClient } from '../../llm/types.js';
import { loadLLMConfig } from '../../shared/config.js';
import type { LLMConfig } from '../../shared/config.js';
import { PRICING_FILE, RUNS_DIR, runPaths } from '../../shared/paths.js';
import { errorSummary, latestRunWith, readRunManifest, setStage } from '../../shared/run-manifest.js';
import { CoverageReport, MAX_TEST_CASES, Prd, SCHEMA_VERSION, TestCases } from '../../shared/schemas.js';
import type { PartlyCoveredRequirement, StageGapsSummary, TestCase } from '../../shared/schemas.js';
import { loadTargetConfig } from '../../shared/target-config.js';
import { Transcript } from '../../agent/transcript.js';
import { readFacts } from '../execution-engine/facts.js';
import { measureCoverage, type MeasureCoverageOptions, type MeasuredCoverage } from '../execution-engine/coverage.js';
import { toTestCase } from './checks.js';
import { linesAtCommit } from './context.js';
import { describesEndpoint, pageCoverage, runSession, type SessionInput } from './generate.js';

type Endpoint = Prd['apiEndpoints'][number];

export interface GenerateGapsOptions {
  /** Defaults to the newest run with a scripts/manifest.json. */
  runId?: string;
  runsDir?: string;
  targetsDir?: string;
  projectRoot?: string;
  llmConfig?: LLMConfig;
  createLlm?: (config: LLMConfig, callLogFile: string) => Promise<LLMClient>;
  /** For tests: replaces the coverage measurement (default: the Execution Engine's measureCoverage). */
  measure?: (options: MeasureCoverageOptions) => Promise<MeasuredCoverage>;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export interface GenerateGapsResult {
  runId: string;
  coverage: CoverageReport;
  summary: StageGapsSummary;
  /** Ids of the test cases the round added. */
  added: string[];
}

const label = (e: Endpoint) => `${e.method} ${e.path}`;

/** Each PRD endpoint is reached when a line of its evidence ran (§5.1). */
export function endpointReach(endpoints: readonly Endpoint[], files: Record<string, number[]>): CoverageReport['endpoints'] {
  return endpoints.map((e) => ({
    method: e.method,
    path: e.path,
    reached: e.evidence.some((ev) => (files[ev.file] ?? []).some((line) => line >= ev.lines[0] && line <= ev.lines[1])),
  }));
}

/**
 * The gaps stage (SPEC §5.1): measures which backend code the passing scripts run on the generation version, finds the
 * PRD endpoints none of them reached, and runs one test case session per feature for the api requirements describing
 * them, within what is left of the 150 test cases. New cases get the next ids and are appended to testcases.json; the
 * scripts stage is set to pending, so `agent scripts` writes scripts for the new cases and keeps the others.
 */
export async function generateGaps(options: GenerateGapsOptions = {}): Promise<GenerateGapsResult> {
  const log = options.log ?? (() => {});
  const ctx = await gapsContext(options);
  const { runId, paths, manifest, config, repoDir, prd } = ctx;
  const before = TestCases.parse(JSON.parse(await readFile(paths.testCases, 'utf8')));

  const startedAt = new Date().toISOString();
  await Transcript.archive(paths.transcriptsDir, 'gaps');
  await setStage(paths.dir, 'gaps', { status: 'running', startedAt });
  try {
    const { coverage, measured } = await measureAndWrite(ctx, options);
    const reach = coverage.endpoints;
    const unreached = prd.apiEndpoints.filter((_, i) => !reach[i]!.reached);
    log(`Endpoints reached by a passing script: ${reach.length - unreached.length} of ${reach.length}`);

    // One session per feature, for its api requirements that describe an unreached endpoint.
    const llmConfig = options.llmConfig ?? (await loadLLMConfig());
    const llm = options.createLlm
      ? await options.createLlm(llmConfig, paths.llmCalls)
      : await createLLMClient(llmConfig, { callLogFile: paths.llmCalls, pricingFile: PRICING_FILE });
    const facts = await readFacts(config.name, options.targetsDir);
    const read = linesAtCommit({ root: repoDir, forbiddenPaths: config.forbiddenPaths }, manifest.generationCommit);
    const deps = { purpose: 'gaps', llm, llmConfig, config, read, transcriptsDir: paths.transcriptsDir, facts, endpoints: prd.apiEndpoints, pages: prd.uiRoutes, pageSnapshots: [] };
    let remaining = MAX_TEST_CASES - before.testCases.length;
    const inputs: SessionInput[] = [];
    const asked = new Set<Endpoint>();
    for (const feature of prd.features) {
      const apiRequirements = prd.requirements.filter((r) => r.featureId === feature.id && r.layer === 'api');
      const endpoints = unreached.filter((e) => !asked.has(e) && apiRequirements.some((r) => describesEndpoint(r, e, prd.apiEndpoints)));
      const requirements = apiRequirements.filter((r) => endpoints.some((e) => describesEndpoint(r, e, prd.apiEndpoints)));
      // Two per endpoint: a found case may need its not-found partner (§5 API rules).
      const quota = Math.min(remaining, 2 * endpoints.length);
      if (requirements.length === 0 || quota <= 0) continue;
      remaining -= quota;
      for (const e of endpoints) asked.add(e);
      inputs.push({ feature, requirements, quota, gapRound: true, endpointRound: endpoints });
    }
    if (inputs.length > 0) log(`Endpoint round: ${asked.size} endpoints in ${inputs.length} features`);
    const outcomes = await Promise.all(inputs.map((input) => runSession(input, deps)));

    // New ids after the existing ones; existing cases keep their ids, so their scripts stay valid.
    const order = new Map(prd.requirements.map((r, i) => [r.id, i]));
    const firstReq = (ids: string[]) => Math.min(...ids.map((id) => order.get(id) ?? Infinity));
    const drafts = outcomes.flatMap((o) => o.cases).sort((a, b) => firstReq(a.requirementIds) - firstReq(b.requirementIds));
    const lastNumber = Math.max(0, ...before.testCases.map((c) => Number(c.id.slice(3))));
    const added: TestCase[] = drafts.map((d, i) => toTestCase(d, `TC-${String(lastNumber + i + 1).padStart(3, '0')}`));
    const testCases = [...before.testCases, ...added];

    const covered = new Set(testCases.flatMap((c) => c.requirementIds));
    const declines = outcomes.flatMap((o) => o.declined);
    const partial: PartlyCoveredRequirement[] = [...before.coverage.partial];
    for (const d of declines.filter((d) => covered.has(d.requirementId))) {
      if (!partial.some((p) => p.requirementId === d.requirementId)) partial.push({ requirementId: d.requirementId, reason: d.reason });
    }
    const result = TestCases.parse({
      ...before,
      generatedAt: new Date().toISOString(),
      testCases,
      coverage: {
        requirementsTotal: prd.requirements.length,
        requirementsCovered: covered.size,
        uncovered: before.coverage.uncovered.filter((u) => !covered.has(u.requirementId)),
        partial: partial.sort((a, b) => (order.get(a.requirementId) ?? 0) - (order.get(b.requirementId) ?? 0)),
        pages: pageCoverage(prd, testCases),
      },
    });
    if (added.length > 0) await writeFile(paths.testCases, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

    const calls = (await readCallLog(paths.llmCalls)).lines.filter((l) => l.purpose === 'gaps' && l.ts >= startedAt);
    const costs = calls.map((l) => l.costUsd).filter((c): c is number => c !== null);
    const notPassed = measured.results.summary.total - measured.results.summary.passed;
    const warnings = [
      ...(notPassed > 0 ? [`${notPassed} of ${measured.results.summary.total} scripts did not pass during the coverage run; coverage may be lower than the suite's`] : []),
      ...unreached.filter((e) => !asked.has(e)).map((e) => `${label(e)} was not reached and no api requirement with room left describes it`),
      ...inputs.flatMap((input, i) => (outcomes[i]!.failure ? [`${input.feature.id}: endpoint-round session failed (${outcomes[i]!.failure})`] : [])),
    ];
    const summary: StageGapsSummary = {
      endpoints: { total: reach.length, reached: reach.length - unreached.length },
      unreached: unreached.map(label),
      asked: [...asked].map(label),
      casesAdded: added.length,
      sessions: outcomes.length,
      calls: outcomes.reduce((n, o) => n + o.turns, 0),
      rejected: {
        invalidInput: outcomes.reduce((n, o) => n + o.submitStats.invalidInput, 0),
        checkFailed: outcomes.reduce((n, o) => n + o.submitStats.checkFailed, 0),
      },
      costUsd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null,
      warnings,
    };
    await setStage(paths.dir, 'gaps', { status: 'done', startedAt, finishedAt: new Date().toISOString(), gaps: summary });
    // The new cases need scripts; a resumed scripts stage keeps every script of the existing cases.
    if (added.length > 0) await setStage(paths.dir, 'scripts', { status: 'pending' });
    return { runId, coverage, summary, added: added.map((c) => c.id) };
  } catch (err) {
    const error = options.signal?.aborted ? 'Interrupted' : errorSummary(err);
    await setStage(paths.dir, 'gaps', { status: 'failed', startedAt, finishedAt: new Date().toISOString(), error });
    throw err;
  }
}

/** What the gaps stage and the measure-only command share: the run, its target and its PRD. */
async function gapsContext(options: Pick<GenerateGapsOptions, 'runId' | 'runsDir' | 'targetsDir' | 'projectRoot'>) {
  const runsDir = options.runsDir ?? RUNS_DIR;
  const runId = options.runId ?? (await latestRunWith('scripts/manifest.json', runsDir));
  if (!runId) throw new Error(`No run with a scripts/manifest.json in ${runsDir}; run "agent scripts" first`);
  const paths = runPaths(runId, runsDir);
  const manifest = await readRunManifest(paths.runJson);
  const scriptsStatus = manifest.stages.scripts?.status;
  if (scriptsStatus !== 'done') throw new Error(`The scripts stage of ${runId} is ${scriptsStatus ?? 'missing'}, not done; finish "agent scripts" first`);
  const { config, repoDir, targetDir } = await loadTargetConfig(manifest.target, {
    ...(options.targetsDir ? { targetsDir: options.targetsDir } : {}),
    ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
  });
  if (!config.coverage) throw new Error(`Target ${config.name} has no "coverage" setting in target.config.json; the gaps stage needs it`);
  const prd = Prd.parse(JSON.parse(await readFile(paths.prd, 'utf8')));
  return { runId, paths, manifest, config, repoDir, targetDir, prd, coverageKind: config.coverage.kind };
}

/** Measures backend coverage of the passing scripts and writes coverage/coverage.json (§5.1 steps 1–3). */
async function measureAndWrite(ctx: Awaited<ReturnType<typeof gapsContext>>, options: Pick<GenerateGapsOptions, 'measure' | 'signal' | 'log'>) {
  const log = options.log ?? (() => {});
  log(`Measuring backend coverage: the passing scripts on ${ctx.manifest.generationRef}`);
  const measured = await (options.measure ?? measureCoverage)({
    runDir: ctx.paths.dir,
    config: ctx.config,
    repoDir: ctx.repoDir,
    targetDir: ctx.targetDir,
    generationRef: ctx.manifest.generationRef,
    log,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const coverage = CoverageReport.parse({
    schemaVersion: SCHEMA_VERSION,
    kind: ctx.coverageKind,
    generationCommit: measured.commit,
    measuredAt: new Date().toISOString(),
    scripts: { run: measured.results.summary.total, passed: measured.results.summary.passed },
    processes: measured.processes,
    files: Object.fromEntries(Object.entries(measured.files).map(([file, lines]) => [file, { lines }])),
    endpoints: endpointReach(ctx.prd.apiEndpoints, measured.files),
  });
  await mkdir(ctx.paths.coverageDir, { recursive: true });
  await writeFile(ctx.paths.coverage, `${JSON.stringify(coverage, null, 2)}\n`, 'utf8');
  return { coverage, measured };
}

export interface MeasureEndpointsResult {
  runId: string;
  coverage: CoverageReport;
}

/**
 * `agent gaps --measure-only` (SPEC §5.1): the measurement alone, for an honest "endpoints reached" figure of the
 * current suite. Writes coverage/coverage.json; adds no test case and leaves run.json's stages alone.
 */
export async function measureEndpoints(options: Omit<GenerateGapsOptions, 'llmConfig' | 'createLlm'> = {}): Promise<MeasureEndpointsResult> {
  const ctx = await gapsContext(options);
  const { coverage } = await measureAndWrite(ctx, options);
  return { runId: ctx.runId, coverage };
}

/** Lines for a person: the endpoints the passing scripts reached, and those they did not. */
export function describeMeasurement(result: MeasureEndpointsResult): string[] {
  const { coverage: c } = result;
  const missed = c.endpoints.filter((e) => !e.reached).map((e) => `${e.method} ${e.path}`);
  return [
    `API endpoints reached by a passing script: ${c.endpoints.length - missed.length} of ${c.endpoints.length} (scripts run ${c.scripts.run}, passed ${c.scripts.passed})`,
    ...(missed.length > 0 ? [`not reached: ${missed.join(', ')}`] : []),
    `written: runs/${result.runId}/coverage/coverage.json (no test cases added)`,
  ];
}

/** Lines for a person: reach before the round, what was asked, what was added, and what to run next. */
export function describeGaps(result: GenerateGapsResult): string[] {
  const s = result.summary;
  return [
    `API endpoints reached by a passing script: ${s.endpoints.reached} of ${s.endpoints.total} (scripts run ${result.coverage.scripts.run}, passed ${result.coverage.scripts.passed})`,
    ...(s.unreached.length > 0 ? [`not reached: ${s.unreached.join(', ')}`] : []),
    `endpoint round: ${s.asked.length} endpoints asked in ${s.sessions} sessions; ${s.casesAdded} test cases added${result.added.length > 0 ? ` (${result.added[0]}..${result.added.at(-1)})` : ''}`,
    `${s.calls} model calls, cost ${s.costUsd === null ? 'unknown' : `$${s.costUsd.toFixed(4)}`}; rejected submits: ${s.rejected.invalidInput} invalid input, ${s.rejected.checkFailed} failed checks`,
    ...s.warnings.map((w) => `Warning: ${w}`),
    ...(s.casesAdded > 0 ? [`Next: npm run agent -- scripts --run ${result.runId} --redo none (writes scripts for the new cases only)`] : []),
  ];
}
