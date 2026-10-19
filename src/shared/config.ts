import { z } from 'zod';
import { LLMProvider, ReasoningEffort } from './schemas.js';
import type { ReasoningEffort as Effort } from './schemas.js';

export const MODULE_PURPOSES = ['prd', 'cases', 'scripts', 'analyzer'] as const;
export type ModulePurpose = (typeof MODULE_PURPOSES)[number];

/** Per-module reasoning effort when no override is set. */
const DEFAULT_REASONING_EFFORT: Record<ModulePurpose, Effort> = {
  prd: 'medium',
  cases: 'low',
  scripts: 'medium',
  analyzer: 'high',
};

export interface LLMConfig {
  provider: z.infer<typeof LLMProvider>;
  baseUrl: string | undefined;
  apiKey: string | undefined;
  extraHeaders: Record<string, string>;
  model: string;
  models: Record<ModulePurpose, string>;
  temperature: number;
  topP: number;
  reasoningEffort: Effort;
  reasoningEfforts: Record<ModulePurpose, Effort>;
  concurrency: number;
  contextTokens: number;
  timeoutMs: number;
  maxTokensPerRun: number;
  maxCostUsdPerRun: number;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

// Empty strings in .env mean "not set".
const optionalString = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());
const withDefault = <T extends z.ZodType>(schema: T, fallback: z.input<T>) =>
  z.preprocess((v) => (v === '' || v === undefined ? fallback : v), schema);

const number = (fallback: number) => withDefault(z.coerce.number(), fallback);
const positiveInt = (fallback: number) => withDefault(z.coerce.number().int().positive(), fallback);

const extraHeaders = z.preprocess(
  (v, ctx) => {
    if (v === undefined || v === '') return {};
    try {
      return JSON.parse(String(v));
    } catch {
      // Never echo the value: it usually holds credentials.
      ctx.addIssue({ code: 'custom', message: 'must be a JSON object of header names to string values' });
      return z.NEVER;
    }
  },
  z.record(z.string(), z.string(), { error: 'must be a JSON object of header names to string values' }),
);

const EnvSchema = z.object({
  LLM_PROVIDER: withDefault(LLMProvider, 'openai-compatible'),
  LLM_BASE_URL: optionalString.pipe(z.url().optional()),
  LLM_MODEL: withDefault(z.string().min(1), 'openai/gpt-oss-120b'),
  LLM_API_KEY: optionalString,
  LLM_EXTRA_HEADERS: extraHeaders,
  LLM_TEMPERATURE: number(1.0).pipe(z.number().min(0).max(2)),
  LLM_TOP_P: number(1.0).pipe(z.number().gt(0).max(1)),
  LLM_REASONING_EFFORT: withDefault(ReasoningEffort, 'medium'),
  LLM_REASONING_EFFORT_PRD: optionalString.pipe(ReasoningEffort.optional()),
  LLM_REASONING_EFFORT_CASES: optionalString.pipe(ReasoningEffort.optional()),
  LLM_REASONING_EFFORT_SCRIPTS: optionalString.pipe(ReasoningEffort.optional()),
  LLM_REASONING_EFFORT_ANALYZER: optionalString.pipe(ReasoningEffort.optional()),
  LLM_MODEL_PRD: optionalString,
  LLM_MODEL_CASES: optionalString,
  LLM_MODEL_SCRIPTS: optionalString,
  LLM_MODEL_ANALYZER: optionalString,
  LLM_CONCURRENCY: positiveInt(4),
  LLM_CONTEXT_TOKENS: positiveInt(131072),
  LLM_TIMEOUT_MS: positiveInt(1_200_000),
  LLM_MAX_TOKENS_PER_RUN: positiveInt(5_000_000),
  LLM_MAX_COST_USD_PER_RUN: number(2.0).pipe(z.number().nonnegative()),
});

/**
 * Builds the LLM configuration from an environment map. Pure: it never reads
 * `.env` or `process.env` itself, so tests pass values in directly.
 * Error messages name the variable but never include its value.
 */
export function parseLLMConfig(env: Record<string, string | undefined>): LLMConfig {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid LLM configuration:\n  ${problems.join('\n  ')}`);
  }
  const e = result.data;
  if (e.LLM_PROVIDER === 'openai-compatible' && !e.LLM_BASE_URL) {
    throw new ConfigError('Invalid LLM configuration:\n  LLM_BASE_URL: required for the openai-compatible provider');
  }
  return {
    provider: e.LLM_PROVIDER,
    baseUrl: e.LLM_BASE_URL,
    apiKey: e.LLM_API_KEY,
    extraHeaders: e.LLM_EXTRA_HEADERS,
    model: e.LLM_MODEL,
    models: {
      prd: e.LLM_MODEL_PRD ?? e.LLM_MODEL,
      cases: e.LLM_MODEL_CASES ?? e.LLM_MODEL,
      scripts: e.LLM_MODEL_SCRIPTS ?? e.LLM_MODEL,
      analyzer: e.LLM_MODEL_ANALYZER ?? e.LLM_MODEL,
    },
    temperature: e.LLM_TEMPERATURE,
    topP: e.LLM_TOP_P,
    reasoningEffort: e.LLM_REASONING_EFFORT,
    reasoningEfforts: {
      prd: e.LLM_REASONING_EFFORT_PRD ?? DEFAULT_REASONING_EFFORT.prd,
      cases: e.LLM_REASONING_EFFORT_CASES ?? DEFAULT_REASONING_EFFORT.cases,
      scripts: e.LLM_REASONING_EFFORT_SCRIPTS ?? DEFAULT_REASONING_EFFORT.scripts,
      analyzer: e.LLM_REASONING_EFFORT_ANALYZER ?? DEFAULT_REASONING_EFFORT.analyzer,
    },
    concurrency: e.LLM_CONCURRENCY,
    contextTokens: e.LLM_CONTEXT_TOKENS,
    timeoutMs: e.LLM_TIMEOUT_MS,
    maxTokensPerRun: e.LLM_MAX_TOKENS_PER_RUN,
    maxCostUsdPerRun: e.LLM_MAX_COST_USD_PER_RUN,
  };
}

function isModulePurpose(purpose: string): purpose is ModulePurpose {
  return (MODULE_PURPOSES as readonly string[]).includes(purpose);
}

/** Model for a call purpose; purposes outside the four modules (e.g. 'one-prompt') use the default. */
export function modelFor(config: LLMConfig, purpose: string): string {
  return isModulePurpose(purpose) ? config.models[purpose] : config.model;
}

/** Reasoning effort for a call purpose; purposes outside the four modules use LLM_REASONING_EFFORT. */
export function reasoningEffortFor(config: LLMConfig, purpose: string): Effort {
  return isModulePurpose(purpose) ? config.reasoningEfforts[purpose] : config.reasoningEffort;
}

/** Loads `.env` into process.env (without overriding values already set) and parses it. CLI use only. */
export async function loadLLMConfig(): Promise<LLMConfig> {
  const dotenv = await import('dotenv');
  dotenv.config({ quiet: true });
  return parseLLMConfig(process.env);
}
