import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
  PageCoverage,
  PageSnapshotEntry,
  PrdRequirement,
  StageGenerationSummary,
  TargetConfig,
  TargetFacts,
  PartlyCoveredRequirement,
  TestCase,
  UncoveredRequirement,
} from '../../shared/schemas.js';
import { loadTargetConfig } from '../../shared/target-config.js';
import { blankInputProblems, checkSubmission, matchEndpoint, missingNegativeCases, openablePages, pagesOpened, stepPaths, stepRequests, SubmitTestCases, templateMatches, toTestCase } from './checks.js';
import type { TestCaseDraft } from './checks.js';
import { buildFeatureTask, buildGrounding, collectEvidence, linesAtCommit } from './context.js';
import { readFacts } from '../execution-engine/facts.js';
import { Transcript } from '../../agent/transcript.js';
import type { ReadLines } from './context.js';
import { buildSystemPrompt } from './prompt.js';
import { collectPageSnapshots, renderPageSnapshots, snapshotProblems, snapshotRequests, type TakeSnapshots } from './pages.js';
import { pageSnapshots as takePageSnapshots } from '../execution-engine/probe.js';
import { startTarget } from '../execution-engine/lifecycle.js';

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
  /** For tests: replaces starting the app at the generation ref for the page snapshots (default: the Execution Engine lifecycle). */
  startApp?: (config: TargetConfig, ref: string, logsDir: string) => Promise<{ stop(): Promise<void> }>;
  /** For tests: replaces taking page snapshots on the running app (default: the Execution Engine's pageSnapshots). */
  takeSnapshots?: TakeSnapshots;
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

export interface SessionOutcome {
  cases: TestCaseDraft[];
  declined: UncoveredRequirement[];
  turns: number;
  submitStats: SubmitStats;
  /** Set when the session ended without an accepted submission. */
  failure?: string;
  /** The problems of its last rejected submit, passed on to the gap round so it does not repeat them. */
  lastProblems?: string[];
}

export interface SessionInput {
  feature: Prd['features'][number];
  requirements: PrdRequirement[];
  quota: number;
  gapRound: boolean;
  previousProblems?: string[];
  /** Page round: pages no test case opens yet; the session must open each one or decline a requirement naming it. */
  pageRound?: string[];
  /** Endpoint round (gaps stage): endpoints no passing script reached; each is called by an api case or a requirement describing it is declined. */
  endpointRound?: Array<Prd['apiEndpoints'][number]>;
}

export interface SessionDeps {
  /** The call log purpose (default "cases"). */
  purpose?: string;
  llm: LLMClient;
  llmConfig: LLMConfig;
  config: TargetConfig;
  read: ReadLines;
  transcriptsDir: string;
  facts: TargetFacts | null;
  endpoints: Prd['apiEndpoints'];
  pages: Prd['uiRoutes'];
  pageSnapshots: PageSnapshotEntry[];
}

export async function runSession(input: SessionInput, deps: SessionDeps): Promise<SessionOutcome> {
  const evidence = await collectEvidence(input.requirements, deps.read);
  const grounding = buildGrounding(evidence, deps.config, deps.facts);
  const { endpointRound, ...taskInput } = input;
  try {
    const result = await runAgent(
      {
        purpose: deps.purpose ?? 'cases',
        system: buildSystemPrompt(),
        task: buildFeatureTask({
          ...taskInput,
          evidence,
          config: deps.config,
          facts: deps.facts,
          endpoints: deps.endpoints,
          pages: deps.pages,
          pageSnapshots: renderPageSnapshots(deps.pageSnapshots, input.requirements),
          ...(endpointRound ? { endpointRound: endpointRound.map((e) => `${e.method} ${e.path}`) } : {}),
        }),
        tools: [],
        submit: {
          name: 'submit_test_cases',
          description: 'Submit the test cases for these requirements, and the requirements you decline with a reason.',
          schema: SubmitTestCases,
          validate: (sub) => [
            ...checkSubmission(sub, {
              requirements: input.requirements,
              fixtures: deps.config.fixtures,
              grounding,
              quota: input.quota,
              api: {
                endpoints: deps.endpoints,
                apiPrefix: deps.config.backend.apiPrefix,
                ...(deps.config.auth && !('command' in deps.config.auth.login) ? { loginPath: deps.config.auth.login.path } : {}),
                accountResources: deps.config.accountResources,
              },
              pages: deps.pages.map((p) => p.path),
            }),
            ...(input.pageRound ? pageRoundProblems(sub, input.pageRound, input.requirements) : []),
            ...(endpointRound ? endpointRoundProblems(sub, endpointRound, input.requirements, deps.endpoints, deps.config.backend.apiPrefix) : []),
            // Boundary values for text: in the first and gap sessions (page and endpoint rounds have their own task).
            ...(input.pageRound || endpointRound ? [] : blankInputProblems(sub, evidence.blocks)),
            ...snapshotProblems(sub, deps.pageSnapshots),
          ],
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

/** Whether a requirement names a page: its statement or a criterion contains a path that fits the page's route. */
export function namesPage(r: PrdRequirement, page: string): boolean {
  return stepPaths([r.statement, ...r.acceptanceCriteria.map((c) => c.text)]).some((p) => templateMatches(page, p));
}

/** Page round: every page asked for is opened by a submitted ui case, or a requirement naming it is declined. */
export function pageRoundProblems(sub: SubmitTestCases, pages: readonly string[], requirements: readonly PrdRequirement[]): string[] {
  const opened = new Set(sub.testCases.filter((c) => c.layer === 'ui').flatMap((c) => pagesOpened(c.steps, pages)));
  const declined = new Set(sub.declined.map((d) => d.requirementId));
  return pages
    .filter((page) => !opened.has(page) && !requirements.some((r) => declined.has(r.id) && namesPage(r, page)))
    .map((page) => `No ui test case opens ${page}; add one that names it in a step (e.g. "Open ${page}"), or decline the requirement that describes it with the reason`);
}

/**
 * Whether a requirement describes an endpoint: its statement or a criterion names the endpoint's method and path, or
 * a criterion's evidence overlaps the endpoint's evidence.
 */
export function describesEndpoint(r: PrdRequirement, endpoint: Prd['apiEndpoints'][number], endpoints: Prd['apiEndpoints']): boolean {
  const named = stepRequests([r.statement, ...r.acceptanceCriteria.map((c) => c.text)]).some((q) => matchEndpoint(q.method, q.path, endpoints) === endpoint);
  if (named) return true;
  return r.acceptanceCriteria.some((c) =>
    c.evidence.some((ev) => endpoint.evidence.some((ee) => ee.file === ev.file && ev.lines[0] <= ee.lines[1] && ee.lines[0] <= ev.lines[1])),
  );
}

/** Leading path segments that are not parameters (`:id`, `{id}`, `<id>`), after the API prefix. */
function literalSegments(endpointPath: string, apiPrefix: string): string[] {
  const prefix = apiPrefix.split('/').filter(Boolean).length;
  const segments = endpointPath.split('/').filter(Boolean).slice(prefix);
  const end = segments.findIndex((s) => /^[:{<]/.test(s));
  return end < 0 ? segments : segments.slice(0, end);
}

/**
 * Whether two endpoints belong to one resource: their paths share at least two leading literal segments after the API
 * prefix (`/links/admin/{id}` and `/links/admin/ban/{id}`; not `/links/{id}` and `/links/{id}/stats`).
 */
export function sharesResource(a: Prd['apiEndpoints'][number], b: Prd['apiEndpoints'][number], apiPrefix: string): boolean {
  const x = literalSegments(a.path, apiPrefix);
  const y = literalSegments(b.path, apiPrefix);
  let shared = 0;
  while (shared < x.length && shared < y.length && x[shared] === y[shared]) shared++;
  return shared >= 2;
}

/**
 * Whether a requirement describes an endpoint or another endpoint of the same resource (the second tier of the
 * endpoint round: a requirement about adding a domain as an admin is the closest requirement for deleting one).
 */
export function relatesToEndpoint(r: PrdRequirement, endpoint: Prd['apiEndpoints'][number], endpoints: Prd['apiEndpoints'], apiPrefix: string): boolean {
  return describesEndpoint(r, endpoint, endpoints) || endpoints.some((s) => s !== endpoint && sharesResource(s, endpoint, apiPrefix) && describesEndpoint(r, s, endpoints));
}

/** Endpoint round: every endpoint asked for is called by a submitted api case, or a requirement describing it is declined. */
export function endpointRoundProblems(
  sub: SubmitTestCases,
  asked: ReadonlyArray<Prd['apiEndpoints'][number]>,
  requirements: readonly PrdRequirement[],
  endpoints: Prd['apiEndpoints'],
  apiPrefix = '',
): string[] {
  const called = new Set(
    sub.testCases.filter((c) => c.layer === 'api').flatMap((c) => stepRequests(c.steps).map((q) => matchEndpoint(q.method, q.path, endpoints))),
  );
  const declined = new Set(sub.declined.map((d) => d.requirementId));
  return asked
    .filter((e) => !called.has(e) && !requirements.some((r) => declined.has(r.id) && relatesToEndpoint(r, e, endpoints, apiPrefix)))
    .map(
      (e) =>
        `No api test case calls ${e.method} ${e.path}; add one with a step that sends it (e.g. "Send ${e.method} ${e.path}" with real values for its parameters) and checks what it returns, or decline the requirement that describes it with the reason`,
    );
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

  const { config, repoDir, targetDir } = await loadTargetConfig(manifest.target, {
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
    // F: the pages of ui/e2e requirements as golden shows them, taken once per run (the app only starts when pages are missing).
    const requests = snapshotRequests(prd, config);
    const { snapshots, taken } = await collectPageSnapshots({
      runDir: paths.dir,
      generationCommit: manifest.generationCommit,
      requests,
      config,
      take: async (missing) => {
        log(`Taking ${missing.length} page snapshots at ${manifest.generationRef}`);
        const logsDir = path.join(paths.dir, 'cases-server');
        const app = options.startApp
          ? await options.startApp(config, manifest.generationRef, logsDir)
          : await startTarget(config, { ref: manifest.generationRef, generationRef: manifest.generationRef, repoDir, targetDir, logsDir, log });
        try {
          return await (options.takeSnapshots ?? takePageSnapshots)(config, missing.map((r) => ({ path: r.path, ...(r.user ? { user: r.user } : {}) })));
        } finally {
          await app.stop();
        }
      },
    });
    if (requests.length > 0) log(`Page snapshots: ${snapshots.pages.length} of ${requests.length} pages (${taken > 0 ? `${taken} taken now` : 'all reused'})`);
    const deps = { llm, llmConfig, config, read, transcriptsDir: paths.transcriptsDir, facts, endpoints: prd.apiEndpoints, pages: prd.uiRoutes, pageSnapshots: snapshots.pages };

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
    remaining -= gap.reduce((n, o) => n + o.cases.length, 0) - gapInputs.reduce((n, g) => n + g.quota, 0);

    // Page round: pages no ui case opens get one session per feature, built from the ui/e2e requirements naming them.
    const pagePaths = openablePages(prd.uiRoutes.map((p) => p.path));
    const openedBy = (outcomes: SessionOutcome[]) =>
      new Set(outcomes.flatMap((o) => o.cases).filter((c) => c.layer === 'ui').flatMap((c) => pagesOpened(c.steps, pagePaths)));
    const unopened = pagePaths.filter((page) => !openedBy([...first, ...gap]).has(page));
    const pageInputs: SessionInput[] = [];
    for (const f of features) {
      const asked = unopened.filter((page) => f.requirements.some((r) => r.layer !== 'api' && namesPage(r, page)));
      const requirements = f.requirements.filter((r) => r.layer !== 'api' && asked.some((page) => namesPage(r, page)));
      const quota = Math.min(remaining, asked.length);
      if (requirements.length === 0 || quota <= 0) continue;
      remaining -= quota;
      pageInputs.push({ feature: f.feature, requirements, quota, gapRound: true, pageRound: asked });
    }
    if (pageInputs.length > 0) log(`Page round: ${pageInputs.reduce((n, p) => n + p.pageRound!.length, 0)} pages in ${pageInputs.length} features`);
    const pageOutcomes = await Promise.all(pageInputs.map((p) => runSession(p, deps)));

    // Ids in code, after every session: feature order, then requirement order in the PRD.
    const order = new Map(prd.requirements.map((r, i) => [r.id, i]));
    const firstReq = (c: TestCaseDraft) => Math.min(...c.requirementIds.map((id) => order.get(id) ?? Infinity));
    const drafts = [...first, ...gap, ...pageOutcomes].flatMap((o) => o.cases).sort((a, b) => firstReq(a) - firstReq(b));
    const testCases: TestCase[] = drafts.map((c, i) => toTestCase(c, `TC-${String(i + 1).padStart(3, '0')}`));

    const covered = new Set(testCases.flatMap((c) => c.requirementIds));
    const allDeclined = [...first, ...gap, ...pageOutcomes].flatMap((o) => o.declined);
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
      coverage: { requirementsTotal: prd.requirements.length, requirementsCovered: covered.size, uncovered, partial, pages: pageCoverage(prd, testCases) },
    });
    await writeFile(paths.testCases, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

    const outcomes = [...first, ...gap, ...pageOutcomes];
    const warnings = [
      ...factWarnings,
      ...missingNegativeCases(prd.requirements, drafts),
      ...features.flatMap((f, i) => (first[i]!.failure ? [`${f.feature.id}: first session failed (${first[i]!.failure})`] : [])),
      ...gapInputs.flatMap((g, i) => (gap[i]!.failure ? [`${g.feature.id}: gap-round session failed (${gap[i]!.failure})`] : [])),
      ...pageInputs.flatMap((p, i) => (pageOutcomes[i]!.failure ? [`${p.feature.id}: page-round session failed (${pageOutcomes[i]!.failure})`] : [])),
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
    // A new testcases.json makes any earlier scripts, and the gaps round built on them, out of date.
    const stages = (await readRunManifest(paths.runJson)).stages;
    if (stages.scripts) await setStage(paths.dir, 'scripts', { status: 'stale' });
    if (stages.gaps) await setStage(paths.dir, 'gaps', { status: 'stale' });
    return { runId, file: paths.testCases, testCases: result, summary };
  } catch (err) {
    await setStage(paths.dir, 'cases', { status: 'failed', startedAt, finishedAt: new Date().toISOString(), error: errorSummary(err) });
    throw err;
  }
}

/**
 * Which of the PRD's pages a ui test case opens (SPEC §5), and why the others are not: no ui or e2e requirement
 * names them, or the requirements naming them got no case that opens them. A catch-all route is not counted.
 */
export function pageCoverage(prd: Prd, testCases: readonly TestCase[]): PageCoverage {
  const routes = openablePages(prd.uiRoutes.map((p) => p.path));
  const opened = new Set(testCases.filter((c) => c.layer === 'ui').flatMap((c) => pagesOpened(c.steps, routes)));
  const fragmentPaths = new Set(prd.uiRoutes.filter((r) => r.kind === 'fragment').map((r) => r.path));
  const unopenedOf = (paths: readonly string[]) =>
    paths
      .filter((page) => !opened.has(page))
      .map((path) => ({
        path,
        reason: prd.requirements.some((r) => r.layer !== 'api' && namesPage(r, path))
          ? 'The ui or e2e requirements that describe it got no test case that opens it.'
          : 'No ui or e2e requirement describes this page.',
      }));
  const pages = routes.filter((p) => !fragmentPaths.has(p));
  const fragments = routes.filter((p) => fragmentPaths.has(p));
  return {
    total: pages.length,
    opened: pages.filter((p) => opened.has(p)).length,
    unopened: unopenedOf(pages),
    ...(fragments.length > 0 ? { fragments: { total: fragments.length, opened: fragments.filter((p) => opened.has(p)).length, unopened: unopenedOf(fragments) } } : {}),
  };
}

/** Lines for a person: totals, coverage, rejections and warnings. */
export function describeCasesSummary(result: GenerateTestCasesResult): string[] {
  const { summary: s, testCases: t } = result;
  const byCategory = Object.entries(s.casesByCategory).map(([k, n]) => `${k} ${n}`).join(', ');
  const byReason = Object.entries(s.uncoveredByReasonKind).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ');
  return [
    `${t.testCases.length} test cases (api ${s.casesByLayer.api}, ui ${s.casesByLayer.ui}; ${byCategory})`,
    `coverage: ${t.coverage.requirementsCovered} of ${t.coverage.requirementsTotal} requirements; uncovered ${t.coverage.uncovered.length}${byReason ? ` (${byReason})` : ''}; partly untestable ${t.coverage.partial.length}`,
    ...(t.coverage.pages && t.coverage.pages.total > 0
      ? [
          `pages opened by a ui test case: ${t.coverage.pages.opened} of ${t.coverage.pages.total}${t.coverage.pages.unopened.length > 0 ? `; not opened: ${t.coverage.pages.unopened.map((u) => u.path).join(', ')}` : ''}`,
          ...(t.coverage.pages.fragments ? [`fragments (parts of pages) opened by a ui test case: ${t.coverage.pages.fragments.opened} of ${t.coverage.pages.fragments.total}${t.coverage.pages.fragments.unopened.length > 0 ? `; not opened: ${t.coverage.pages.fragments.unopened.map((u) => u.path).join(', ')}` : ''}`] : []),
        ]
      : []),
    `ui expectations marked afterAction (text that appears only after a step acts on the page): ${t.testCases.flatMap((c) => c.expected).filter((e) => e.afterAction === true).length}`,
    `${s.sessions} sessions, ${s.calls} model calls, cost ${s.costUsd === null ? 'unknown' : `$${s.costUsd.toFixed(4)}`}`,
    `rejected submits: ${s.rejected.invalidInput} invalid input, ${s.rejected.checkFailed} failed checks`,
    ...s.warnings.map((w) => `Warning: ${w}`),
  ];
}
