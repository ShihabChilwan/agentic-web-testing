import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLLMClient } from '../../llm/client.js';
import { LLMBudgetExceededError } from '../../llm/errors.js';
import type { LLMClient } from '../../llm/types.js';
import { loadLLMConfig } from '../../shared/config.js';
import type { LLMConfig } from '../../shared/config.js';
import { PRICING_FILE, RUNS_DIR, runPaths } from '../../shared/paths.js';
import { errorSummary, readRunManifest } from '../../shared/run-manifest.js';
import { CoverageReport, Prd, ScenarioCases, ScenarioSummary, ScriptManifest, TestCases, VariationPoints } from '../../shared/schemas.js';
import type { RecordedResponse, ScenarioCase, ScenarioDrop, ScriptManifestEntry, TargetConfig, VariationPoint } from '../../shared/schemas.js';
import { loadTargetConfig } from '../../shared/target-config.js';
import { uiBaseUrl } from '../../shared/target-ui.js';
import { executeVersion } from '../execution-engine/execute.js';
import { readFacts } from '../execution-engine/facts.js';
import { startTarget } from '../execution-engine/lifecycle.js';
import { pageSnapshot } from '../execution-engine/probe.js';
import { readResponsesFile } from '../execution-engine/responses.js';
import { writePlaywrightConfig } from '../script-generator/dry-run.js';
import { createScriptWriter, type GenerateScriptsOptions, type RunningApp } from '../script-generator/generate.js';
import { linesAtCommit } from '../test-case-generator/context.js';
import { scenarioCase } from './cases.js';
import { combineSuite, suiteCases } from './combine.js';
import { copyForScenarios, isGenerationExecution, SUITE_RECORDINGS } from './copy.js';
import { discoverFeature } from './discover.js';
import { rolePoints, selectPoints, type DraftPoint } from './points.js';
import { unstableScenarios, type CheckRun } from './stability.js';
import { readScripts, suiteUsage, unrunLines } from './usage.js';

/** Scenario tests per suite at most. */
export const MAX_SCENARIOS = 40;
/** Points kept in reserve for refills. */
export const RESERVE = 10;
/** The default cost cap per suite, in US dollars. */
export const DEFAULT_COST_CAP_USD = 1;
/** Runs of the scenario scripts on the correct version after they pass their dry run. */
export const CHECK_RUNS = 2;

export interface GenerateScenariosOptions {
  /** Work in this run folder (its scripts stage done). */
  runId?: string;
  /** Copy the generation files of this run folder to `<from>-scn` first and work there. */
  from?: string;
  runsDir?: string;
  targetsDir?: string;
  projectRoot?: string;
  /** At most this many scenario tests (default and maximum 40). */
  cap?: number;
  /** Stop before any model call once this much is spent (80% rule, `--cost-cap`); default $1. */
  costCapUsd?: number;
  /** Remove an earlier scenario generation of this run and start again. */
  fresh?: boolean;
  llmConfig?: LLMConfig;
  createLlm?: (config: LLMConfig, callLogFile: string, costCapUsd: number) => Promise<LLMClient>;
  /** For tests: replaces starting the real app for discovery and dry runs. */
  startApp?: (config: TargetConfig, ref: string, logsDir: string) => Promise<RunningApp>;
  runDryRun?: GenerateScriptsOptions['runDryRun'];
  snapshotPage?: GenerateScriptsOptions['snapshotPage'];
  /** For tests: replaces one check run of a scripts folder on the correct version. */
  runCheck?: (input: { runDir: string; scriptsDir: string; execId: string }) => Promise<CheckRun>;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export interface GenerateScenariosResult {
  runId: string;
  summary: ScenarioSummary;
  summaryFile: string;
}

const exists = (p: string) => stat(p).then(() => true, () => false);
const sc = (n: number) => `SC-${String(n).padStart(3, '0')}`;
const vp = (n: number) => `VP-${String(n).padStart(3, '0')}`;

/** Recorded responses of the suite on the correct version: the copied ones, else the run's own generation executions. */
async function suiteRecordings(runDir: string): Promise<RecordedResponse[][]> {
  const copied = path.join(runDir, SUITE_RECORDINGS);
  const names = (await readdir(copied).catch(() => [] as string[])).filter((n) => n.endsWith('.responses.jsonl')).sort();
  if (names.length > 0) return Promise.all(names.map((n) => readResponsesFile(path.join(copied, n))));
  const manifest = await readRunManifest(path.join(runDir, 'run.json'));
  const out: RecordedResponse[][] = [];
  for (const e of manifest.executions.filter((x) => isGenerationExecution(x, manifest))) {
    const file = path.join(runDir, 'executions', e.execId, 'responses.jsonl');
    if (await exists(file)) out.push(await readResponsesFile(file));
  }
  return out;
}

/**
 * `agent scenarios` (SPEC §6.5): adds scenario tests to a generated suite, kept apart from it. Code works out what the
 * suite already does; role points come from code, the other variation points from one read-only discovery session per
 * feature; at most `cap` are chosen; each gets a script through the scripts stage's fix loop (dry run on the correct
 * version, locked expectations, repair); the passing ones run twice more on the correct version and any that behave
 * differently are dropped; dropped ones are replaced once from the reserve. Writes scenarios/ and the combined suite
 * scripts-with-scenarios/; scripts/, testcases.json and run.json are never changed.
 */
export async function generateScenarios(options: GenerateScenariosOptions): Promise<GenerateScenariosResult> {
  const log = options.log ?? (() => {});
  const runsDir = options.runsDir ?? RUNS_DIR;
  const cap = Math.min(options.cap ?? MAX_SCENARIOS, MAX_SCENARIOS);
  if (!(cap >= 1)) throw new Error(`The scenario cap must be 1 to ${MAX_SCENARIOS}`);
  const costCapUsd = options.costCapUsd ?? DEFAULT_COST_CAP_USD;
  if (!(costCapUsd > 0)) throw new Error('The cost cap must be a positive number of US dollars');
  let folder = options.runId;
  if (options.from) {
    const copied = await copyForScenarios(runsDir, options.from);
    folder = copied.folder;
    log(`Copied the generation files of ${options.from} to ${folder} (${copied.recordings.length} recordings of the correct version)`);
  }
  if (!folder) throw new Error('Give --from <run> or --run <run>');
  const paths = runPaths(folder, runsDir);
  const dir = path.join(paths.dir, 'scenarios');
  const summaryFile = path.join(dir, 'summary.json');
  if (await exists(summaryFile)) {
    if (!options.fresh) throw new Error(`${folder} already has scenarios (scenarios/summary.json); pass --fresh to generate them again`);
  }
  if (options.fresh) {
    for (const name of await readdir(dir).catch(() => [] as string[])) if (name !== 'suite-recordings') await rm(path.join(dir, name), { recursive: true, force: true });
    await rm(path.join(paths.dir, 'scripts-with-scenarios'), { recursive: true, force: true });
  }
  await mkdir(dir, { recursive: true });

  const manifest = await readRunManifest(paths.runJson);
  if (manifest.stages.scripts?.status !== 'done') throw new Error(`The scripts stage of ${folder} is not done`);
  const prd = Prd.parse(JSON.parse(await readFile(paths.prd, 'utf8')));
  // The suite's cases must be readable: the combined suite's cases.json starts with them.
  TestCases.parse(JSON.parse(await readFile(paths.testCases, 'utf8')));
  const suiteManifest = ScriptManifest.parse(JSON.parse(await readFile(paths.scriptsManifest, 'utf8')));
  const { config, repoDir, targetDir } = await loadTargetConfig(manifest.target, {
    ...(options.targetsDir ? { targetsDir: options.targetsDir } : {}),
    ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
  });
  const facts = await readFacts(config.name, options.targetsDir);
  const coverage = await readFile(paths.coverage, 'utf8').then((t) => CoverageReport.parse(JSON.parse(t)), () => null);
  const read = linesAtCommit({ root: repoDir, forbiddenPaths: config.forbiddenPaths }, manifest.generationCommit);
  const usage = suiteUsage({ prd, config, scripts: await readScripts(paths.scriptsDir), recordings: await suiteRecordings(paths.dir) });
  const warnings: string[] = [];
  if (usage.recordings === 0) warnings.push('No recorded responses of the correct version: query values the suite sends were read from the scripts only');
  if (!coverage) warnings.push('No coverage/coverage.json: points cannot be ranked by code no test ran');

  const startedAt = new Date();
  const llmConfig = options.llmConfig ?? (await loadLLMConfig());
  const client = options.createLlm
    ? await options.createLlm(llmConfig, paths.llmCalls, costCapUsd)
    : await createLLMClient(llmConfig, { callLogFile: paths.llmCalls, pricingFile: PRICING_FILE, costCap: { capUsd: costCapUsd } });
  const spend = { usd: 0, calls: 0, capped: false };
  const llm: LLMClient = {
    chat: async (req) => {
      try {
        const response = await client.chat(req);
        spend.calls++;
        if (typeof response.usage.costUsd === 'number') spend.usd += response.usage.costUsd;
        return response;
      } catch (err) {
        if (err instanceof LLMBudgetExceededError) spend.capped = true;
        throw err;
      }
    },
  };
  const transcriptsDir = path.join(dir, 'transcripts');
  const startApp = async (): Promise<RunningApp> =>
    options.startApp
      ? options.startApp(config, manifest.generationRef, path.join(dir, 'server'))
      : startTarget(config, { ref: manifest.generationRef, generationRef: manifest.generationRef, repoDir, targetDir, logsDir: path.join(dir, 'server'), log });

  const timing = { discoveryMs: 0, scriptsMs: 0, stabilityMs: 0 };
  const dropped: ScenarioDrop[] = [];
  const cases: ScenarioCase[] = [];
  const entries = new Map<string, ScriptManifestEntry>();
  const kept: ScenarioCase[] = [];
  let points: VariationPoint[] = [];
  let discovery = { sessions: 0, failedSessions: 0, rejected: 0 };
  let combined: ScenarioSummary['combined'] = null;
  const scriptsDir = path.join(dir, 'scripts');
  const writeSummary = async (status: 'done' | 'failed', error?: string) => {
    const count = (key: (p: VariationPoint) => string) => points.reduce<Record<string, number>>((o, p) => ({ ...o, [key(p)]: (o[key(p)] ?? 0) + 1 }), {});
    const summary = ScenarioSummary.parse({
      schemaVersion: '1.0',
      sourceRunId: folder,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      status,
      ...(error ? { error } : {}),
      cap,
      costCapUsd,
      costUsd: spend.usd,
      calls: spend.calls,
      discovery,
      points: { total: points.length, byKind: count((p) => p.kind), byOrigin: count((p) => p.origin) },
      written: cases.length,
      kept: kept.map((c) => c.id),
      dropped,
      combined,
      timing,
      warnings: [...warnings, ...(spend.capped ? [`The cost cap of $${costCapUsd.toFixed(2)} was reached: some sessions or scripts did not run`] : [])],
    });
    await writeFile(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  };

  let app: RunningApp | undefined;
  try {
    // The scenario scripts use the suite's own helpers and settings, so both sets run in one suite.
    await mkdir(scriptsDir, { recursive: true });
    await copyFile(path.join(paths.scriptsDir, '_helpers.ts'), path.join(scriptsDir, '_helpers.ts'));
    if (await exists(path.join(paths.scriptsDir, '_target.json'))) await copyFile(path.join(paths.scriptsDir, '_target.json'), path.join(scriptsDir, '_target.json'));
    await writePlaywrightConfig(dir, uiBaseUrl(config));

    // A clean start at the generation ref also checks the repo out there, for the read-only tools.
    log(`Starting the app at ${manifest.generationRef}`);
    app = await startApp();

    // 1. Variation points: role points by code, the rest by one discovery session per feature.
    const discoveryStarted = Date.now();
    const roles = rolePoints(prd, usage, config.fixtures, config.backend.apiPrefix);
    const rolePointsByFeature = new Map<string, string[]>();
    for (const p of roles) {
      if (!rolePointsByFeature.has(p.featureId)) rolePointsByFeature.set(p.featureId, []);
      rolePointsByFeature.get(p.featureId)!.push(`${p.endpoint ?? `open ${p.page}`} as ${p.role}`);
    }
    log(`${roles.length} role points from the PRD and the fixture users; asking ${prd.features.length} discovery sessions for the rest`);
    const outcomes = await Promise.all(
      prd.features.map((feature) =>
        discoverFeature(feature, { llm, llmConfig, prd, config, usage, coverage, read, repoDir, transcriptsDir, rolePointsByFeature }),
      ),
    );
    discovery = { sessions: outcomes.length, failedSessions: outcomes.filter((o) => o.error).length, rejected: outcomes.reduce((n, o) => n + o.rejected, 0) };
    for (const o of outcomes.filter((x) => x.error)) warnings.push(`Discovery for ${o.featureId} ended without points: ${o.error}`);
    const drafts: DraftPoint[] = [];
    for (const feature of prd.features) {
      drafts.push(...(outcomes.find((o) => o.featureId === feature.id)?.points ?? []), ...roles.filter((p) => p.featureId === feature.id));
    }
    points = [];
    for (const [i, d] of drafts.entries()) points.push({ ...d, id: vp(i + 1), unrunLines: (await unrunLines(d.citation.file, d.citation.lines, coverage, read)).length > 0 });
    const choice = selectPoints(points, prd.features.map((f) => f.id), cap, RESERVE);
    await writeFile(path.join(dir, 'variation-points.json'), `${JSON.stringify(VariationPoints.parse({ schemaVersion: '1.0', generatedAt: new Date().toISOString(), points, ...choice }), null, 2)}\n`);
    timing.discoveryMs = Date.now() - discoveryStarted;
    log(`${points.length} variation points (${outcomes.reduce((n, o) => n + o.points.length, 0)} proposed, ${roles.length} role points); ${choice.selected.length} chosen, ${choice.reserve.length} in reserve`);

    const byId = new Map(points.map((p) => [p.id, p]));
    const reserve = [...choice.reserve];
    let next = 1;
    for (let round = 1; round <= 2; round++) {
      const want = round === 1 ? choice.selected : reserve.splice(0, cap - kept.length);
      if (want.length === 0 || options.signal?.aborted || spend.capped) break;
      const roundCases = want.map((id) => scenarioCase(byId.get(id)!, sc(next++)));
      cases.push(...roundCases);
      if (!app) {
        log(`Starting the app at ${manifest.generationRef} for the refill`);
        app = await startApp();
      }

      // 2. Scripts through the scripts stage's fix loop, in the scenarios folder.
      const scriptsStarted = Date.now();
      log(`Round ${round}: writing ${roundCases.length} scenario scripts`);
      const writer = createScriptWriter({
        llm,
        llmConfig,
        config,
        facts,
        prd,
        repoDir,
        generationCommit: manifest.generationCommit,
        workDir: dir,
        scriptsDir,
        transcriptsDir,
        app,
        ...(options.runDryRun ? { runDryRun: options.runDryRun } : {}),
        snapshotPage: options.snapshotPage ?? pageSnapshot,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      await Promise.all(
        roundCases.map(async (c) => {
          const point = byId.get(c.scenario.variationPointId)!;
          const lines = (await read(point.citation.file)) ?? [];
          const citation = { file: point.citation.file, start: point.citation.lines[0], end: point.citation.lines[1], lines: lines.slice(point.citation.lines[0] - 1, point.citation.lines[1]) };
          try {
            entries.set(c.id, await writer.write(c, undefined, { description: point.description, citation }));
          } catch (err) {
            if (!(err instanceof LLMBudgetExceededError)) throw err;
            spend.capped = true;
          }
        }),
      );
      await writeScenarioFiles(dir, cases, entries, suiteManifest.generationRef, suiteManifest.helpersHash);
      timing.scriptsMs += Date.now() - scriptsStarted;
      await app.stop();
      app = undefined;

      const passed: string[] = [];
      for (const c of roundCases) {
        const e = entries.get(c.id);
        if (!e) dropped.push({ id: c.id, reason: 'not-run', detail: 'the cost cap was reached before its script was written' });
        else if (e.validationOutcome === 'passed') passed.push(c.id);
        else if (e.validationOutcome === 'assertion_failed') dropped.push({ id: c.id, reason: 'assertion_failed', detail: e.attemptLog.at(-1)?.error?.split('\n')[0] ?? '' });
        else dropped.push({ id: c.id, reason: 'invalid', detail: `${e.failureCategory ?? 'no-submit'}: ${e.attemptLog.at(-1)?.error?.split('\n')[0] ?? ''}` });
      }
      for (const id of passed) {
        const text = await readFile(path.join(scriptsDir, `${id}.spec.ts`), 'utf8');
        if ([config.goldenRef, manifest.generationRef].some((ref) => new RegExp(`\\b${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text))) {
          dropped.push({ id, reason: 'invalid', detail: `the script names the version it was written on ("${manifest.generationRef}"); an execution must not show it` });
          passed.splice(passed.indexOf(id), 1);
        }
      }

      // 3. Two more runs on the correct version; scenarios that behave differently are dropped.
      if (passed.length > 0 && !options.signal?.aborted) {
        const stabilityStarted = Date.now();
        log(`Round ${round}: running ${passed.length} passing scenarios ${CHECK_RUNS} times on the correct version`);
        const checkDir = path.join('scenarios', `check-${round}`);
        await writeCheckFolder(paths.dir, checkDir, scriptsDir, passed, entries, cases, suiteManifest.generationRef);
        const runs: CheckRun[] = [];
        for (let n = 1; n <= CHECK_RUNS; n++) {
          const execId = `scenario-check-${round}-${n}`;
          runs.push(
            options.runCheck
              ? await options.runCheck({ runDir: paths.dir, scriptsDir: checkDir, execId })
              : await checkRun({ runDir: paths.dir, scriptsDir: checkDir, execId, config, repoDir, targetDir, generationRef: manifest.generationRef, moveTo: path.join(paths.dir, checkDir, `run-${n}`), ...(options.signal ? { signal: options.signal } : {}), log }),
          );
        }
        const unstable = unstableScenarios(passed, runs[0]!, runs[1]!);
        dropped.push(...unstable);
        const gone = new Set(unstable.map((d) => d.id));
        kept.push(...roundCases.filter((c) => passed.includes(c.id) && !gone.has(c.id)));
        timing.stabilityMs += Date.now() - stabilityStarted;
      }
      log(`Round ${round}: ${kept.length} scenarios kept so far, ${dropped.length} dropped`);
      if (kept.length >= cap) break;
    }

    // 4. The combined suite: the original scripts unchanged plus the kept scenarios.
    if (kept.length > 0) {
      combined = await combineSuite({ runDir: paths.dir, scenarioScriptsDir: scriptsDir, kept, entries });
      log(`Wrote ${combined.scriptsDir}/: ${combined.tc} TC and ${combined.sc} SC scripts`);
    } else warnings.push('No scenario was kept: no combined suite was written');
    const summary = await writeSummary('done');
    return { runId: folder, summary, summaryFile };
  } catch (err) {
    const error = options.signal?.aborted ? 'Interrupted' : errorSummary(err);
    await writeSummary('failed', error).catch(() => undefined);
    throw err;
  } finally {
    await app?.stop();
  }
}

/** scenarios/scenarios.json, scenarios/scripts/manifest.json and cases.json, written after every round. */
async function writeScenarioFiles(
  dir: string,
  cases: readonly ScenarioCase[],
  entries: ReadonlyMap<string, ScriptManifestEntry>,
  generationRef: string,
  helpersHash: string | undefined,
): Promise<void> {
  await writeFile(path.join(dir, 'scenarios.json'), `${JSON.stringify(ScenarioCases.parse({ schemaVersion: '1.0', generatedAt: new Date().toISOString(), cases }), null, 2)}\n`);
  const scripts = cases.flatMap((c) => (entries.has(c.id) ? [entries.get(c.id)!] : []));
  const manifest = ScriptManifest.parse({ schemaVersion: '1.0', generationRef, ...(helpersHash ? { helpersHash } : {}), scripts });
  await writeFile(path.join(dir, 'scripts', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(dir, 'scripts', 'cases.json'), `${JSON.stringify(suiteCases([], cases), null, 2)}\n`);
}

/** A scripts folder with only the given scenario scripts (passed in their dry run), for the check runs. */
async function writeCheckFolder(runDir: string, checkDir: string, scriptsDir: string, ids: readonly string[], entries: ReadonlyMap<string, ScriptManifestEntry>, cases: readonly ScenarioCase[], generationRef: string): Promise<void> {
  const out = path.join(runDir, checkDir);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  for (const name of ['_helpers.ts', '_target.json']) if (await exists(path.join(scriptsDir, name))) await copyFile(path.join(scriptsDir, name), path.join(out, name));
  for (const id of ids) await copyFile(path.join(scriptsDir, `${id}.spec.ts`), path.join(out, `${id}.spec.ts`));
  const scripts = ids.map((id) => ({ ...entries.get(id)!, file: `${checkDir.split(path.sep).join('/')}/${id}.spec.ts` }));
  await writeFile(path.join(out, 'manifest.json'), `${JSON.stringify(ScriptManifest.parse({ schemaVersion: '1.0', generationRef, scripts }), null, 2)}\n`);
  await writeFile(path.join(out, 'cases.json'), `${JSON.stringify(suiteCases([], cases.filter((c) => ids.includes(c.id))), null, 2)}\n`);
}

/**
 * One check run: the folder's scripts executed on the correct version by the Execution Engine with responses recorded,
 * from a source tree like any execution. The execution folder then moves into the scenarios folder, so it is never
 * listed in run.json or taken for an execution of the suite.
 */
async function checkRun(input: {
  runDir: string;
  scriptsDir: string;
  execId: string;
  config: TargetConfig;
  repoDir: string;
  targetDir: string;
  generationRef: string;
  moveTo: string;
  signal?: AbortSignal;
  log: (message: string) => void;
}): Promise<CheckRun> {
  const result = await executeVersion({
    runDir: input.runDir,
    config: input.config,
    repoDir: input.repoDir,
    targetDir: input.targetDir,
    request: { execId: input.execId, ref: input.generationRef, scriptsDir: input.scriptsDir.split(path.sep).join('/') },
    generationRef: input.generationRef,
    recordResponses: true,
    ...(input.signal ? { signal: input.signal } : {}),
    log: input.log,
  });
  const responses = result.responses ? await readResponsesFile(result.responses.file) : [];
  await rm(input.moveTo, { recursive: true, force: true });
  await rename(path.join(input.runDir, 'executions', input.execId), input.moveTo);
  return { results: result.results, responses };
}

/** Lines for a person. */
export function describeScenarios(s: ScenarioSummary): string[] {
  const byReason = s.dropped.reduce<Record<string, number>>((o, d) => ({ ...o, [d.reason]: (o[d.reason] ?? 0) + 1 }), {});
  return [
    `${s.points.total} variation points (${Object.entries(s.points.byKind).map(([k, n]) => `${k} ${n}`).join(', ')}); ${s.written} scenario scripts written, ${s.kept.length} kept (cap ${s.cap})`,
    `dropped: ${s.dropped.length}${s.dropped.length ? ` (${Object.entries(byReason).map(([k, n]) => `${k} ${n}`).join(', ')})` : ''}`,
    `discovery: ${s.discovery.sessions} sessions, ${s.discovery.failedSessions} failed, ${s.discovery.rejected} submits rejected by the checks`,
    `${s.calls} model calls, cost $${s.costUsd.toFixed(4)} of a $${s.costCapUsd?.toFixed(2) ?? '?'} cap; discovery ${Math.round(s.timing.discoveryMs / 1000)} s, scripts ${Math.round(s.timing.scriptsMs / 1000)} s, check runs ${Math.round(s.timing.stabilityMs / 1000)} s`,
    s.combined ? `combined suite: ${s.combined.scriptsDir}/ (${s.combined.tc} TC + ${s.combined.sc} SC scripts); run it with agent execute --scripts-dir ${s.combined.scriptsDir}` : 'no combined suite',
    ...s.warnings.map((w) => `Warning: ${w}`),
  ];
}
