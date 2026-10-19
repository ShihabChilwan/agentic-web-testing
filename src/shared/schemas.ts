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
// Target configuration — hand-written, so unknown keys are rejected
// ---------------------------------------------------------------------------

const ServiceConfig = z.strictObject({
  cwd: z.string(),
  install: z.string().min(1),
  start: z.string().min(1),
  baseUrl: z.url(),
  healthCheckUrl: z.url(),
  env: EnvMap,
  /** Also write the env to this file (relative to `cwd`) before start, for apps that read a .env file. */
  envFile: RelPath.optional(),
});

export const FixtureUser = z.looseObject({
  email: z.string().min(1),
  password: z.string().min(1),
  role: z.string().min(1),
});

export const SeedRequest = z.strictObject({
  method: HttpMethod,
  path: z.string().startsWith('/'),
  body: z.unknown().optional(),
});

export const TargetConfig = z.strictObject({
  schemaVersion: SchemaVersion,
  name: z.string().regex(/^[a-z0-9-]+$/, 'target name must be lowercase letters, digits and dashes'),
  repoPath: RelPath,
  repoUrl: z.url(),
  goldenRef: z.string().min(1),
  backend: ServiceConfig.extend({
    apiPrefix: z.string(),
    disabledServices: EnvMap.default({}),
  }),
  frontend: ServiceConfig,
  lifecycle: z.strictObject({
    reset: z.string().min(1),
    resetCwd: z.string(),
    seedCommand: z.string().min(1).optional(),
    seedCwd: z.string().optional(),
    startupTimeoutMs: z.number().int().positive(),
  }),
  fixtures: z.looseObject({
    users: z.record(z.string(), FixtureUser),
  }),
  seed: z.array(SeedRequest),
  sourceHints: z.strictObject({
    include: z.array(z.string()),
    exclude: z.array(z.string()),
  }),
  forbiddenPaths: z.array(z.string()),
});

export type TargetConfig = z.infer<typeof TargetConfig>;
export type FixtureUser = z.infer<typeof FixtureUser>;

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
// config/pricing.json — optional; without it every costUsd is null
// ---------------------------------------------------------------------------

export const Pricing = z.strictObject({
  schemaVersion: SchemaVersion,
  /** Token prices per model id, in US dollars per million tokens. */
  models: z.record(
    z.string().min(1),
    z.strictObject({
      inputUsdPerMTok: z.number().nonnegative(),
      outputUsdPerMTok: z.number().nonnegative(),
    }),
  ),
  /** Hourly rate of the GPU serving the self-hosted model, for the cost estimate in evaluation. */
  gpuUsdPerHour: z.number().nonnegative().optional(),
});

export type Pricing = z.infer<typeof Pricing>;

// ---------------------------------------------------------------------------
// Module 1 — prd.json
// ---------------------------------------------------------------------------

export const PrdFeature = z.object({
  id: FeatureId,
  name: z.string().min(1),
  description: z.string().min(1),
});

export const PrdApiEndpoint = z.object({
  method: HttpMethod,
  path: z.string().startsWith('/'),
  authRequired: z.boolean(),
  summary: z.string().min(1),
  request: z
    .object({
      body: z.unknown().optional(),
      query: z.unknown().optional(),
      params: z.unknown().optional(),
    })
    .optional(),
  responses: z
    .array(
      z.object({
        status: z.number().int().min(100).max(599),
        description: z.string().min(1),
      }),
    )
    .min(1),
  evidence: z.array(Evidence).min(1),
});

export const PrdUiRoute = z.object({
  path: z.string().startsWith('/'),
  summary: z.string().min(1),
  authRequired: z.boolean(),
  evidence: z.array(Evidence).min(1),
});

export const RequirementLayer = z.enum(['api', 'ui', 'e2e']);

export const PrdRequirement = z.object({
  id: RequirementId,
  featureId: FeatureId,
  layer: RequirementLayer,
  statement: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  priority: Priority,
  evidence: z.array(Evidence).min(1),
});

export const Prd = z.object({
  schemaVersion: SchemaVersion,
  target: z.string().min(1),
  sourceRef: z.string().min(1),
  generatedAt: Timestamp,
  features: z.array(PrdFeature).min(1),
  apiEndpoints: z.array(PrdApiEndpoint),
  uiRoutes: z.array(PrdUiRoute),
  requirements: z.array(PrdRequirement).min(1),
  assumptions: z.array(z.string()),
  openQuestions: z.array(z.string()),
});

export type Prd = z.infer<typeof Prd>;
export type PrdRequirement = z.infer<typeof PrdRequirement>;

// ---------------------------------------------------------------------------
// Module 2 — testcases.json
// ---------------------------------------------------------------------------

export const MAX_TEST_CASES = 150;
export const MAX_TEST_CASES_PER_REQUIREMENT = 4;

export const TestLayer = z.enum(['api', 'ui']);
export const TestCategory = z.enum(['functional', 'boundary', 'error-handling', 'auth', 'e2e-journey']);

export const Expectation = z.object({
  id: ExpectationId,
  description: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

export const TestCase = z.object({
  id: TestCaseId,
  requirementIds: z.array(RequirementId).min(1),
  title: z.string().min(1),
  layer: TestLayer,
  category: TestCategory,
  priority: Priority,
  preconditions: z.array(z.string()),
  fixturesUsed: z.array(z.string()),
  steps: z.array(z.string().min(1)).min(1),
  expected: z.array(Expectation).min(1),
});

export const TestCaseCoverage = z.object({
  requirementsTotal: z.number().int().nonnegative(),
  requirementsCovered: z.number().int().nonnegative(),
  uncovered: z.array(
    z.object({
      requirementId: RequirementId,
      reason: z.string().min(1),
    }),
  ),
});

export const TestCases = z.object({
  schemaVersion: SchemaVersion,
  generatedAt: Timestamp,
  testCases: z.array(TestCase).max(MAX_TEST_CASES),
  coverage: TestCaseCoverage,
});

export type TestCase = z.infer<typeof TestCase>;
export type TestCases = z.infer<typeof TestCases>;
export type Expectation = z.infer<typeof Expectation>;

// ---------------------------------------------------------------------------
// Module 3 — scripts/manifest.json (also used by the one-prompt ablation)
// ---------------------------------------------------------------------------

export const ScriptStatus = z.enum(['validated', 'invalid']);
export const ValidationOutcome = z.enum(['passed', 'assertion_failed']);
export const AttemptStage = z.enum(['typecheck', 'lock-check', 'dry-run']);

export const ScriptAttempt = z.object({
  attempt: z.number().int().min(1),
  stage: AttemptStage,
  error: z.string().nullable(),
  durationMs: DurationMs,
});

export const ScriptManifestEntry = z
  .object({
    testCaseId: ScriptTestId,
    file: RelPath,
    status: ScriptStatus,
    validationOutcome: ValidationOutcome.nullable(),
    attempts: z.number().int().min(1),
    attemptLog: z.array(ScriptAttempt).min(1),
  })
  .refine((s) => (s.status === 'validated') === (s.validationOutcome !== null), {
    message: 'validationOutcome must be set for validated scripts and null for invalid ones',
    path: ['validationOutcome'],
  });

export const ScriptManifest = z.object({
  schemaVersion: SchemaVersion,
  generationRef: z.string().min(1),
  scripts: z.array(ScriptManifestEntry),
});

export type ScriptManifest = z.infer<typeof ScriptManifest>;
export type ScriptManifestEntry = z.infer<typeof ScriptManifestEntry>;

// ---------------------------------------------------------------------------
// Module 4 — execution request and results.json
// ---------------------------------------------------------------------------

/** Env values for an override: a string sets the variable, null removes it. */
const EnvOverride = z.record(z.string(), z.string().nullable());

/** Values merged over the target config for one execution (used by environment variants). */
export const ConfigOverride = z.strictObject({
  backend: z.strictObject({ env: EnvOverride.optional() }).optional(),
  frontend: z.strictObject({ env: EnvOverride.optional() }).optional(),
  lifecycle: z.strictObject({ startupTimeoutMs: z.number().int().positive().optional() }).optional(),
});

export const ExecutionRequest = z.object({
  execId: ExecId,
  ref: z.string().min(1),
  scriptsDir: RelPath.optional(),
  configOverride: ConfigOverride.optional(),
  skipSeed: z.boolean().optional(),
});

export const TestStatus = z.enum(['passed', 'failed', 'errored']);

export const HealthCheckResult = z.object({
  name: z.string().min(1),
  url: z.url(),
  ok: z.boolean(),
  elapsedMs: DurationMs,
});

export const SeedResult = z.object({
  request: z.string().min(1),
  /** null when no HTTP response came back (e.g. connection refused). */
  status: z.number().int().nullable(),
  ok: z.boolean(),
});

export const TestArtifacts = z.object({
  screenshot: RelPath.optional(),
  trace: RelPath.optional(),
  dom: RelPath.optional(),
  network: RelPath.optional(),
  console: RelPath.optional(),
});

export const TestResult = z.object({
  testCaseId: ScriptTestId,
  status: TestStatus,
  durationMs: DurationMs,
  error: z
    .object({
      message: z.string(),
      expectationId: ExpectationId.nullable().optional(),
      stack: z.string().optional(),
    })
    .optional(),
  artifacts: TestArtifacts,
});

export const ExecutionResults = z.object({
  schemaVersion: SchemaVersion,
  execId: ExecId,
  startedAt: Timestamp,
  finishedAt: Timestamp,
  environment: z.object({
    healthChecks: z.array(HealthCheckResult),
    seed: z.array(SeedResult),
  }),
  summary: z.object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    errored: z.number().int().nonnegative(),
  }),
  results: z.array(TestResult),
});

export type ConfigOverride = z.infer<typeof ConfigOverride>;
export type ExecutionRequest = z.infer<typeof ExecutionRequest>;
export type ExecutionResults = z.infer<typeof ExecutionResults>;
export type TestResult = z.infer<typeof TestResult>;
export type HealthCheckResult = z.infer<typeof HealthCheckResult>;
export type SeedResult = z.infer<typeof SeedResult>;

// ---------------------------------------------------------------------------
// Module 5 — diagnoses.json
// ---------------------------------------------------------------------------

export const Classification = z.enum(['app_defect', 'environment_issue', 'test_defect', 'inconclusive']);
export const EvidenceSource = z.enum([
  'network',
  'console',
  'dom',
  'server_log',
  'code',
  'requirement',
  'test',
  'environment',
]);
export const DiagnosisMode = z.enum(['full', 'no-tools']);

export const Diagnosis = z
  .object({
    id: DiagnosisId,
    testCaseIds: z.array(ScriptTestId).min(1),
    classification: Classification,
    confidence: z.number().min(0).max(1),
    summary: z.string().min(1),
    rootCause: z.string().min(1),
    location: Evidence.nullish(),
    evidence: z.array(
      z.object({
        source: EvidenceSource,
        detail: z.string().min(1),
      }),
    ),
    violatedRequirementIds: z.array(RequirementId),
    suggestedFix: z
      .object({
        description: z.string().min(1),
        patch: z.string().optional(),
      })
      .nullish(),
    toolCalls: z.number().int().nonnegative(),
    durationMs: DurationMs,
  })
  .refine((d) => d.classification !== 'app_defect' || d.location != null, {
    message: 'location is required for app_defect',
    path: ['location'],
  });

export const Diagnoses = z.object({
  schemaVersion: SchemaVersion,
  execId: ExecId,
  mode: DiagnosisMode,
  generatedAt: Timestamp,
  diagnoses: z.array(Diagnosis),
});

export type Classification = z.infer<typeof Classification>;
export type Diagnosis = z.infer<typeof Diagnosis>;
export type Diagnoses = z.infer<typeof Diagnoses>;

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

// ---------------------------------------------------------------------------
// targets/<name>/variants.json — written by the evaluation harness or by hand
// ---------------------------------------------------------------------------

export const CodeVariant = z.strictObject({
  id: CodeVariantId,
  kind: z.literal('code'),
  branch: z.string().min(1),
  patch: RelPath,
  layer: z.enum(['backend', 'frontend']),
  /** null only for hand-seeded bugs (method "manual"). */
  mutator: z.string().min(1).nullable(),
  file: RelPath,
  lines: LineRange,
  original: z.string(),
  mutated: z.string(),
  expectedClassification: Classification,
});

export const EnvironmentVariant = z.strictObject({
  id: EnvVariantId,
  kind: z.literal('environment'),
  configOverride: ConfigOverride.optional(),
  skipSeed: z.boolean().default(false),
  description: z.string().min(1),
  expectedClassification: Classification,
});

export const Variant = z.discriminatedUnion('kind', [CodeVariant, EnvironmentVariant]);

export const Variants = z
  .strictObject({
    schemaVersion: SchemaVersion,
    target: z.string().min(1),
    goldenRef: z.string().min(1),
    goldenCommit: CommitSha,
    method: z.enum(['stryker', 'manual']),
    /** null only for method "manual". */
    seed: z.number().int().nullable(),
    variants: z.array(Variant),
  })
  .superRefine((v, ctx) => {
    if (v.method === 'manual') return;
    if (v.seed === null) {
      ctx.addIssue({ code: 'custom', message: 'seed may be null only when method is "manual"', path: ['seed'] });
    }
    v.variants.forEach((variant, i) => {
      if (variant.kind === 'code' && variant.mutator === null) {
        ctx.addIssue({
          code: 'custom',
          message: 'mutator may be null only when method is "manual"',
          path: ['variants', i, 'mutator'],
        });
      }
    });
  });

export type Variant = z.infer<typeof Variant>;
export type Variants = z.infer<typeof Variants>;

// ---------------------------------------------------------------------------
// One-prompt ablation submission
// ---------------------------------------------------------------------------

export const OnePromptScript = z.object({
  id: OnePromptScriptId,
  title: z.string().min(1),
  code: z.string().min(1),
});

export const OnePromptSubmission = z.object({
  scripts: z.array(OnePromptScript).min(1).max(MAX_TEST_CASES),
});

export type OnePromptScript = z.infer<typeof OnePromptScript>;
