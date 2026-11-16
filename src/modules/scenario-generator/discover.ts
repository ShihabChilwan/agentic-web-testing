import { runAgent } from '../../agent/runtime.js';
import { createRepoTools } from '../../agent/tools/repo-tools.js';
import { AgentBudgetError, AgentSubmitError } from '../../agent/types.js';
import type { LLMClient } from '../../llm/types.js';
import type { LLMConfig } from '../../shared/config.js';
import { SubmitVariationPoints } from '../../shared/schemas.js';
import type { CoverageReport, Prd, TargetConfig } from '../../shared/schemas.js';
import type { ReadLines } from '../test-case-generator/context.js';
import { checkProposed, type DraftPoint } from './points.js';
import { buildDiscoverySystemPrompt, buildDiscoveryTask } from './prompt.js';
import type { SuiteUsage } from './usage.js';

/** Exploring tool calls per discovery session. */
export const DISCOVERY_TOOL_CALLS = 15;

export interface DiscoveryDeps {
  llm: LLMClient;
  llmConfig: LLMConfig;
  prd: Prd;
  config: TargetConfig;
  usage: SuiteUsage;
  coverage: CoverageReport | null;
  read: ReadLines;
  /** The target repo working tree at the generation commit (read-only tools are confined to it). */
  repoDir: string;
  transcriptsDir: string;
  /** Role points code made, as "METHOD /path as role" per feature id. */
  rolePointsByFeature: Map<string, string[]>;
}

export interface DiscoveryOutcome {
  featureId: string;
  points: DraftPoint[];
  rejected: number;
  /** Why the session ended without points, when it failed. */
  error?: string;
}

/**
 * One discovery session for one feature (SPEC §6.5): read-only repo tools, then submit_variation_points, whose points the
 * code checks (citations exist, values appear in the cited code and are new to the suite, endpoints and pages are the
 * PRD's, users are fixture users or the visitor). A session that ends without an accepted submit gives no points.
 */
export async function discoverFeature(feature: Prd['features'][number], deps: DiscoveryDeps): Promise<DiscoveryOutcome> {
  const requirements = deps.prd.requirements.filter((r) => r.featureId === feature.id);
  if (requirements.length === 0) return { featureId: feature.id, points: [], rejected: 0 };
  let accepted: DraftPoint[] = [];
  const task = await buildDiscoveryTask({
    feature,
    requirements,
    prd: deps.prd,
    config: deps.config,
    usage: deps.usage,
    coverage: deps.coverage,
    read: deps.read,
    rolePoints: deps.rolePointsByFeature.get(feature.id) ?? [],
  });
  try {
    const result = await runAgent(
      {
        purpose: 'scenarios',
        system: buildDiscoverySystemPrompt(),
        task,
        tools: createRepoTools({ root: deps.repoDir, forbiddenPaths: deps.config.forbiddenPaths }),
        submit: {
          name: 'submit_variation_points',
          description: 'Submit the variation points for this feature (an empty list when nothing fits).',
          schema: SubmitVariationPoints,
          validate: async ({ points }) => {
            const { problems, drafts } = await checkProposed(points, feature.id, { prd: deps.prd, featureRequirements: requirements, fixtures: deps.config.fixtures, usage: deps.usage, read: deps.read });
            if (problems.length === 0) accepted = drafts;
            return problems;
          },
        },
        budget: { maxToolCalls: DISCOVERY_TOOL_CALLS },
      },
      { llm: deps.llm, contextTokens: deps.llmConfig.contextTokens, transcriptDir: deps.transcriptsDir },
    );
    return { featureId: feature.id, points: accepted, rejected: result.submitStats.invalidInput + result.submitStats.checkFailed };
  } catch (err) {
    if (err instanceof AgentSubmitError || err instanceof AgentBudgetError) {
      return { featureId: feature.id, points: [], rejected: err instanceof AgentSubmitError ? err.errors.length : 0, error: `${err.name}: ${err.message}` };
    }
    // A cost cap reached or a request that kept failing ends this feature's session; the others go on.
    return { featureId: feature.id, points: [], rejected: 0, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}
