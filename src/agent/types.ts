import type { ZodType } from 'zod';
import type { LLMClient, Usage } from '../llm/types.js';

export interface AgentTool<I> {
  name: string;
  description: string;
  input: ZodType<I>;
  /** Returns text for the model. Errors should be returned as text; a thrown error is caught and returned as text too. */
  run(input: I): Promise<string>;
  /**
   * Default true. A tool with `false` (e.g. one that records part of the result) is not counted
   * against `maxToolCalls` and stays available after the exploration budget is used up.
   */
  countsTowardBudget?: boolean;
}

export interface SubmitSpec<O> {
  name: string;
  description: string;
  /** Must describe a JSON object (tool inputs are objects). */
  schema: ZodType<O>;
  /** Extra checks after the schema passes; returns error messages, empty when valid. */
  validate?: (output: O) => string[] | Promise<string[]>;
}

export interface RunAgentOptions<O> {
  purpose: string;
  system: string;
  /** The first user message. */
  task: string;
  /** May be empty (no-tools ablation): then only the submit tool is offered. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: AgentTool<any>[];
  submit: SubmitSpec<O>;
  /** `maxToolCalls` counts only tools that count toward the budget. `maxTurns` defaults to `maxToolCalls + 10`. */
  budget: { maxToolCalls: number; maxTurns?: number };
}

export interface AgentDeps {
  llm: LLMClient;
  /** The served model's context window (LLM_CONTEXT_TOKENS). */
  contextTokens: number;
  /** runs/<runId>/transcripts; when absent no transcript is written. */
  transcriptDir?: string;
  /** Output token limit per model call. */
  maxTokensPerCall?: number;
}

/** Per tool: calls that ran, calls whose input failed the tool's schema, and calls whose tool threw. */
export interface ToolStats {
  calls: number;
  invalidInput: number;
  errors: number;
}

export interface AgentResult<O> {
  output: O;
  /** Calls to tools that count toward the budget. */
  toolCalls: number;
  /** Calls to tools with `countsTowardBudget: false`. */
  uncountedToolCalls: number;
  toolStats: Record<string, ToolStats>;
  /** True when `maxToolCalls` was reached. */
  budgetExhausted: boolean;
  turns: number;
  usage: Usage;
  durationMs: number;
  transcriptFile?: string;
}

interface AgentErrorDetails {
  toolCalls: number;
  uncountedToolCalls: number;
  toolStats: Record<string, ToolStats>;
  budgetExhausted: boolean;
  turns: number;
  usage: Usage;
}

/** The budget ran out and the final submit-only turn produced no submission. */
export class AgentBudgetError extends Error {
  override name = 'AgentBudgetError';
  constructor(
    message: string,
    readonly details: AgentErrorDetails,
  ) {
    super(message);
  }
}

/** All submit attempts of the session were rejected. */
export class AgentSubmitError extends Error {
  override name = 'AgentSubmitError';
  constructor(
    message: string,
    readonly errors: string[],
    readonly details: AgentErrorDetails,
  ) {
    super(message);
  }
}
