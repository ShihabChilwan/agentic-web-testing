import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Transcript } from '../../agent/transcript.js';
import { runAgent } from '../../agent/runtime.js';
import { AgentBudgetError, AgentSubmitError } from '../../agent/types.js';
import { readCallLog } from '../../llm/call-log.js';
import { createLLMClient } from '../../llm/client.js';
import type { LLMClient } from '../../llm/types.js';
import { loadLLMConfig } from '../../shared/config.js';
import type { LLMConfig } from '../../shared/config.js';
import { PRICING_FILE, RUNS_DIR, runPaths } from '../../shared/paths.js';
import { errorSummary, latestRunWith, readRunManifest, setStage } from '../../shared/run-manifest.js';
import { AttemptStage, FailureCategory, Prd, ScriptManifest, TestCases } from '../../shared/schemas.js';
import type {
  ScriptAttempt,
  ScriptManifestEntry,
  StageScriptsSummary,
  TargetConfig,
  TargetFacts,
  TestCase,
} from '../../shared/schemas.js';
import { loadTargetConfig } from '../../shared/target-config.js';
import { readFacts } from '../execution-engine/facts.js';
import { checkFixtureLogins } from '../execution-engine/guard.js';
import { startTarget } from '../execution-engine/lifecycle.js';
import { collectEvidence, linesAtCommit } from '../test-case-generator/context.js';
import type { ReadLines } from '../test-case-generator/context.js';
import { callerBlocks } from './callers.js';
import { classifyDryRun } from './classify.js';
import { Mutex, playwrightVersion, runSpec, writePlaywrightConfig } from './dry-run.js';
import type { DryRunResult } from './dry-run.js';
import { lockCheck } from './lock-check.js';
import { buildScriptTask, buildSystemPrompt } from './prompt.js';
import { bodyLineOffset, renderExpected, renderScript } from './render.js';
import { TypeChecker } from './typecheck.js';

/** Code evidence per test case (smaller than the test case stage: one requirement at a time). */
export const SCRIPT_EVIDENCE_CHAR_CAP = 25_000;
/** One submit per attempt, 3 attempts (the runtime's submit attempts are the fix loop's attempts). */
const SESSION_BUDGET = { maxToolCalls: 1, maxTurns: 8 };
const HELPERS_TEMPLATE = fileURLToPath(new URL('./template/_helpers.ts', import.meta.url));

const SubmitScript = z.object({ body: z.string().min(1).describe('The body of the test function only') });

export interface GenerateScriptsOptions {
  runId?: string;
  runsDir?: string;
  targetsDir?: string;
  projectRoot?: string;
  llmConfig?: LLMConfig;
  createLlm?: (config: LLMConfig, callLogFile: string) => Promise<LLMClient>;
  /** For tests: replaces starting the real app (defaults to the Execution Engine lifecycle). */
  startApp?: (config: TargetConfig, ref: string, logsDir: string) => Promise<RunningApp>;
  /** For tests: replaces running Playwright on one spec. */
  runDryRun?: (runDir: string, specFile: string, outputDir: string, signal?: AbortSignal) => Promise<DryRunResult>;
  /** Generate every script again instead of keeping the validated ones of an earlier, unfinished run. */
  fresh?: boolean;
  /**
   * Outcomes to generate again; scripts with other outcomes are kept (when the helpers are unchanged).
   * Default ["invalid"]: keep validated scripts, so an unfinished run resumes.
   */
  redo?: ScriptOutcome[];
  /** Aborting (e.g. Ctrl+C) writes the manifest so far, marks the stage failed and stops the app. */
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export interface GenerateScriptsResult {
  runId: string;
  manifestFile: string;
  manifest: ScriptManifest;
  summary: StageScriptsSummary;
}

/** What the stage needs from the running app. */
export interface RunningApp {
  /** Back to the clean seeded data (reset, seed, backend restart); called after every dry run. */
  restore(): Promise<{ durationMs: number }>;
  stop(): Promise<void>;
}

export const SCRIPT_OUTCOMES = ['passed', 'assertion_failed', 'invalid'] as const;
export type ScriptOutcome = (typeof SCRIPT_OUTCOMES)[number];
const outcomeOf = (e: ScriptManifestEntry): ScriptOutcome => (e.status === 'invalid' ? 'invalid' : (e.validationOutcome ?? 'invalid'));

interface Deps {
  llm: LLMClient;
  llmConfig: LLMConfig;
  config: TargetConfig;
  facts: TargetFacts | null;
  prd: Prd;
  read: ReadLines;
  repoDir: string;
  generationCommit: string;
  runDir: string;
  scriptsDir: string;
  transcriptsDir: string;
  typeChecker: TypeChecker;
  mutex: Mutex;
  runDryRun: NonNullable<GenerateScriptsOptions['runDryRun']>;
  dryRunMs: { total: number };
  app: RunningApp;
  restores: { count: number; ms: number };
  signal?: AbortSignal;
}

/** The message sent back to the model after a failed dry run. */
function dryRunFeedback(category: string, expectationId: string | null, result: DryRunResult, hasValue: boolean): string[] {
  const lines = [`The run failed (${category}${expectationId ? `, at ${expectationId}` : ''}):\n${result.message.slice(0, 2_000)}`];
  if (category === 'value-less-expect' && expectationId && !hasValue) {
    lines.push(
      `${expectationId} has no locked value. Fix the locator or the waiting only if it does not target what the description says; do not weaken the check to make it pass.`,
    );
  }
  if (result.dom) lines.push(`Page HTML at the failure (trimmed):\n${result.dom}`);
  if (result.lastResponse) lines.push(`Last API response:\n${result.lastResponse}`);
  lines.push('Fix how the test reaches its checks; EXPECTED stays as it is.');
  return lines;
}

async function generateOne(tc: TestCase, deps: Deps): Promise<ScriptManifestEntry> {
  const file = path.join(deps.scriptsDir, `${tc.id}.spec.ts`);
  const relFile = path.relative(deps.runDir, file).split(path.sep).join('/');
  const attempts: ScriptAttempt[] = [];
  let outcome: 'passed' | 'assertion_failed' | null = null;
  const valueIds = new Set(tc.expected.filter((e) => e.value !== undefined).map((e) => e.id));
  const requirements = deps.prd.requirements.filter((r) => tc.requirementIds.includes(r.id));
  const evidence = await collectEvidence(requirements, deps.read, SCRIPT_EVIDENCE_CHAR_CAP);
  const callers = await callerBlocks(tc, {
    endpoints: deps.prd.apiEndpoints,
    apiPrefix: deps.config.backend.apiPrefix,
    frontendRoots: deps.config.frontend.sourceRoots ?? [deps.config.frontend.cwd],
    scope: { root: deps.repoDir, forbiddenPaths: deps.config.forbiddenPaths },
    commit: deps.generationCommit,
    read: deps.read,
    ...(deps.config.auth ? { skip: { method: deps.config.auth.login.method, path: deps.config.auth.login.path } } : {}),
  });

  const validate = async ({ body }: { body: string }): Promise<string[]> => {
    const attempt = attempts.length + 1;
    const started = Date.now();
    let queuedMs = 0;
    const script = renderScript(tc, body);
    await writeFile(file, script, 'utf8');
    // An attempt's duration is its own work (checks and dry run), not the time spent waiting for the dry-run queue.
    const record = (stage: ScriptAttempt['stage'], error: string | null, category?: ScriptAttempt['category']) =>
      attempts.push({ attempt, stage, error, ...(category ? { category } : {}), durationMs: Date.now() - started - queuedMs });

    const typeErrors = deps.typeChecker.check(file, bodyLineOffset(tc));
    if (typeErrors.length > 0) {
      record('typecheck', typeErrors.join('\n'), 'typecheck');
      return [`The script does not compile:\n${typeErrors.map((e) => `- ${e}`).join('\n')}`];
    }
    const lockProblems = lockCheck(tc, script, body, deps.config.fixtures);
    if (lockProblems.length > 0) {
      record('lock-check', lockProblems.join('\n'), 'lock-check');
      return lockProblems;
    }
    const outputDir = path.join(deps.runDir, 'dry-runs', tc.id, `attempt-${attempt}`);
    const queued = Date.now();
    const { result, broken } = await deps.mutex.run(async () => {
      queuedMs = Date.now() - queued;
      const wall = Date.now();
      if (deps.signal?.aborted) throw new Error('Interrupted');
      const r = await deps.runDryRun(deps.runDir, file, outputDir, deps.signal);
      // Wall time, including Playwright's start-up, which dominates short tests.
      deps.dryRunMs.total += Date.now() - wall;
      // Isolation: find out whether this test broke a fixture user, then always put the data back,
      // so the next dry run starts from the clean seeded state whatever this one changed (stock, names, ...).
      const guard = await checkFixtureLogins(deps.config);
      const restored = await deps.app.restore();
      deps.restores.count++;
      deps.restores.ms += restored.durationMs;
      return { result: r, broken: guard.broken };
    });
    const verdict = classifyDryRun(result, valueIds);
    if (broken.length > 0 && verdict.kind !== 'assertion_failed') {
      const message = `This test changed fixture user${broken.length > 1 ? 's' : ''} ${broken.join(', ')}: logging in as ${broken.length > 1 ? 'them' : 'it'} failed afterwards (the data has been restored). Never change a fixture user; register a new user with uniq values and change that one.`;
      record('dry-run', message, 'fixture-mutation');
      return [message];
    }
    if (verdict.kind === 'passed') {
      record('dry-run', null);
      outcome = 'passed';
      return [];
    }
    if (verdict.kind === 'assertion_failed') {
      // A locked value was compared and differed: a real disagreement. Keep the script, stop here.
      record('dry-run', result.message.slice(0, 2_000));
      outcome = 'assertion_failed';
      return [];
    }
    record('dry-run', result.message.slice(0, 2_000), verdict.category);
    return dryRunFeedback(verdict.category, verdict.expectationId, result, verdict.expectationId ? valueIds.has(verdict.expectationId) : false);
  };

  try {
    await runAgent(
      {
        purpose: 'scripts',
        system: buildSystemPrompt(),
        task: buildScriptTask({ testCase: tc, requirements, evidence, callers, config: deps.config, facts: deps.facts, endpoints: deps.prd.apiEndpoints }),
        tools: [],
        submit: { name: 'submit_script', description: 'Submit the body of the test function.', schema: SubmitScript, validate },
        budget: SESSION_BUDGET,
      },
      { llm: deps.llm, contextTokens: deps.llmConfig.contextTokens, transcriptDir: deps.transcriptsDir },
    );
  } catch (err) {
    if (!(err instanceof AgentSubmitError || err instanceof AgentBudgetError)) throw err;
  }

  if (outcome !== null) {
    return { testCaseId: tc.id, file: relFile, status: 'validated', validationOutcome: outcome, attempts: attempts.length, attemptLog: attempts, failureCategory: null };
  }
  const last = attempts.at(-1);
  return {
    testCaseId: tc.id,
    file: relFile,
    status: 'invalid',
    validationOutcome: null,
    attempts: Math.max(attempts.length, 1),
    attemptLog: attempts.length > 0 ? attempts : [{ attempt: 1, stage: 'submit', error: 'No valid submission', category: 'no-submit', durationMs: 0 }],
    failureCategory: last?.category ?? 'no-submit',
  };
}

const zeroCounts = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

/** run.json summary for the scripts stage. */
export function scriptsSummary(
  entries: ScriptManifestEntry[],
  extra: {
    calls: number;
    costUsd: number | null;
    dryRunMs: number;
    playwrightVersion: string;
    warnings: string[];
    resumed?: number;
    restores?: number;
    restoreMs?: number;
  },
): StageScriptsSummary {
  const summary: StageScriptsSummary = {
    cases: entries.length,
    resumed: 0,
    restores: 0,
    restoreMs: 0,
    validated: { passed: 0, assertionFailed: 0 },
    invalid: 0,
    attemptsHistogram: { '1': 0, '2': 0, '3': 0 },
    failuresByStage: zeroCounts(AttemptStage.options),
    invalidByCategory: zeroCounts(FailureCategory.options),
    invalidCases: {},
    ...extra,
  };
  for (const e of entries) {
    if (e.status === 'validated') {
      if (e.validationOutcome === 'passed') summary.validated.passed++;
      else summary.validated.assertionFailed++;
    } else {
      summary.invalid++;
      const category = e.failureCategory ?? 'no-submit';
      summary.invalidByCategory[category]++;
      (summary.invalidCases[category] ??= []).push(e.testCaseId);
    }
    summary.attemptsHistogram[String(e.attempts)] = (summary.attemptsHistogram[String(e.attempts)] ?? 0) + 1;
    for (const a of e.attemptLog) if (a.category) summary.failuresByStage[a.stage]++;
  }
  return summary;
}

/** sha256 of what the scripts call into: the helpers template and the target's auth settings. */
export async function helpersHash(config: TargetConfig): Promise<string> {
  const helpers = await readFile(HELPERS_TEMPLATE, 'utf8');
  return createHash('sha256').update(helpers).update('\0').update(JSON.stringify(config.auth ?? null)).digest('hex');
}

/**
 * Validated scripts from an earlier run of the stage that can be kept as they are: the stage was not
 * marked stale, the manifest is valid and was written against the same helpers (helpersHash), and the
 * script file still holds this test case's locked block and title (so the test case has not changed).
 */
async function resumable(
  manifestFile: string,
  cases: TestCase[],
  scriptsDir: string,
  currentHelpersHash: string,
  redo: readonly ScriptOutcome[],
): Promise<{ kept: Map<string, ScriptManifestEntry>; why?: string }> {
  const kept = new Map<string, ScriptManifestEntry>();
  let previous: ScriptManifest;
  try {
    previous = ScriptManifest.parse(JSON.parse(await readFile(manifestFile, 'utf8')));
  } catch {
    return { kept };
  }
  // Scripts written against other helpers (or an older manifest without the hash) are generated again.
  if (previous.helpersHash !== currentHelpersHash) {
    return { kept, why: previous.helpersHash ? 'the helpers or auth settings changed' : 'the earlier manifest has no helpers hash' };
  }
  const byId = new Map(cases.map((tc) => [tc.id, tc]));
  for (const entry of previous.scripts) {
    const tc = byId.get(entry.testCaseId);
    if (!tc || redo.includes(outcomeOf(entry))) continue;
    const file = path.join(scriptsDir, `${tc.id}.spec.ts`);
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text && text.includes(renderExpected(tc)) && text.startsWith(`// ${tc.id}: ${tc.title}\n`)) kept.set(tc.id, entry);
  }
  return { kept };
}

/**
 * Stage 1, Module 3 (SPEC §6): starts the app once at the generation ref (a clean start), then one fix
 * loop per test case: the model writes the body, code adds the locked EXPECTED block, then typecheck,
 * lock check and a dry run (one at a time, through a mutex) decide; model calls run in parallel.
 */
export async function generateScripts(options: GenerateScriptsOptions = {}): Promise<GenerateScriptsResult> {
  const log = options.log ?? (() => {});
  const runsDir = options.runsDir ?? RUNS_DIR;
  const runId = options.runId ?? (await latestRunWith('testcases.json', runsDir));
  if (!runId) throw new Error(`No run with a testcases.json in ${runsDir}; run "agent cases" first`);
  const paths = runPaths(runId, runsDir);
  const manifest = await readRunManifest(paths.runJson);
  const parsedCases = TestCases.safeParse(JSON.parse(await readFile(paths.testCases, 'utf8')));
  if (!parsedCases.success) throw new Error(`${paths.testCases} does not match the current format; generate it again with "agent cases"`);
  const prd = Prd.parse(JSON.parse(await readFile(paths.prd, 'utf8')));
  const { config, repoDir, targetDir } = await loadTargetConfig(manifest.target, {
    ...(options.targetsDir ? { targetsDir: options.targetsDir } : {}),
    ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
  });
  const llmConfig = options.llmConfig ?? (await loadLLMConfig());
  const facts = await readFacts(config.name, options.targetsDir);
  const version = playwrightVersion();

  // Resume an earlier, unfinished run: keep its validated scripts unless the stage was marked stale
  // (new test cases) or a fresh run was asked for.
  const cases = parsedCases.data.testCases;
  const previousStatus = manifest.stages.scripts?.status;
  const hash = await helpersHash(config);
  const redo = options.redo ?? ['invalid'];
  const resume =
    options.fresh || previousStatus === 'stale'
      ? { kept: new Map<string, ScriptManifestEntry>() }
      : await resumable(paths.scriptsManifest, cases, paths.scriptsDir, hash, redo);
  const kept = resume.kept;
  const resumeWarnings = resume.why && options.redo ? [`--redo ignored: ${resume.why}, so every script was generated again`] : [];
  if (resume.why) log(`Generating every script: ${resume.why}`);

  const startedAt = new Date().toISOString();
  await Transcript.archive(paths.transcriptsDir, 'scripts');
  await setStage(paths.dir, 'scripts', { status: 'running', startedAt });
  // The manifest is written after every finished case, so an interrupted run keeps its results.
  const finished = new Map<string, ScriptManifestEntry>(kept);
  let writes: Promise<void> = Promise.resolve();
  const writeManifest = () => {
    const scripts = cases.flatMap((tc) => (finished.has(tc.id) ? [finished.get(tc.id)!] : []));
    const text = `${JSON.stringify(ScriptManifest.parse({ schemaVersion: '1.0', generationRef: manifest.generationRef, helpersHash: hash, scripts }), null, 2)}\n`;
    writes = writes.then(() => writeFile(paths.scriptsManifest, text, 'utf8'));
    return writes;
  };
  let app: RunningApp | undefined;
  try {
    // The run's scripts folder: the helpers, the target settings they read, and the Playwright config.
    await mkdir(paths.scriptsDir, { recursive: true });
    await copyFile(HELPERS_TEMPLATE, path.join(paths.scriptsDir, '_helpers.ts'));
    await writeFile(
      path.join(paths.scriptsDir, '_target.json'),
      `${JSON.stringify({ apiUrl: config.backend.baseUrl, uiUrl: config.frontend.baseUrl, fixtures: config.fixtures, auth: config.auth }, null, 2)}\n`,
    );
    await writePlaywrightConfig(paths.dir, config.frontend.baseUrl);

    const llm = options.createLlm
      ? await options.createLlm(llmConfig, paths.llmCalls)
      : await createLLMClient(llmConfig, { callLogFile: paths.llmCalls, pricingFile: PRICING_FILE });

    log(`Starting the app at ${manifest.generationRef}`);
    const logsDir = path.join(paths.dir, 'scripts-server');
    app = options.startApp
      ? await options.startApp(config, manifest.generationRef, logsDir)
      : await startTarget(config, { ref: manifest.generationRef, generationRef: manifest.generationRef, repoDir, targetDir, logsDir, log });

    const deps: Deps = {
      llm,
      llmConfig,
      config,
      facts,
      prd,
      read: linesAtCommit({ root: repoDir, forbiddenPaths: config.forbiddenPaths }, manifest.generationCommit),
      repoDir,
      generationCommit: manifest.generationCommit,
      runDir: paths.dir,
      scriptsDir: paths.scriptsDir,
      transcriptsDir: paths.transcriptsDir,
      typeChecker: new TypeChecker(),
      mutex: new Mutex(),
      runDryRun: options.runDryRun ?? runSpec,
      dryRunMs: { total: 0 },
      app,
      restores: { count: 0, ms: 0 },
      ...(options.signal ? { signal: options.signal } : {}),
    };
    const todo = cases.filter((tc) => !kept.has(tc.id));
    log(`${cases.length} test cases${kept.size > 0 ? `; keeping ${kept.size} validated scripts from the earlier run, generating ${todo.length}` : ''}`);
    await writeManifest();
    const work = Promise.all(
      todo.map(async (tc) => {
        const entry = await generateOne(tc, deps);
        if (!options.signal?.aborted) {
          finished.set(tc.id, entry);
          await writeManifest();
        }
        return entry;
      }),
    );
    if (options.signal) {
      const signal = options.signal;
      const interrupted = new Promise<never>((_, reject) => {
        if (signal.aborted) reject(new Error('Interrupted'));
        signal.addEventListener('abort', () => reject(new Error('Interrupted')), { once: true });
      });
      await Promise.race([work, interrupted]);
    } else {
      await work;
    }
    const entries = cases.map((tc) => finished.get(tc.id)!);
    const result = ScriptManifest.parse({ schemaVersion: '1.0', generationRef: manifest.generationRef, helpersHash: hash, scripts: entries });
    await writeManifest();

    const calls = (await readCallLog(paths.llmCalls)).lines.filter((l) => l.purpose === 'scripts' && l.ts >= startedAt);
    const costs = calls.map((l) => l.costUsd).filter((c): c is number => c !== null);
    const warnings = [
      ...resumeWarnings,
      ...(!config.auth ? ['The target has no auth settings: the fixture guard could not check fixture users'] : []),
      ...(!facts ? [`No targets/${config.name}/facts.json: scripts were written without observed facts`] : []),
      ...(entries.some((e) => e.failureCategory === 'value-less-expect')
        ? ['Some scripts are invalid because a check without a locked value failed; review them by hand (invalidCases["value-less-expect"])']
        : []),
    ];
    const summary = scriptsSummary(entries, {
      calls: calls.length,
      costUsd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null,
      dryRunMs: deps.dryRunMs.total,
      playwrightVersion: version,
      warnings,
      resumed: kept.size,
      restores: deps.restores.count,
      restoreMs: deps.restores.ms,
    });
    await setStage(paths.dir, 'scripts', { status: 'done', startedAt, finishedAt: new Date().toISOString(), scripts: summary });
    return { runId, manifestFile: paths.scriptsManifest, manifest: result, summary };
  } catch (err) {
    // Keep what finished: a rerun resumes from this manifest.
    await writeManifest().catch(() => undefined);
    const error = options.signal?.aborted ? 'Interrupted' : errorSummary(err);
    await setStage(paths.dir, 'scripts', { status: 'failed', startedAt, finishedAt: new Date().toISOString(), error });
    throw err;
  } finally {
    await app?.stop();
  }
}

/** Lines for a person. */
export function describeScriptsSummary(s: StageScriptsSummary): string[] {
  const invalid = Object.entries(s.invalidByCategory).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ');
  return [
    `${s.cases} scripts: ${s.validated.passed} passed, ${s.validated.assertionFailed} assertion_failed, ${s.invalid} invalid${invalid ? ` (${invalid})` : ''}${s.resumed > 0 ? `; ${s.resumed} kept from the earlier run` : ''}`,
    `attempts: ${Object.entries(s.attemptsHistogram).map(([k, n]) => `${k}×${n}`).join(', ')}; failed attempts by stage: ${Object.entries(s.failuresByStage).map(([k, n]) => `${k} ${n}`).join(', ')}`,
    `${s.calls} model calls, cost ${s.costUsd === null ? 'unknown' : `$${s.costUsd.toFixed(4)}`}, dry runs ${Math.round(s.dryRunMs / 1000)} s, ${s.restores} data restores ${Math.round(s.restoreMs / 1000)} s, Playwright ${s.playwrightVersion}`,
    ...Object.entries(s.invalidCases).map(([k, ids]) => `invalid (${k}): ${ids.join(', ')}`),
    ...s.warnings.map((w) => `Warning: ${w}`),
  ];
}
