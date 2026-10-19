import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = '1.0';
export const SchemaVersion = z.literal(SCHEMA_VERSION);

/** ISO 8601 UTC timestamp, e.g. 2026-10-24T10:00:00Z. */
export const Timestamp = z.iso.datetime();

export const DurationMs = z.number().int().nonnegative();
export const TokenCount = z.number().int().nonnegative();

/** A path relative to some root (target repo or run directory). Never absolute, never `..`. */
export const RelPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !/^[A-Za-z]:/.test(p), 'path must be relative')
  .refine((p) => !p.split(/[\\/]/).includes('..'), 'path must not contain ".."');

/** `[start, end]`, 1-based and inclusive. */
export const LineRange = z
  .tuple([z.number().int().min(1), z.number().int().min(1)])
  .refine(([start, end]) => start <= end, 'line range start must not be after end');

export const FeatureId = z.string().regex(/^F-\d{2,}$/, 'expected a feature id like F-01');
export const RequirementId = z.string().regex(/^REQ-\d{3,}$/, 'expected a requirement id like REQ-001');
export const TestCaseId = z.string().regex(/^TC-\d{3,}$/, 'expected a test case id like TC-001');
export const OnePromptScriptId = z.string().regex(/^OP-\d{3,}$/, 'expected a one-prompt script id like OP-001');
export const ExpectationId = z.string().regex(/^E\d+$/, 'expected an expectation id like E1');
export const DiagnosisId = z.string().regex(/^DX-\d{3,}$/, 'expected a diagnosis id like DX-001');
export const CodeVariantId = z.string().regex(/^bug-\d{3,}$/, 'expected a code variant id like bug-001');
export const EnvVariantId = z.string().regex(/^env-\d{2,}$/, 'expected an environment variant id like env-01');
/** Results from the full suite use TC ids; the one-prompt ablation uses OP ids. */
export const ScriptTestId = z.union([TestCaseId, OnePromptScriptId]);
/** Execution ids appear in folder names, so they are restricted to safe characters. */
export const ExecId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'expected an execution id like golden or x-07');
export const CommitSha = z.string().regex(/^[0-9a-f]{7,40}$/, 'expected a git commit sha');

export const HttpMethod = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
export const Priority = z.enum(['high', 'medium', 'low']);
export const ReasoningEffort = z.enum(['low', 'medium', 'high']);
export const LLMProvider = z.enum(['openai-compatible', 'anthropic']);

export const Evidence = z.object({
  file: RelPath,
  lines: LineRange,
});

export const EnvMap = z.record(z.string(), z.string());

export type LineRange = z.infer<typeof LineRange>;
export type Evidence = z.infer<typeof Evidence>;
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;
export type LLMProvider = z.infer<typeof LLMProvider>;

// ---------------------------------------------------------------------------
// LLM call log — one line of runs/<runId>/llm-calls.jsonl
// ---------------------------------------------------------------------------

export const LLMCallLogLine = z.object({
  ts: Timestamp,
  purpose: z.string().min(1),
  provider: LLMProvider,
  model: z.string().min(1),
  reasoningEffort: ReasoningEffort.nullable(),
  inputTokens: TokenCount,
  outputTokens: TokenCount,
  latencyMs: DurationMs,
  ok: z.boolean(),
  attempts: z.number().int().min(1),
  costUsd: z.number().nonnegative().nullable(),
  error: z.string().optional(),
});

export type LLMCallLogLine = z.infer<typeof LLMCallLogLine>;

// ---------------------------------------------------------------------------
// run.json
// ---------------------------------------------------------------------------

export const StageStatus = z.enum(['pending', 'running', 'done', 'failed', 'stale']);
export const ExecutionStepStatus = z.enum(['pending', 'running', 'done', 'failed']);

export const StageState = z.object({
  status: StageStatus,
  startedAt: Timestamp.optional(),
  finishedAt: Timestamp.optional(),
  /** Why the stage failed (e.g. LLMBudgetExceededError). No secrets. */
  error: z.string().optional(),
});

const PerModule = <T extends z.ZodType>(value: T) =>
  z.object({ prd: value, cases: value, scripts: value, analyzer: value });

export const RunExecution = z.object({
  execId: ExecId,
  ref: z.string().min(1),
  commit: CommitSha,
  executeStatus: ExecutionStepStatus,
  analyzeStatus: ExecutionStepStatus,
  /** Why the execution or its analysis failed. No secrets. */
  error: z.string().optional(),
});

export const RunManifest = z.object({
  schemaVersion: SchemaVersion,
  runId: z.string().regex(/^[a-z0-9-]+-\d{8}-\d{6}$/, 'expected a run id like <target>-YYYYMMDD-HHmmss'),
  target: z.string().min(1),
  generationRef: z.string().min(1),
  generationCommit: CommitSha,
  createdAt: Timestamp,
  llm: z.object({
    provider: LLMProvider,
    models: PerModule(z.string().min(1)),
    temperature: z.number().min(0).max(2),
    topP: z.number().gt(0).max(1),
    reasoningEffort: PerModule(ReasoningEffort),
    concurrency: z.number().int().positive(),
  }),
  stages: z.strictObject({
    prd: StageState.optional(),
    cases: StageState.optional(),
    scripts: StageState.optional(),
  }),
  executions: z.array(RunExecution),
});

export type StageStatus = z.infer<typeof StageStatus>;
export type ExecutionStepStatus = z.infer<typeof ExecutionStepStatus>;
export type StageState = z.infer<typeof StageState>;
export type RunExecution = z.infer<typeof RunExecution>;
export type RunManifest = z.infer<typeof RunManifest>;
