import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRepoTools, type RepoScope } from '../../agent/tools/repo-tools.js';
import { runAgent } from '../../agent/runtime.js';
import { AgentBudgetError, AgentSubmitError } from '../../agent/types.js';
import { readCallLog } from '../../llm/call-log.js';
import { createLLMClient } from '../../llm/client.js';
import type { LLMClient } from '../../llm/types.js';
import { loadLLMConfig, type LLMConfig } from '../../shared/config.js';
import { PRICING_FILE, PROJECT_ROOT, RUNS_DIR, runPaths } from '../../shared/paths.js';
import { errorSummary, latestRunWith, readRunManifest, setExecution } from '../../shared/run-manifest.js';
import { Diagnoses, ExecutionResults, Prd, SCHEMA_VERSION, ScriptManifest, TestCases } from '../../shared/schemas.js';
import type { Diagnosis, DiagnosesSummary, RunExecution, TestResult } from '../../shared/schemas.js';
import { loadTargetConfig } from '../../shared/target-config.js';
import { buildSourceTree } from '../execution-engine/source-tree.js';
import { checkDiagnoses, SubmitDiagnoses, type DiagnosisDraft } from './checks.js';
import { suggestsInstability } from '../script-generator/classify.js';
import { groupDifferences, readComparison, type DifferenceEvidence } from './differences.js';
import { buildDifferenceTask, buildGroupTask, buildNoToolsSystemPrompt, buildNoToolsTask, buildSystemPrompt } from './prompt.js';
import { createAnalyzerTools, type AnalysisContext } from './tools.js';
import { triage, type FailureGroup } from './triage.js';

/** SPEC §8.1: 25 tool calls per group. */
export const ANALYZER_BUDGET = { maxToolCalls: 25 };
/** No tools: only the submit (with its retries). */
const NO_TOOLS_BUDGET = { maxToolCalls: 1, maxTurns: 6 };

export interface AnalyzeOptions {
  /** Default: the newest run with a scripts/manifest.json. */
  runId?: string;
  /** Default: the run's last execution that is done. */
  execId?: string;
  /** The ablation (SPEC §11.6): no tools, only the failing tests' titles and errors. */
  noTools?: boolean;
  runsDir?: string;
  targetsDir?: string;
  projectRoot?: string;
  llmConfig?: LLMConfig;
  createLlm?: (config: LLMConfig, callLogFile: string) => Promise<LLMClient>;
  log?: (message: string) => void;
  /**
   * A comparison of this execution with a reference run (SPEC §7.6, §8.5): its strong differences are
   * added as evidence to failing tests, and passing tests that differ get sessions of their own.
   */
  differencesFile?: string;
  /** The file name to write in the execution folder (default diagnoses.json, or diagnoses.differential.json with differences). Run.json's analyze status is only set for the default. */
  outputName?: string;
}

export interface AnalyzeResult {
  runId: string;
  execId: string;
  file: string;
  diagnoses: Diagnoses;
}

interface GroupOutcome {
  drafts: Array<Omit<Diagnosis, 'id'>>;
  turns: number;
  toolCalls: number;
  /** Set when the session ended without an accepted submit. */
  failure?: string;
}

interface SessionDeps {
  differences?: DifferenceEvidence;
  llm: LLMClient;
  llmConfig: LLMConfig;
  transcriptsDir: string;
  ctx: AnalysisContext;
  scope: RepoScope;
  failures: ReadonlyMap<string, TestResult>;
  noTools: boolean;
  unstable: ReadonlyMap<string, string>;
}

/** What a session diagnoses: a group of failing tests, or a group of passing tests that differ from a reference run. */
type SessionGroup = { basis: 'failure'; group: FailureGroup } | { basis: 'difference'; group: DifferenceEvidence['groups'][number] };

/** One agent session for one group (SPEC §8.1 steps 2–4, §8.5); a failed session gives an inconclusive diagnosis. */
async function diagnoseGroup(session: SessionGroup, deps: SessionDeps): Promise<GroupOutcome> {
  const { ctx } = deps;
  const { group } = session;
  const started = Date.now();
  const otherFailures = deps.failures.size - (session.basis === 'failure' ? group.testCaseIds.length : 0);
  const basis = deps.differences ? { basis: session.basis } : {};
  const toDiagnosis = (d: DiagnosisDraft, toolCalls: number, durationMs: number): Omit<Diagnosis, 'id'> => ({
    testCaseIds: d.testCaseIds,
    classification: d.classification,
    confidence: d.confidence,
    summary: d.summary,
    rootCause: d.rootCause,
    location: d.location,
    evidence: d.evidence,
    violatedRequirementIds: d.violatedRequirementIds,
    suggestedFix: d.suggestedFix,
    toolCalls,
    durationMs,
    ...basis,
  });
  const task = deps.noTools
    ? buildNoToolsTask({ group: group as FailureGroup, failures: deps.failures, testCases: ctx.testCases })
    : session.basis === 'difference'
      ? buildDifferenceTask({ group: session.group, testCases: ctx.testCases, environment: ctx.environment, failingTests: deps.failures.size })
      : buildGroupTask({
          group: session.group,
          failures: deps.failures,
          testCases: ctx.testCases,
          environment: ctx.environment,
          otherFailures,
          unstable: deps.unstable,
          ...(deps.differences ? { differences: deps.differences.byFailingTest } : {}),
        });
  try {
    const result = await runAgent(
      {
        purpose: 'analyzer',
        system: deps.noTools ? buildNoToolsSystemPrompt() : buildSystemPrompt({ differences: deps.differences !== undefined }),
        task,
        tools: deps.noTools ? [] : [...createAnalyzerTools(ctx), ...createRepoTools(deps.scope)],
        submit: {
          name: 'submit_diagnoses',
          description: deps.differences
            ? 'Submit the diagnoses for your group of tests. Every test of the group in exactly one diagnosis.'
            : 'Submit the diagnoses for your group of failing tests. Every test of the group in exactly one diagnosis.',
          schema: SubmitDiagnoses,
          validate: (submit) => checkDiagnoses(submit, { groupTestIds: group.testCaseIds, scope: deps.scope, prd: ctx.prd }),
        },
        budget: deps.noTools ? NO_TOOLS_BUDGET : ANALYZER_BUDGET,
      },
      { llm: deps.llm, contextTokens: deps.llmConfig.contextTokens, transcriptDir: deps.transcriptsDir },
    );
    return {
      drafts: result.output.diagnoses.map((d) => toDiagnosis(d, result.toolCalls, result.durationMs)),
      turns: result.turns,
      toolCalls: result.toolCalls,
    };
  } catch (err) {
    if (!(err instanceof AgentSubmitError || err instanceof AgentBudgetError)) throw err;
    const failure = errorSummary(err);
    const durationMs = Date.now() - started;
    return {
      drafts: [
        {
          testCaseIds: group.testCaseIds,
          classification: 'inconclusive',
          confidence: 0,
          summary: 'The analysis of this group ended without an accepted diagnosis.',
          rootCause: failure,
          location: null,
          evidence: [],
          violatedRequirementIds: [],
          suggestedFix: null,
          toolCalls: err.details.toolCalls,
          durationMs,
          ...basis,
        },
      ],
      turns: err.details.turns,
      toolCalls: err.details.toolCalls,
      failure,
    };
  }
}

/**
 * Tests whose script was unstable when it was validated on the generation version (scripts/manifest.json): it passed only
 * after earlier dry runs of it failed, with what failed. Empty without a readable manifest.
 */
export async function unstableTests(manifestFile: string): Promise<Map<string, string>> {
  const manifest = ScriptManifest.safeParse(await readFile(manifestFile, 'utf8').then((t) => JSON.parse(t) as unknown, () => null));
  const out = new Map<string, string>();
  if (!manifest.success) return out;
  for (const e of manifest.data.scripts) {
    if (!e.unstable) continue;
    const failed = e.attemptLog.filter(suggestsInstability);
    out.set(e.testCaseId, `on the correct version its script ${failed.map((a) => (a.category === 'timeout' ? 'timed out' : 'hit a browser or network error')).join(' and ')} before it passed`);
  }
  return out;
}

/** The execution to analyse: the given id, or the run's last one that is done. */
function pickExecution(executions: RunExecution[], execId?: string): RunExecution {
  const entry = execId ? executions.find((e) => e.execId === execId) : executions.filter((e) => e.executeStatus === 'done').at(-1);
  if (!entry) throw new Error(execId ? `No execution ${execId} in run.json` : 'No finished execution in run.json; run "agent execute" first');
  if (entry.executeStatus !== 'done') throw new Error(`Execution ${entry.execId} is ${entry.executeStatus}, not done`);
  return entry;
}

/**
 * Module 5 (SPEC §8): triage in code, then one agent session per group of failures (in parallel up to
 * LLM_CONCURRENCY), each reading only this execution's evidence and a source tree of the executed
 * version, rebuilt here from the commit and patch in run.json. Only this function sees the commit and
 * patch; the sessions see the tree. Writes diagnoses.json (or diagnoses.no-tools.json).
 */
export async function analyzeExecution(options: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  const log = options.log ?? (() => {});
  const runsDir = options.runsDir ?? RUNS_DIR;
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const noTools = options.noTools ?? false;
  const runId = options.runId ?? (await latestRunWith(path.join('scripts', 'manifest.json'), runsDir));
  if (!runId) throw new Error(`No run with a scripts/manifest.json in ${runsDir}`);
  const paths = runPaths(runId, runsDir);
  const manifest = await readRunManifest(paths.runJson);
  const entry = pickExecution(manifest.executions, options.execId);
  const execId = entry.execId;
  const results = ExecutionResults.parse(JSON.parse(await readFile(paths.results(execId), 'utf8')));
  const prd = Prd.parse(JSON.parse(await readFile(paths.prd, 'utf8')));
  const testCases = TestCases.parse(JSON.parse(await readFile(paths.testCases, 'utf8'))).testCases;
  const { config, repoDir } = await loadTargetConfig(manifest.target, {
    ...(options.targetsDir ? { targetsDir: options.targetsDir } : {}),
    projectRoot,
  });
  if (options.differencesFile && noTools) throw new Error('Comparator differences need the tools; they cannot be used with --no-tools');
  if (options.outputName && !/^diagnoses[\w.-]*\.json$/.test(options.outputName)) throw new Error(`The output name must look like diagnoses<something>.json: ${options.outputName}`);
  const defaultName = noTools ? 'diagnoses.no-tools.json' : options.differencesFile ? 'diagnoses.differential.json' : 'diagnoses.json';
  const file = path.join(paths.executionDir(execId), options.outputName ?? defaultName);
  const startedAt = new Date();
  const setStatus = async (analyzeStatus: RunExecution['analyzeStatus'], error?: string) => {
    // The ablation, a differential analysis and a named output only write their file.
    if (noTools || options.differencesFile || options.outputName) return;
    const { error: _old, ...rest } = entry;
    await setExecution(paths.dir, { ...rest, analyzeStatus, ...(error ? { error } : {}) });
  };

  await setStatus('running');
  try {
    const tri = triage(results);
    const failures = new Map(tri.failures.map((r) => [r.testCaseId, r]));
    const differences = options.differencesFile ? groupDifferences(await readComparison(options.differencesFile), new Set(failures.keys())) : undefined;
    const sessions: SessionGroup[] = [
      ...tri.groups.map((group) => ({ basis: 'failure' as const, group })),
      ...(differences?.groups ?? []).map((group) => ({ basis: 'difference' as const, group })),
    ];
    log(
      `${execId}: ${tri.failures.length} failing tests in ${tri.groups.length} groups${noTools ? ' (no tools)' : ''}` +
        (differences ? `; ${differences.all.length} strong differences (${differences.weak} weak not analysed), ${differences.groups.length} difference groups${differences.leftOut > 0 ? `, ${differences.leftOut} left out by the cap` : ''}` : ''),
    );

    let outcomes: GroupOutcome[] = [];
    if (sessions.length > 0) {
      // The executed version's code, rebuilt from its commit and patch; removed afterwards.
      const tree = await buildSourceTree({
        repoDir,
        commit: entry.commit,
        ...(entry.patch ? { patchFile: path.resolve(projectRoot, entry.patch) } : {}),
      });
      try {
        const llmConfig = options.llmConfig ?? (await loadLLMConfig());
        const llm = options.createLlm
          ? await options.createLlm(llmConfig, paths.llmCalls)
          : await createLLMClient(llmConfig, { callLogFile: paths.llmCalls, pricingFile: PRICING_FILE });
        const ctx: AnalysisContext = {
          execDir: paths.executionDir(execId),
          scriptsDir: paths.scriptsDir,
          results,
          environment: tri.environment,
          testCases: new Map(testCases.map((tc) => [tc.id, tc])),
          prd,
          ...(differences ? { differences: differences.all } : {}),
        };
        const unstable = await unstableTests(paths.scriptsManifest);
        const deps: SessionDeps = {
          llm,
          llmConfig,
          transcriptsDir: paths.transcriptsDir,
          ctx,
          scope: { root: tree.dir, forbiddenPaths: config.forbiddenPaths },
          failures,
          noTools,
          unstable,
          ...(differences ? { differences } : {}),
        };
        outcomes = await Promise.all(sessions.map((session) => diagnoseGroup(session, deps)));
      } finally {
        await tree.remove();
      }
    }

    const diagnoses: Diagnosis[] = outcomes.flatMap((o) => o.drafts).map((d, i) => ({ id: `DX-${String(i + 1).padStart(3, '0')}`, ...d }));
    const calls = (await readCallLog(paths.llmCalls)).lines.filter((l) => l.purpose === 'analyzer' && l.ts >= startedAt.toISOString());
    const costs = calls.map((l) => l.costUsd).filter((c): c is number => c !== null);
    const summary: DiagnosesSummary = {
      groups: tri.groups.length,
      sessions: outcomes.length,
      failedSessions: outcomes.filter((o) => o.failure).length,
      calls: outcomes.reduce((n, o) => n + o.turns, 0),
      toolCalls: outcomes.reduce((n, o) => n + o.toolCalls, 0),
      costUsd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null,
      durationMs: Date.now() - startedAt.getTime(),
      // Only a differential analysis writes these, so a plain analysis writes the same file as before.
      ...(differences ? { differenceGroups: differences.groups.length, differenceGroupsLeftOut: differences.leftOut } : {}),
    };
    const output = Diagnoses.parse({
      schemaVersion: SCHEMA_VERSION,
      execId,
      mode: noTools ? 'no-tools' : 'full',
      generatedAt: new Date().toISOString(),
      diagnoses,
      summary,
      ...(differences ? { withDifferences: true } : {}),
    });
    await writeFile(file, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    await setStatus('done');
    for (const o of outcomes) if (o.failure) log(`Warning: a session failed (${o.failure}); its tests are marked inconclusive`);
    return { runId, execId, file, diagnoses: output };
  } catch (err) {
    await setStatus('failed', errorSummary(err));
    throw err;
  }
}

/** Lines for the CLI: counts by classification, sessions, calls and cost. */
export function describeAnalysis(result: AnalyzeResult): string[] {
  const { diagnoses, summary } = result.diagnoses;
  const by = new Map<string, number>();
  for (const d of diagnoses) by.set(d.classification, (by.get(d.classification) ?? 0) + 1);
  const lines = [
    `${diagnoses.length} diagnoses${by.size > 0 ? ` (${[...by].map(([k, n]) => `${k} ${n}`).join(', ')})` : ''} for ${diagnoses.reduce((n, d) => n + d.testCaseIds.length, 0)} ${result.diagnoses.withDifferences ? 'tests' : 'failing tests'}`,
  ];
  if (summary) {
    const cost = summary.costUsd === null ? 'unknown' : `$${summary.costUsd.toFixed(4)}`;
    lines.push(`${summary.groups}${summary.differenceGroups ? ` failure groups + ${summary.differenceGroups} difference groups` : ' groups'}, ${summary.calls} model calls, ${summary.toolCalls} tool calls, cost ${cost}, ${Math.round(summary.durationMs / 1000)} s`);
    if (summary.failedSessions > 0) lines.push(`Warning: ${summary.failedSessions} sessions ended without an accepted diagnosis (marked inconclusive)`);
  }
  for (const d of diagnoses) {
    const where = d.location ? ` @ ${d.location.file}:${d.location.lines[0]}-${d.location.lines[1]}` : '';
    lines.push(`${d.id} ${d.classification} (${d.confidence}) ${d.testCaseIds.join(', ')}${where}: ${d.summary}`);
  }
  return lines;
}
