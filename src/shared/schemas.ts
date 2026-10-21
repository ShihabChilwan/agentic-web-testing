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
/** Execution ids appear in folder names, so they are restricted to safe characters. Opaque in practice: x-01, x-02, … */
export const ExecId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'expected an execution id like x-07');
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

/** One request after seeding that proves the seed worked; a failed check stops the start. */
export const SeedCheck = z.strictObject({
  method: HttpMethod,
  path: z.string().startsWith('/'),
  body: z.unknown().optional(),
  expect: z.strictObject({
    status: z.number().int().min(100).max(599),
    /** Dot path into the JSON response (e.g. `products` or `data.items`) that must hold a non-empty array. */
    nonEmptyArrayAt: z.string().regex(/^[^.]+(\.[^.]+)*$/, 'expected a dot path like products or data.items').optional(),
  }),
});

/** A Playwright locator described as data: exactly one of role (with optional name), label, placeholder, text, testId. */
export const Locator = z
  .strictObject({
    role: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    placeholder: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    testId: z.string().min(1).optional(),
  })
  .refine((l) => [l.role, l.label, l.placeholder, l.text, l.testId].filter(Boolean).length === 1, 'give exactly one of role, label, placeholder, text, testId')
  .refine((l) => !l.name || l.role, 'name goes with role');
export type Locator = z.infer<typeof Locator>;

/** How to log in as a fixture user over HTTP: the token goes into a header on later requests. */
export const TargetAuth = z.strictObject({
  login: z.strictObject({
    method: HttpMethod,
    path: z.string().startsWith('/'),
    /** `{{user.<field>}}` placeholders resolve against the fixture user. */
    body: z.unknown(),
  }),
  /** Dot path of the token in the login response body. */
  tokenAt: z.string().min(1),
  header: z.string().min(1),
  /** Put before the token in the header (e.g. "Bearer "); "" when the token already includes it. */
  prefix: z.string().default(''),
  /** Where the frontend keeps the login token, so a test page can start logged in (`loggedInPage`). */
  storage: z.strictObject({ kind: z.enum(['localStorage', 'sessionStorage']), key: z.string().min(1) }).optional(),
  /** The frontend's login form, for `loginViaUi`. Field names are fixture user fields (e.g. email, password). */
  uiLogin: z
    .strictObject({
      path: z.string().startsWith('/'),
      fields: z.record(z.string(), Locator),
      submit: Locator,
      /** After submitting, wait until the URL no longer contains this. */
      waitFor: z.strictObject({ urlNot: z.string().min(1) }).optional(),
    })
    .optional(),
});

/** One request whose answer on golden is recorded in facts.json (SPEC §7.4). */
export const FactRequest = z.strictObject({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/, 'expected a name like productList'),
  method: HttpMethod,
  /** May use `{{facts.<earlier name>.body.<path>}}`, filled from an earlier fact's full response (URL-encoded). */
  path: z.string().startsWith('/'),
  body: z.unknown().optional(),
  /** A fixture user path to log in as (e.g. "users.alice"), or null for no token. */
  as: z.string().min(1).nullable().default(null),
  /** Dot paths to keep, `[]` for every item (e.g. "products[].name"); all of the body when left out. */
  keep: z.array(z.string().min(1)).optional(),
  maxItems: z.number().int().positive().default(5),
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
  frontend: ServiceConfig.extend({
    /** Folders holding the frontend's own source (pages, components), relative to the repo root. Default: [cwd]. */
    sourceRoots: z.array(RelPath).min(1).optional(),
  }),
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
  seedCheck: SeedCheck.optional(),
  auth: TargetAuth.optional(),
  facts: z.array(FactRequest).optional(),
  sourceHints: z.strictObject({
    include: z.array(z.string()),
    exclude: z.array(z.string()),
  }),
  forbiddenPaths: z.array(z.string()),
});

export type TargetConfig = z.infer<typeof TargetConfig>;
export type FixtureUser = z.infer<typeof FixtureUser>;
export type SeedCheck = z.infer<typeof SeedCheck>;
export type TargetAuth = z.infer<typeof TargetAuth>;
export type FactRequest = z.infer<typeof FactRequest>;

/** targets/<name>/facts.json: answers observed on golden (SPEC §7.4). Committed: never holds tokens or headers. */
export const TargetFacts = z.object({
  schemaVersion: SchemaVersion,
  target: z.string().min(1),
  goldenCommit: CommitSha,
  observedAt: Timestamp,
  facts: z.array(
    z.object({
      name: z.string().min(1),
      request: z.object({ method: HttpMethod, path: z.string().startsWith('/'), as: z.string().nullable() }),
      status: z.number().int(),
      /** The trimmed JSON body, or the text body. */
      body: z.unknown(),
      truncated: z.boolean(),
    }),
  ),
});
export type TargetFacts = z.infer<typeof TargetFacts>;

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
  /** provider: exact cost reported in the response; pricing: computed from config/pricing.json; null: unknown. */
  costSource: z.enum(['provider', 'pricing']).nullable().optional(),
  cachedInputTokens: TokenCount.optional(),
  reasoningTokens: TokenCount.optional(),
  /** Upstream provider that served the call, when a router reports it (e.g. OpenRouter). */
  upstreamProvider: z.string().min(1).optional(),
  systemFingerprint: z.string().min(1).optional(),
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

/** One pass/fail check of a requirement, with the code that shows it. */
export const AcceptanceCriterion = z.object({
  text: z.string().min(1),
  evidence: z.array(Evidence).min(1),
});

export const MAX_CRITERIA_PER_REQUIREMENT = 4;

export const PrdRequirement = z.object({
  id: RequirementId,
  featureId: FeatureId,
  layer: RequirementLayer,
  statement: z.string().min(1),
  acceptanceCriteria: z.array(AcceptanceCriterion).min(1).max(MAX_CRITERIA_PER_REQUIREMENT),
  priority: Priority,
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
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterion>;

/** A requirement's evidence: the union of its criteria's evidence, without duplicates (derived, not stored). */
export function requirementEvidence(requirement: PrdRequirement): Evidence[] {
  const seen = new Set<string>();
  return requirement.acceptanceCriteria.flatMap((c) =>
    c.evidence.filter((e) => {
      const key = `${e.file}:${e.lines[0]}-${e.lines[1]}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
}

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

export const UncoveredReasonKind = z.enum(['third-party-disabled', 'data-not-reachable', 'out-of-scope', 'other']);

/** A requirement with no test case: declined by the model with a reason, or left uncovered after the gap round. */
export const UncoveredRequirement = z.object({
  requirementId: RequirementId,
  /** Defaults to "other" for files written before the field existed. */
  reasonKind: UncoveredReasonKind.default('other'),
  reason: z.string().min(1),
});

/** A covered requirement whose cases leave out a part the model said cannot be tested (e.g. an email-only happy path). */
export const PartlyCoveredRequirement = z.object({
  requirementId: RequirementId,
  reason: z.string().min(1),
});

export const TestCaseCoverage = z.object({
  requirementsTotal: z.number().int().nonnegative(),
  requirementsCovered: z.number().int().nonnegative(),
  uncovered: z.array(UncoveredRequirement),
  /** Covered requirements with a part declined as untestable; the reasons are kept here. */
  partial: z.array(PartlyCoveredRequirement).default([]),
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
export type TestCategory = z.infer<typeof TestCategory>;
export type UncoveredReasonKind = z.infer<typeof UncoveredReasonKind>;
export type UncoveredRequirement = z.infer<typeof UncoveredRequirement>;
export type PartlyCoveredRequirement = z.infer<typeof PartlyCoveredRequirement>;

// ---------------------------------------------------------------------------
// Module 3 — scripts/manifest.json (also used by the one-prompt ablation)
// ---------------------------------------------------------------------------

export const ScriptStatus = z.enum(['validated', 'invalid']);
export const ValidationOutcome = z.enum(['passed', 'assertion_failed']);
/** `submit`: the model's submission did not reach the checks (e.g. no valid submit at all). */
export const AttemptStage = z.enum(['submit', 'typecheck', 'lock-check', 'dry-run']);
/**
 * Why an attempt failed. A dry-run failure is only an app disagreement (outcome assertion_failed) when a
 * locked value was compared and differed (§6.2); these are the other kinds, kept for review.
 */
export const FailureCategory = z.enum([
  'no-submit',
  'typecheck',
  'lock-check',
  /** An E-id expect without a locked value failed (e.g. "is visible"): possibly a real disagreement. */
  'value-less-expect',
  /** The locator found nothing, or several elements (strict mode). */
  'locator',
  'timeout',
  /** Any other error: TypeError, connection refused, a failing setup step. */
  'runtime-error',
  /** The test changed a fixture user (a fixture login failed afterwards); the data was restored. */
  'fixture-mutation',
]);

export const ScriptAttempt = z.object({
  attempt: z.number().int().min(1),
  stage: AttemptStage,
  error: z.string().nullable(),
  /** Set for a failed attempt. */
  category: FailureCategory.optional(),
  durationMs: DurationMs,
});

/**
 * An invalid entry written before `failureCategory` existed gets its last attempt's category (or
 * `no-submit`), so older manifests still read; the rule below then holds for every file.
 */
const withFailureCategory = (value: unknown) => {
  if (!value || typeof value !== 'object') return value;
  const entry = value as { status?: unknown; failureCategory?: unknown; attemptLog?: Array<{ category?: unknown }> };
  if (entry.status !== 'invalid' || (entry.failureCategory !== undefined && entry.failureCategory !== null)) return value;
  const last = Array.isArray(entry.attemptLog) ? entry.attemptLog.at(-1)?.category : undefined;
  return { ...entry, failureCategory: last ?? 'no-submit' };
};

export const ScriptManifestEntry = z.preprocess(withFailureCategory, z
  .object({
    testCaseId: ScriptTestId,
    file: RelPath,
    status: ScriptStatus,
    validationOutcome: ValidationOutcome.nullable(),
    attempts: z.number().int().min(1),
    attemptLog: z.array(ScriptAttempt).min(1),
    /** For an invalid script: the category of its last failed attempt, so it can be reviewed by hand. */
    failureCategory: FailureCategory.nullable().default(null),
  })
  .refine((s) => (s.status === 'validated') === (s.validationOutcome !== null), {
    message: 'validationOutcome must be set for validated scripts and null for invalid ones',
    path: ['validationOutcome'],
  })
  .refine((s) => (s.status === 'invalid') === (s.failureCategory !== null), {
    message: 'failureCategory must be set for invalid scripts and null for validated ones',
    path: ['failureCategory'],
  }));

export const ScriptManifest = z.object({
  schemaVersion: SchemaVersion,
  generationRef: z.string().min(1),
  /**
   * sha256 of the helpers the scripts were written against (_helpers.ts plus the target's auth settings).
   * A rerun keeps validated scripts only when it matches; absent in manifests written before it existed.
   */
  helpersHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  scripts: z.array(ScriptManifestEntry),
});

export type ScriptManifest = z.infer<typeof ScriptManifest>;
export type ScriptManifestEntry = z.infer<typeof ScriptManifestEntry>;
export type ScriptAttempt = z.infer<typeof ScriptAttempt>;
export type FailureCategory = z.infer<typeof FailureCategory>;

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
  /** A unified diff applied on top of `ref` in the execution's source tree (path relative to the project root). */
  patch: z.string().min(1).optional(),
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

/** Outcome of the target's seedCheck (§1.2); recorded on every start where the check ran. */
export const SeedCheckResult = z.object({
  ok: z.boolean(),
  /** null when no HTTP response came back. */
  status: z.number().int().nullable(),
  /** "ok", or what was wrong (status, response excerpt or missing array). */
  detail: z.string(),
});

export const TestArtifacts = z.object({
  screenshot: RelPath.optional(),
  trace: RelPath.optional(),
  dom: RelPath.optional(),
  network: RelPath.optional(),
  console: RelPath.optional(),
  lastResponse: RelPath.optional(),
  /** The backend log lines written during this test only. */
  serverLog: RelPath.optional(),
});

/** The step 5 classifier's label for a non-passed result (§6.2, §7.3); `not-run` when the report has no result. */
export const ResultCategory = z.enum(['assertion_failed', 'value-less-expect', 'locator', 'timeout', 'runtime-error', 'not-run']);

export const TestResult = z.object({
  testCaseId: ScriptTestId,
  status: TestStatus,
  /** True only when the data restore before this test succeeded (§7.2). Never assumed for older files. */
  isolated: z.boolean().default(false),
  durationMs: DurationMs,
  error: z
    .object({
      message: z.string(),
      expectationId: ExpectationId.nullable().optional(),
      category: ResultCategory.optional(),
      stack: z.string().optional(),
    })
    .optional(),
  artifacts: TestArtifacts,
});

export const SkippedScript = z.object({
  testCaseId: ScriptTestId,
  /** The script's dry-run outcome: only scripts that passed are executed. */
  reason: z.enum(['assertion_failed', 'invalid']),
});

export const IncidentKind = z.enum([
  'backend-crashed',
  'frontend-restarted',
  'frontend-restart-failed',
  'restore-failed',
  'restore-problem',
  'restores-given-up',
]);

/** Something that went wrong with the app or the restores during the run, and where (§7.2). */
export const Incident = z.object({
  /** The test about to run; null after the last test. */
  beforeTestCaseId: ScriptTestId.nullable(),
  kind: IncidentKind,
  detail: z.string(),
});

export const ExecutionResults = z.object({
  schemaVersion: SchemaVersion,
  execId: ExecId,
  startedAt: Timestamp,
  finishedAt: Timestamp,
  environment: z.object({
    healthChecks: z.array(HealthCheckResult),
    seed: z.array(SeedResult),
    /** Absent when the target has no seedCheck or the check was skipped. */
    seedCheck: SeedCheckResult.optional(),
  }),
  summary: z.object({
    /** Executed tests. */
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    errored: z.number().int().nonnegative(),
    /** Scripts not executed (their dry run did not pass). */
    skipped: z.number().int().nonnegative().default(0),
    /** Results with isolated: false. */
    notIsolated: z.number().int().nonnegative().default(0),
  }),
  skipped: z.array(SkippedScript).default([]),
  incidents: z.array(Incident).default([]),
  timing: z
    .object({
      startupMs: DurationMs,
      suiteMs: DurationMs,
      restores: z.number().int().nonnegative(),
      restoreMs: DurationMs,
    })
    .optional(),
  results: z.array(TestResult),
});

export type ConfigOverride = z.infer<typeof ConfigOverride>;
export type ExecutionRequest = z.infer<typeof ExecutionRequest>;
export type ExecutionResults = z.infer<typeof ExecutionResults>;
export type TestResult = z.infer<typeof TestResult>;
export type TestArtifacts = z.infer<typeof TestArtifacts>;
export type ResultCategory = z.infer<typeof ResultCategory>;
export type Incident = z.infer<typeof Incident>;
export type IncidentKind = z.infer<typeof IncidentKind>;
export type SkippedScript = z.infer<typeof SkippedScript>;
export type HealthCheckResult = z.infer<typeof HealthCheckResult>;
export type SeedResult = z.infer<typeof SeedResult>;
export type SeedCheckResult = z.infer<typeof SeedCheckResult>;

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

export const DiagnosesSummary = z.object({
  groups: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
  /** Sessions that ended without an accepted submit; their tests got an inconclusive diagnosis. */
  failedSessions: z.number().int().nonnegative(),
  /** Model calls (turns). */
  calls: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  /** Sum of this analysis' lines in llm-calls.jsonl; null when none had a cost. */
  costUsd: z.number().nonnegative().nullable(),
  durationMs: DurationMs,
});

export const Diagnoses = z.object({
  schemaVersion: SchemaVersion,
  execId: ExecId,
  mode: DiagnosisMode,
  generatedAt: Timestamp,
  diagnoses: z.array(Diagnosis),
  /** Absent in files written before it existed. */
  summary: DiagnosesSummary.optional(),
});

export type Classification = z.infer<typeof Classification>;
export type Diagnosis = z.infer<typeof Diagnosis>;
export type Diagnoses = z.infer<typeof Diagnoses>;
export type DiagnosesSummary = z.infer<typeof DiagnosesSummary>;

// ---------------------------------------------------------------------------
// run.json
// ---------------------------------------------------------------------------

export const StageStatus = z.enum(['pending', 'running', 'done', 'failed', 'stale']);
export const ExecutionStepStatus = z.enum(['pending', 'running', 'done', 'failed']);

/** What the stage's agent session did; written when the session ends, whether it succeeded or failed. */
export const StageAgentSummary = z.object({
  turns: z.number().int().nonnegative(),
  /** Exploring calls (tools that count toward the budget). */
  toolCalls: z.number().int().nonnegative(),
  /** The runaway ceiling for exploring calls. */
  toolCallCeiling: z.number().int().positive(),
  explorationCeilingHit: z.boolean(),
  /** Calls per tool, recording tools included. */
  toolCallsByTool: z.record(z.string(), z.number().int().nonnegative()),
  /** Recording calls rejected: input that failed the tool schema, or a batch that failed the code checks. */
  rejected: z.object({
    invalidInput: z.number().int().nonnegative(),
    checkFailed: z.number().int().nonnegative(),
  }),
});

const count = z.number().int().nonnegative();

/**
 * Counts per enum value. Every key defaults to 0, so a run.json written before a value was added
 * (e.g. a new failure category) still reads; an exhaustive z.record(enum, …) would reject it.
 */
const countsBy = <const K extends string>(keys: z.ZodEnum<{ [k in K]: k }>) =>
  z.object(Object.fromEntries(keys.options.map((k) => [k, count.default(0)])) as { [k in K]: z.ZodDefault<typeof count> });

/** What a generation stage made (Test Case Generator): many short model sessions rather than one agent. */
export const StageGenerationSummary = z.object({
  /** Model calls in the stage. */
  calls: count,
  /** Feature sessions plus gap-round sessions. */
  sessions: count,
  casesByLayer: countsBy(TestLayer),
  casesByCategory: countsBy(TestCategory),
  uncoveredByReasonKind: countsBy(UncoveredReasonKind),
  /** Rejected submits: input that failed the submit schema, or output that failed the code checks. */
  rejected: z.object({ invalidInput: count, checkFailed: count }),
  /** Sum of this stage's provider-reported or priced costs; null when no call had a cost. */
  costUsd: z.number().nonnegative().nullable(),
  /** E.g. a high-priority requirement without a negative case. */
  warnings: z.array(z.string()),
});

/** What the script stage made (Test Script Generator): one fix loop per test case. */
export const StageScriptsSummary = z.object({
  cases: count,
  /** Validated scripts kept from an earlier, interrupted run of the stage (not generated again). */
  resumed: count.default(0),
  validated: z.object({ passed: count, assertionFailed: count }),
  invalid: count,
  /** Scripts by the number of attempts they used. */
  attemptsHistogram: z.record(z.string(), count),
  /** Failed attempts by where they failed. */
  failuresByStage: countsBy(AttemptStage),
  /** Invalid scripts by the category of their last failure (review value-less-expect by hand). */
  invalidByCategory: countsBy(FailureCategory),
  /** Test case ids of the invalid scripts, per category. */
  invalidCases: z.record(z.string(), z.array(z.string())),
  calls: count,
  costUsd: z.number().nonnegative().nullable(),
  /** Total time spent in dry runs (they run one at a time). */
  dryRunMs: DurationMs,
  /** Data restores (reset + seed + backend restart) after dry runs, and their total time. */
  restores: count.default(0),
  restoreMs: DurationMs.default(0),
  playwrightVersion: z.string().min(1),
  warnings: z.array(z.string()),
});

export const StageState = z.object({
  status: StageStatus,
  startedAt: Timestamp.optional(),
  finishedAt: Timestamp.optional(),
  /** Why the stage failed (e.g. LLMBudgetExceededError). No secrets. */
  error: z.string().optional(),
  agent: StageAgentSummary.optional(),
  generation: StageGenerationSummary.optional(),
  scripts: StageScriptsSummary.optional(),
});

const PerModule = <T extends z.ZodType>(value: T) =>
  z.object({ prd: value, cases: value, scripts: value, analyzer: value });

export const RunExecution = z.object({
  execId: ExecId,
  ref: z.string().min(1),
  commit: CommitSha,
  /** The patch applied on top of the ref (relative to the project root); used only to build the source tree. */
  patch: z.string().min(1).optional(),
  skipSeed: z.boolean().optional(),
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
    /** Distinct upstream providers seen in the run's call log, sorted (e.g. ["Wafer"]). */
    upstreamProviders: z.array(z.string().min(1)).optional(),
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
export type StageAgentSummary = z.infer<typeof StageAgentSummary>;
export type StageGenerationSummary = z.infer<typeof StageGenerationSummary>;
export type StageScriptsSummary = z.infer<typeof StageScriptsSummary>;
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

// ---------------------------------------------------------------------------
// Module 6 — run view model (SPEC §9.1): what the report and the dashboard render
// ---------------------------------------------------------------------------

export const ViewStage = z.object({
  name: z.enum(['prd', 'cases', 'scripts']),
  status: StageStatus,
  startedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
  durationMs: DurationMs.nullable(),
  /** Model calls of the stage's purpose inside its time window. */
  calls: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
});

export const ScriptOutcomeView = z.enum(['passed', 'assertion_failed', 'invalid', 'none']);

export const ViewRequirement = z.object({
  id: RequirementId,
  featureId: FeatureId,
  feature: z.string(),
  statement: z.string(),
  priority: Priority,
  layer: z.string(),
  /** Why no test case covers it; null when covered. */
  uncovered: z.string().nullable(),
  /** The part that cannot be tested; null when fully testable. */
  partial: z.string().nullable(),
  testCases: z.array(
    z.object({
      id: TestCaseId,
      title: z.string(),
      layer: z.string(),
      category: z.string(),
      outcome: ScriptOutcomeView,
      failureCategory: z.string().nullable(),
    }),
  ),
});

export const ViewFailure = z.object({
  message: z.string(),
  expectationId: ExpectationId.nullable(),
  category: z.string().nullable(),
  expected: z.string().nullable(),
  received: z.string().nullable(),
  /** A data:image/png;base64 URI (embedded), or null. */
  screenshot: z.string().nullable(),
  /** Relative to the run folder; open with `npx playwright show-trace`. */
  trace: RelPath.nullable(),
  excerpts: z.object({
    network: z.string().nullable(),
    console: z.string().nullable(),
    serverLog: z.string().nullable(),
    lastResponse: z.string().nullable(),
  }),
  diagnosisId: DiagnosisId.nullable(),
  noToolsDiagnosisId: DiagnosisId.nullable(),
});

export const ViewTestStatus = z.enum(['passed', 'failed', 'errored', 'skipped']);

export const ViewTest = z.object({
  testCaseId: ScriptTestId,
  title: z.string(),
  status: ViewTestStatus,
  /** Set for skipped tests: their dry-run outcome. */
  skipReason: z.enum(['assertion_failed', 'invalid']).optional(),
  isolated: z.boolean(),
  durationMs: DurationMs,
  requirementIds: z.array(RequirementId),
  failure: ViewFailure.optional(),
});

export const ViewExecution = z.object({
  execId: ExecId,
  /** For people: the ref, plus "+ <patch file name>", plus ", seed skipped". */
  label: z.string(),
  ref: z.string(),
  commit: CommitSha,
  patch: z.string().nullable(),
  skipSeed: z.boolean(),
  executeStatus: ExecutionStepStatus,
  analyzeStatus: ExecutionStepStatus,
  error: z.string().nullable(),
  startedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
  /** Null when results.json is missing (e.g. a failed execution). */
  summary: ExecutionResults.shape.summary.nullable(),
  timing: ExecutionResults.shape.timing.unwrap().nullable(),
  environment: ExecutionResults.shape.environment.nullable(),
  incidents: z.array(Incident),
  analysis: z.object({ full: DiagnosesSummary.nullable(), noTools: DiagnosesSummary.nullable() }),
  tests: z.array(ViewTest),
  diagnoses: z.array(Diagnosis).nullable(),
  noToolsDiagnoses: z.array(Diagnosis).nullable(),
});

export const ComparisonKind = z.enum(['newly-failing', 'fixed', 'failure-changed', 'only-in-one']);

export const ComparisonRow = z.object({
  testCaseId: ScriptTestId,
  from: ViewTestStatus.nullable(),
  to: ViewTestStatus.nullable(),
  kind: ComparisonKind,
});

export const RunView = z.object({
  schemaVersion: SchemaVersion,
  generatedAt: Timestamp,
  run: z.object({
    runId: z.string(),
    target: z.string(),
    generationRef: z.string(),
    generationCommit: CommitSha,
    createdAt: Timestamp,
    models: z.record(z.string(), z.string()),
    upstreamProviders: z.array(z.string()),
    playwrightVersion: z.string().nullable(),
  }),
  stages: z.array(ViewStage),
  coverage: z.object({
    requirements: z.number().int().nonnegative(),
    covered: z.number().int().nonnegative(),
    partial: z.number().int().nonnegative(),
    testCases: z.number().int().nonnegative(),
    scripts: z.object({
      passed: z.number().int().nonnegative(),
      assertionFailed: z.number().int().nonnegative(),
      invalid: z.number().int().nonnegative(),
      none: z.number().int().nonnegative(),
    }),
  }),
  requirements: z.array(ViewRequirement),
  executions: z.array(ViewExecution),
  /** Keyed "<a>|<b>" in run.json order; only tests whose status differs. */
  comparisons: z.record(z.string(), z.array(ComparisonRow)),
});

export type RunView = z.infer<typeof RunView>;
export type ViewStage = z.infer<typeof ViewStage>;
export type ViewRequirement = z.infer<typeof ViewRequirement>;
export type ViewExecution = z.infer<typeof ViewExecution>;
export type ViewTest = z.infer<typeof ViewTest>;
export type ViewTestStatus = z.infer<typeof ViewTestStatus>;
export type ViewFailure = z.infer<typeof ViewFailure>;
export type ComparisonRow = z.infer<typeof ComparisonRow>;
export type ComparisonKind = z.infer<typeof ComparisonKind>;
