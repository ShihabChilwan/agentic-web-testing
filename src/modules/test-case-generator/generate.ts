import { readFile, writeFile } from 'node:fs/promises';
import { runAgent } from '../../agent/runtime.js';
import { AgentBudgetError, AgentSubmitError } from '../../agent/types.js';
import type { SubmitStats } from '../../agent/types.js';
import { readCallLog } from '../../llm/call-log.js';
import { createLLMClient } from '../../llm/client.js';
import type { LLMClient } from '../../llm/types.js';
import { loadLLMConfig } from '../../shared/config.js';
import type { LLMConfig } from '../../shared/config.js';
import { PRICING_FILE, RUNS_DIR, runPaths } from '../../shared/paths.js';
import { errorSummary, latestRunWith, readRunManifest, setStage } from '../../shared/run-manifest.js';
import {
  MAX_TEST_CASES,
  Prd,
  TestCases,
  TestCategory,
  TestLayer,
  UncoveredReasonKind,
} from '../../shared/schemas.js';
import type {
  PrdRequirement,
  StageGenerationSummary,
  TargetConfig,
  TargetFacts,
  PartlyCoveredRequirement,
  TestCase,
  UncoveredRequirement,
} from '../../shared/schemas.js';
import { loadTargetConfig } from '../../shared/target-config.js';
import { checkSubmission, missingNegativeCases, SubmitTestCases, toTestCase } from './checks.js';
import type { TestCaseDraft } from './checks.js';
import { buildFeatureTask, buildGrounding, collectEvidence, linesAtCommit } from './context.js';
import { readFacts } from '../execution-engine/facts.js';
import { Transcript } from '../../agent/transcript.js';
import type { ReadLines } from './context.js';
import { buildSystemPrompt } from './prompt.js';

/** One feature session needs a single submit; the extra turns cover nudges and rejected submits. */
const SESSION_BUDGET = { maxToolCalls: 1, maxTurns: 6 };

export interface GenerateTestCasesOptions {
  /** Defaults to the newest run that has a prd.json. */
  runId?: string;
  runsDir?: string;
  targetsDir?: string;
  projectRoot?: string;
  llmConfig?: LLMConfig;
  createLlm?: (config: LLMConfig, callLogFile: string) => Promise<LLMClient>;
  log?: (message: string) => void;
}

export interface GenerateTestCasesResult {
  runId: string;
  file: string;
  testCases: TestCases;
  summary: StageGenerationSummary;
}

/** Test cases each feature may submit: its share of the 150 total, never fewer than one per requirement. */
export function featureQuotas(requirementCounts: number[], total: number = MAX_TEST_CASES): number[] {
  const all = requirementCounts.reduce((a, b) => a + b, 0);
  return requirementCounts.map((n) => Math.max(n, Math.floor((total * n) / all)));
}

interface SessionOutcome {
  cases: TestCaseDraft[];
  declined: UncoveredRequirement[];
  turns: number;
  submitStats: SubmitStats;
  /** Set when the session ended without an accepted submission. */
  failure?: string;
  /** The problems of its last rejected submit, passed on to the gap round so it does not repeat them. */
  lastProblems?: string[];
}

interface SessionInput {
  feature: Prd['features'][number];
  requirements: PrdRequirement[];
  quota: number;
  gapRound: boolean;
  previousProblems?: string[];
}

async function runSession(
  input: SessionInput,
  deps: {
    llm: LLMClient;
    llmConfig: LLMConfig;
    config: TargetConfig;
    read: ReadLines;
    transcriptsDir: string;
    facts: TargetFacts | null;
    endpoints: Prd['apiEndpoints'];
  },
): Promise<SessionOutcome> {
  const evidence = await collectEvidence(input.requirements, deps.read);
  const grounding = buildGrounding(evidence, deps.config, deps.facts);
  try {
    const result = await runAgent(
      {
        purpose: 'cases',
        system: buildSystemPrompt(),
        task: buildFeatureTask({ ...input, evidence, config: deps.config, facts: deps.facts, endpoints: deps.endpoints }),
        tools: [],
        submit: {
          name: 'submit_test_cases',
          description: 'Submit the test cases for these requirements, and the requirements you decline with a reason.',
          schema: SubmitTestCases,
          validate: (sub) =>
            checkSubmission(sub, {
              requirements: input.requirements,
              fixtures: deps.config.fixtures,
              grounding,
              quota: input.quota,
            }),
        },
        budget: SESSION_BUDGET,
      },
      { llm: deps.llm, contextTokens: deps.llmConfig.contextTokens, transcriptDir: deps.transcriptsDir },
    );
    return { cases: result.output.testCases, declined: result.output.declined, turns: result.turns, submitStats: result.submitStats };
  } catch (err) {
    // A session that never got an accepted submit leaves its requirements to the gap round.
    if (err instanceof AgentSubmitError || err instanceof AgentBudgetError) {
      return {
        cases: [],
        declined: [],
        turns: err.details.turns,
        submitStats: err.details.submitStats,
        failure: errorSummary(err),
        ...(err instanceof AgentSubmitError ? { lastProblems: err.errors } : {}),
      };
    }
    throw err;
  }
}

const zeroCounts = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

/**
 * Stage 1, Module 2 (SPEC §5): one session per feature in parallel (the LLM client's limiter caps
 * concurrency), one gap round for requirements with neither a case nor a decline, ids and coverage
 * in code, then testcases.json. Evidence is read at the run's generation commit with `git show`.
 */
export async function generateTestCases(options: GenerateTestCasesOptions = {}): Promise<GenerateTestCasesResult> {
  const log = options.log ?? (() => {});
  const runsDir = options.runsDir ?? RUNS_DIR;
  const runId = options.runId ?? (await latestRunWith('prd.json', runsDir));
  if (!runId) throw new Error(`No run with a prd.json in ${runsDir}; run "agent prd" first`);
  const paths = runPaths(runId, runsDir);
  const manifest = await readRunManifest(paths.runJson).catch((err: unknown) => {
    throw new Error(`Cannot read ${paths.runJson}: ${errorSummary(err)}`, { cause: err });
  });

  const parsed = Prd.safeParse(JSON.parse(await readFile(paths.prd, 'utf8')));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(
      `${paths.prd} does not match the current prd.json format (${first?.path.join('.')}: ${first?.message}); generate a new one with "agent prd"`,
    );
  }
  const prd = parsed.data;
  if (prd.requirements.length > MAX_TEST_CASES) {
    throw new Error(`prd.json has ${prd.requirements.length} requirements; at most ${MAX_TEST_CASES} can each get a test case`);
  }

  const { config, repoDir } = await loadTargetConfig(manifest.target, {
    ...(options.targetsDir ? { targetsDir: options.targetsDir } : {}),
    ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
  });
  const llmConfig = options.llmConfig ?? (await loadLLMConfig());
  const read = linesAtCommit({ root: repoDir, forbiddenPaths: config.forbiddenPaths }, manifest.generationCommit);
  const facts = await readFacts(config.name, options.targetsDir);
  const factWarnings = !facts
    ? [`No targets/${config.name}/facts.json: sessions get no observed facts (record them with "npm run target:facts -- ${config.name}")`]
    : facts.goldenCommit !== manifest.generationCommit
      ? [`facts.json was observed at ${facts.goldenCommit.slice(0, 7)}, but this run was generated at ${manifest.generationCommit.slice(0, 7)}; the facts may be stale`]
      : [];

  const startedAt = new Date().toISOString();
  // A rerun keeps the earlier sessions' transcripts, but apart from the new ones.
  await Transcript.archive(paths.transcriptsDir, 'cases');
  await setStage(paths.dir, 'cases', { status: 'running', startedAt });
  try {
    const llm = options.createLlm
      ? await options.createLlm(llmConfig, paths.llmCalls)
      : await createLLMClient(llmConfig, { callLogFile: paths.llmCalls, pricingFile: PRICING_FILE });
    const deps = { llm, llmConfig, config, read, transcriptsDir: paths.transcriptsDir, facts, endpoints: prd.apiEndpoints };

    const features = prd.features
      .map((feature) => ({ feature, requirements: prd.requirements.filter((r) => r.featureId === feature.id) }))
      .filter((f) => f.requirements.length > 0);
    const quotas = featureQuotas(features.map((f) => f.requirements.length));
    log(`${features.length} features, ${prd.requirements.length} requirements`);

    const first = await Promise.all(
      features.map((f, i) => runSession({ ...f, quota: quotas[i]!, gapRound: false }, deps)),
    );

    // Gap round: requirements with neither a case nor a decline get one more, fresh session per feature.
    const handled = (o: SessionOutcome) => new Set([...o.cases.flatMap((c) => c.requirementIds), ...o.declined.map((d) => d.requirementId)]);
    let remaining = MAX_TEST_CASES - first.reduce((n, o) => n + o.cases.length, 0);
    const gapInputs: Array<SessionInput & { index: number }> = [];
    features.forEach((f, i) => {
      const done = handled(first[i]!);
      const gap = f.requirements.filter((r) => !done.has(r.id));
      if (gap.length === 0) return;
      // Its unused share, or at least one per open requirement, but never past the 150 total.
      const unused = quotas[i]! - first[i]!.cases.length;
      const quota = Math.min(remaining, Math.max(unused, gap.length));
      remaining -= quota;
      const previousProblems = first[i]!.lastProblems;
      if (quota > 0) {
        gapInputs.push({ feature: f.feature, requirements: gap, quota, gapRound: true, index: i, ...(previousProblems ? { previousProblems } : {}) });
      }
    });
    if (gapInputs.length > 0) log(`Gap round: ${gapInputs.reduce((n, g) => n + g.requirements.length, 0)} requirements in ${gapInputs.length} features`);
    const gap = await Promise.all(gapInputs.map((g) => runSession(g, deps)));

    // Ids in code, after every session: feature order, then requirement order in the PRD.
    const order = new Map(prd.requirements.map((r, i) => [r.id, i]));
    const firstReq = (c: TestCaseDraft) => Math.min(...c.requirementIds.map((id) => order.get(id) ?? Infinity));
    const drafts = [...first, ...gap].flatMap((o) => o.cases).sort((a, b) => firstReq(a) - firstReq(b));
    const testCases: TestCase[] = drafts.map((c, i) => toTestCase(c, `TC-${String(i + 1).padStart(3, '0')}`));

    const covered = new Set(testCases.flatMap((c) => c.requirementIds));
    const allDeclined = [...first, ...gap].flatMap((o) => o.declined);
    const declined = allDeclined.filter((d) => !covered.has(d.requirementId));
    // A decline for a covered requirement names the part that cannot be tested; keep its reason.
    const partial: PartlyCoveredRequirement[] = allDeclined
      .filter((d) => covered.has(d.requirementId))
      .map((d) => ({ requirementId: d.requirementId, reason: d.reason }))
      .sort((a, b) => (order.get(a.requirementId) ?? 0) - (order.get(b.requirementId) ?? 0));
    const declinedIds = new Set(declined.map((d) => d.requirementId));
    const uncovered: UncoveredRequirement[] = prd.requirements
      .filter((r) => !covered.has(r.id))
      .map(
        (r) =>
          declined.find((d) => d.requirementId === r.id) ?? {
            requirementId: r.id,
            reasonKind: 'other' as const,
            reason: 'No test case after the gap round.',
          },
      );

    const result = TestCases.parse({
      schemaVersion: '1.0',
      generatedAt: new Date().toISOString(),
      testCases,
      coverage: { requirementsTotal: prd.requirements.length, requirementsCovered: covered.size, uncovered, partial },
    });
    await writeFile(paths.testCases, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

    const outcomes = [...first, ...gap];
    const warnings = [
      ...factWarnings,
      ...missingNegativeCases(prd.requirements, drafts),
      ...features.flatMap((f, i) => (first[i]!.failure ? [`${f.feature.id}: first session failed (${first[i]!.failure})`] : [])),
      ...gapInputs.flatMap((g, i) => (gap[i]!.failure ? [`${g.feature.id}: gap-round session failed (${gap[i]!.failure})`] : [])),
      ...prd.requirements.filter((r) => !covered.has(r.id) && !declinedIds.has(r.id)).map((r) => `${r.id} has no test case and no reason from the model`),
    ];
    const calls = (await readCallLog(paths.llmCalls)).lines.filter((l) => l.purpose === 'cases' && l.ts >= startedAt);
    const costs = calls.map((l) => l.costUsd).filter((c): c is number => c !== null);
    const summary: StageGenerationSummary = {
      calls: outcomes.reduce((n, o) => n + o.turns, 0),
      sessions: outcomes.length,
      casesByLayer: { ...zeroCounts(TestLayer.options) },
      casesByCategory: { ...zeroCounts(TestCategory.options) },
      uncoveredByReasonKind: { ...zeroCounts(UncoveredReasonKind.options) },
      rejected: {
        invalidInput: outcomes.reduce((n, o) => n + o.submitStats.invalidInput, 0),
        checkFailed: outcomes.reduce((n, o) => n + o.submitStats.checkFailed, 0),
      },
      costUsd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null,
      warnings,
    };
    for (const c of testCases) {
      summary.casesByLayer[c.layer]++;
      summary.casesByCategory[c.category]++;
    }
    for (const u of uncovered) summary.uncoveredByReasonKind[u.reasonKind]++;

    await setStage(paths.dir, 'cases', { status: 'done', startedAt, finishedAt: new Date().toISOString(), generation: summary });
    // A new testcases.json makes any earlier scripts out of date.
    if ((await readRunManifest(paths.runJson)).stages.scripts) await setStage(paths.dir, 'scripts', { status: 'stale' });
    return { runId, file: paths.testCases, testCases: result, summary };
  } catch (err) {
    await setStage(paths.dir, 'cases', { status: 'failed', startedAt, finishedAt: new Date().toISOString(), error: errorSummary(err) });
    throw err;
  }
}

/** Lines for a person: totals, coverage, rejections and warnings. */
export function describeCasesSummary(result: GenerateTestCasesResult): string[] {
  const { summary: s, testCases: t } = result;
  const byCategory = Object.entries(s.casesByCategory).map(([k, n]) => `${k} ${n}`).join(', ');
  const byReason = Object.entries(s.uncoveredByReasonKind).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ');
  return [
    `${t.testCases.length} test cases (api ${s.casesByLayer.api}, ui ${s.casesByLayer.ui}; ${byCategory})`,
    `coverage: ${t.coverage.requirementsCovered} of ${t.coverage.requirementsTotal} requirements; uncovered ${t.coverage.uncovered.length}${byReason ? ` (${byReason})` : ''}; partly untestable ${t.coverage.partial.length}`,
    `${s.sessions} sessions, ${s.calls} model calls, cost ${s.costUsd === null ? 'unknown' : `$${s.costUsd.toFixed(4)}`}`,
    `rejected submits: ${s.rejected.invalidInput} invalid input, ${s.rejected.checkFailed} failed checks`,
    ...s.warnings.map((w) => `Warning: ${w}`),
  ];
}
