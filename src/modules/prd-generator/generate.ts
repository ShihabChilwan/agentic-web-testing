import { currentFrozen } from '../../shared/freeze.js';
import { writeFile } from 'node:fs/promises';
import { DEFAULT_EXPLORATION_CEILING, runAgent } from '../../agent/runtime.js';
import { createRepoTools } from '../../agent/tools/repo-tools.js';
import { AgentBudgetError, AgentSubmitError } from '../../agent/types.js';
import type { AgentResult, ToolStats } from '../../agent/types.js';
import { createLLMClient } from '../../llm/client.js';
import type { LLMClient } from '../../llm/types.js';
import { loadLLMConfig } from '../../shared/config.js';
import type { LLMConfig } from '../../shared/config.js';
import { PRICING_FILE } from '../../shared/paths.js';
import { createRun, errorSummary, llmSettings, setStage } from '../../shared/run-manifest.js';
import { Prd } from '../../shared/schemas.js';
import type { StageAgentSummary, StageCompletenessSummary, TargetConfig } from '../../shared/schemas.js';
import { loadTargetConfig } from '../../shared/target-config.js';
import { uiSourceRoots } from '../../shared/target-ui.js';
import { checkoutRef } from '../execution-engine/lifecycle.js';
import { createCompletenessSubmit, createDraftTools, createSubmit, draftCounts, featureId, PrdDraft, RECORDING_TOOLS, requirementId, unnamedPages } from './draft.js';
import type { SubmitInput } from './draft.js';
import { buildCompletenessSystemPrompt, buildCompletenessTask, buildSystemPrompt, buildTask } from './prompt.js';

/** Turns allowed beyond the exploring ceiling, for the add_* batches, nudges and submit. */
export const PRD_EXTRA_TURNS = 40;
/** Exploring calls of the completeness round (SPEC §4, §12); its add_* calls do not count. */
export const COMPLETENESS_EXPLORATION_CEILING = 60;

export interface GeneratePrdOptions {
  target: string;
  /** Generation ref; defaults to the target's goldenRef. */
  ref?: string;
  /** Runaway ceiling for exploring calls (default DEFAULT_EXPLORATION_CEILING). Not shown to the model. */
  maxExploreCalls?: number;
  targetsDir?: string;
  projectRoot?: string;
  runsDir?: string;
  /** Defaults to the settings in .env. */
  llmConfig?: LLMConfig;
  /** Defaults to the real client writing the run's llm-calls.jsonl; tests pass a FakeLLMClient. */
  createLlm?: (config: LLMConfig, callLogFile: string) => Promise<LLMClient>;
  /** Called once the run folder exists, e.g. so the CLI can mark the stage failed on Ctrl+C. */
  onRunCreated?: (runDir: string) => void;
  log?: (message: string) => void;
}

export interface GeneratePrdResult {
  runId: string;
  runDir: string;
  prdFile: string;
  prd: Prd;
  agent: Omit<AgentResult<SubmitInput>, 'output'>;
  summary: StageAgentSummary;
  completeness: StageCompletenessSummary;
}

type SessionDetails = { turns: number; toolCalls: number; budgetExhausted: boolean; toolStats: Record<string, ToolStats> };

/** Lines for a person: exploring calls by tool, rejections by kind, and a warning when the ceiling was hit. */
export function describeSummary(summary: StageAgentSummary): string[] {
  const exploring = Object.entries(summary.toolCallsByTool)
    .filter(([name]) => !RECORDING_TOOLS.includes(name))
    .map(([name, n]) => `${name} ${n}`)
    .join(', ');
  const lines = [
    `${summary.turns} turns; exploring calls: ${summary.toolCalls} (${exploring || 'none'})`,
    `rejected batches: ${summary.rejected.invalidInput} invalid input, ${summary.rejected.checkFailed} failed checks`,
  ];
  if (summary.explorationCeilingHit) {
    lines.push(`Warning: exploration stopped at the ceiling (${summary.toolCallCeiling} calls); the document may be incomplete.`);
  }
  return lines;
}

/** One line for a person: what the completeness round added, and a warning when it stopped early. */
export function describeCompleteness(c: StageCompletenessSummary): string[] {
  const a = c.added;
  const lines = [`completeness round: added ${a.apiEndpoints} API endpoint(s), ${a.uiRoutes} page(s), ${a.requirements} requirement(s), ${a.features} feature(s); ${c.toolCalls} exploring calls`];
  if (c.error) lines.push(`Warning: the completeness round ended early (${c.error}); what it recorded is kept.`);
  return lines;
}

/**
 * The completeness round (SPEC §4): a second session with the read-only tools and the same draft looks for
 * endpoints and pages the first pass missed and describes each in a requirement. It never fails the stage: when it
 * ends without an accepted finish, what it stored is kept and the reason recorded.
 */
async function runCompletenessRound(
  draft: PrdDraft,
  deps: { config: TargetConfig; scope: { root: string; forbiddenPaths: string[] }; llm: LLMClient; llmConfig: LLMConfig; transcriptsDir: string },
): Promise<StageCompletenessSummary> {
  const before = draftCounts(draft);
  const added = () => {
    const now = draftCounts(draft);
    return {
      features: now.features - before.features,
      apiEndpoints: now.apiEndpoints - before.apiEndpoints,
      uiRoutes: now.uiRoutes - before.uiRoutes,
      requirements: now.requirements - before.requirements,
    };
  };
  const task = buildCompletenessTask(deps.config, {
    features: draft.features,
    apiEndpoints: draft.apiEndpoints,
    uiRoutes: draft.uiRoutes,
    unnamedPages: unnamedPages(draft),
    requirements: draft.requirements.length,
    nextFeatureId: featureId(draft.features.length + 1),
    nextRequirementId: requirementId(draft.requirements.length + 1),
  });
  const ceiling = COMPLETENESS_EXPLORATION_CEILING;
  try {
    const result = await runAgent(
      {
        purpose: 'prd',
        system: buildCompletenessSystemPrompt(),
        task,
        tools: [...createRepoTools(deps.scope), ...createDraftTools(draft)],
        submit: createCompletenessSubmit(draft, before),
        budget: { maxToolCalls: ceiling, maxTurns: ceiling + PRD_EXTRA_TURNS },
      },
      { llm: deps.llm, contextTokens: deps.llmConfig.contextTokens, transcriptDir: deps.transcriptsDir },
    );
    return { ...stageSummary(result, ceiling), added: added() };
  } catch (err) {
    if (!(err instanceof AgentBudgetError || err instanceof AgentSubmitError)) throw err;
    return { ...stageSummary(err.details, ceiling), added: added(), error: errorSummary(err) };
  }
}

/** The run.json summary of an agent session. Rejections count only the recording (add_*) tools. */
export function stageSummary(details: SessionDetails, ceiling: number): StageAgentSummary {
  const recording = Object.entries(details.toolStats).filter(([name]) => RECORDING_TOOLS.includes(name));
  return {
    turns: details.turns,
    toolCalls: details.toolCalls,
    toolCallCeiling: ceiling,
    explorationCeilingHit: details.budgetExhausted,
    toolCallsByTool: Object.fromEntries(Object.entries(details.toolStats).map(([name, s]) => [name, s.calls])),
    rejected: {
      invalidInput: recording.reduce((sum, [, s]) => sum + s.invalidInput, 0),
      checkFailed: recording.reduce((sum, [, s]) => sum + s.errors, 0),
    },
  };
}

/**
 * Stage 1, Module 1 (SPEC §4): checks out the generation ref, creates the run,
 * lets the PRD agent explore the repo and record the document in checked
 * batches, and writes prd.json. On failure the stage is marked failed in run.json.
 */
export async function generatePrd(options: GeneratePrdOptions): Promise<GeneratePrdResult> {
  const log = options.log ?? (() => {});
  const { config, repoDir } = await loadTargetConfig(options.target, {
    ...(options.targetsDir ? { targetsDir: options.targetsDir } : {}),
    ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
  });
  const llmConfig = options.llmConfig ?? (await loadLLMConfig());
  const ref = options.ref ?? config.goldenRef;
  const ceiling = options.maxExploreCalls ?? DEFAULT_EXPLORATION_CEILING;

  // Before the run exists: a bad ref creates no run folder.
  const commit = await checkoutRef(repoDir, ref);
  const frozen = await currentFrozen({ target: config.name, llmConfig, ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}) });
  const { runId, paths } = await createRun({
    target: config.name,
    generationRef: ref,
    generationCommit: commit,
    llm: llmSettings(llmConfig),
    ...(frozen ? { frozen } : {}),
    ...(options.runsDir ? { runsDir: options.runsDir } : {}),
  });
  options.onRunCreated?.(paths.dir);
  log(`Run ${runId} at ${ref} (${commit.slice(0, 7)})`);

  const startedAt = new Date().toISOString();
  await setStage(paths.dir, 'prd', { status: 'running', startedAt });
  try {
    const llm = options.createLlm
      ? await options.createLlm(llmConfig, paths.llmCalls)
      : await createLLMClient(llmConfig, { callLogFile: paths.llmCalls, pricingFile: PRICING_FILE });
    const scope = { root: repoDir, forbiddenPaths: config.forbiddenPaths };
    const draft = new PrdDraft({
      scope,
      apiPrefix: config.backend.apiPrefix,
      frontendRoots: uiSourceRoots(config),
    });

    const result = await runAgent(
      {
        purpose: 'prd',
        system: buildSystemPrompt(),
        task: buildTask(config),
        tools: [...createRepoTools(scope), ...createDraftTools(draft)],
        submit: createSubmit(draft),
        budget: { maxToolCalls: ceiling, maxTurns: ceiling + PRD_EXTRA_TURNS },
      },
      { llm, contextTokens: llmConfig.contextTokens, transcriptDir: paths.transcriptsDir },
    );

    log('Completeness round: looking for endpoints and pages the first pass missed');
    const completeness = await runCompletenessRound(draft, { config, scope, llm, llmConfig, transcriptsDir: paths.transcriptsDir });

    const prd = Prd.parse(
      draft.toPrd({ target: config.name, sourceRef: ref, generatedAt: new Date().toISOString() }, result.output),
    );
    await writeFile(paths.prd, `${JSON.stringify(prd, null, 2)}\n`, 'utf8');
    const summary = stageSummary(result, ceiling);
    await setStage(paths.dir, 'prd', { status: 'done', startedAt, finishedAt: new Date().toISOString(), agent: summary, completeness });

    const { output: _output, ...agent } = result;
    return { runId, runDir: paths.dir, prdFile: paths.prd, prd, agent, summary, completeness };
  } catch (err) {
    const details = err instanceof AgentBudgetError || err instanceof AgentSubmitError ? err.details : undefined;
    await setStage(paths.dir, 'prd', {
      status: 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      error: errorSummary(err),
      ...(details ? { agent: stageSummary(details, ceiling) } : {}),
    });
    throw err;
  }
}
