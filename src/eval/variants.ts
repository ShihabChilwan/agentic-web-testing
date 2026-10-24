import { appendFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildSourceTree, resolveCommit } from '../modules/execution-engine/index.js';
import { observeApp, type AppObservation } from '../modules/execution-engine/probe.js';
import { makeRunId, RUNS_DIR, TARGETS_DIR, targetPaths } from '../shared/paths.js';
import { EvaluationConfig, Variants, type CodeVariant, type TargetConfig, type Variant } from '../shared/schemas.js';
import { loadTargetConfig } from '../shared/target-config.js';
import { applyMutant, filePatch, mutantLines } from './patch.js';
import { candidatesFrom, changedLines, draw, shuffle, type Candidate, type DevBugLines } from './sample.js';
import { startCheck, startFailure, type StartObservation } from './start-check.js';
import { listMutants, MUTATORS } from './stryker.js';

/** Same as the localization line tolerance (SPEC §11.5, §12). */
export const OVERLAP_LINES = 5;

export interface CreateVariantsOptions {
  target: string;
  /** Overrides evaluation.json's seed. */
  seed?: number;
  /** Stop after listing the candidates. */
  listOnly?: boolean;
  /** Only check the environment faults (no Stryker, nothing written to targets/). */
  envOnly?: boolean;
  /** Overwrite an existing variants.json. */
  force?: boolean;
  targetsDir?: string;
  runsDir?: string;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export interface EnvCheck {
  id: string;
  starts: Array<StartObservation & { app: AppObservation | null }>;
  repeatable: boolean;
}

export interface CreateVariantsResult {
  workDir: string;
  candidates: { backend: number; frontend: number };
  mutants: number;
  variants?: Variants;
  envChecks?: EnvCheck[];
}

/** Reads and validates targets/<name>/evaluation.json. */
export async function loadEvaluationConfig(dir: string): Promise<EvaluationConfig> {
  const file = path.join(dir, 'evaluation.json');
  const text = await readFile(file, 'utf8').catch(() => {
    throw new Error(`No evaluation inputs at ${file}`);
  });
  return EvaluationConfig.parse(JSON.parse(text));
}

/**
 * The changed lines of every patch under targets/<name>/dev-bugs/, at any depth: the hand-written dev bugs and
 * earlier trial draws (SPEC §11.2 step 4). Each is named by its path inside dev-bugs/.
 */
export async function readDevBugs(targetDir: string): Promise<DevBugLines[]> {
  const dir = path.join(targetDir, 'dev-bugs');
  const names = await readdir(dir, { recursive: true }).catch(() => [] as string[]);
  const out: DevBugLines[] = [];
  for (const name of names.filter((n) => n.endsWith('.patch')).sort()) {
    out.push(...changedLines(name.split(path.sep).join('/'), await readFile(path.join(dir, name), 'utf8')));
  }
  return out;
}

/** What two starts of one fault must share: everything but console errors (SPEC §11.3). */
export function envSignature(start: StartObservation & { app: AppObservation | null }): string {
  const { app, ...observation } = start;
  return JSON.stringify({ ...observation, app: app && { ...app, page: { document: app.page.document, requests: app.page.requests } } });
}

/**
 * `eval variants` (SPEC §11.2–11.4): lists mutants with Stryker on a golden source tree, draws the code
 * variants with the seed and start-checks each patch, checks every environment fault on two starts, and
 * writes targets/<name>/variants.json and variants/*.patch only when everything succeeded.
 */
export async function createVariants(options: CreateVariantsOptions): Promise<CreateVariantsResult> {
  const targetsDir = options.targetsDir ?? TARGETS_DIR;
  const { config, targetDir, repoDir } = await loadTargetConfig(options.target, { targetsDir });
  const evaluation = await loadEvaluationConfig(targetDir);
  const seed = options.seed ?? evaluation.seed;
  const paths = targetPaths(options.target, targetsDir);
  const writes = !options.listOnly && !options.envOnly;
  if (writes && !options.force && (await stat(paths.variants).then(() => true, () => false))) {
    throw new Error(`${paths.variants} exists; the variant list is fixed before the final runs (use --force to replace it)`);
  }
  const workDir = path.join(options.runsDir ?? RUNS_DIR, makeRunId(`variants-${options.target}`));
  await mkdir(workDir, { recursive: true });
  const logFile = path.join(workDir, 'variants.log');
  const log = (message: string) => {
    appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
    options.log?.(message);
  };
  const commit = await resolveCommit(repoDir, config.goldenRef);
  log(`Golden ${config.goldenRef} = ${commit.slice(0, 7)}; seed ${seed}; work folder ${workDir}`);
  const common = { config, repoDir, targetDir, commit, buildErrorPattern: evaluation.buildErrorPattern, ...(options.signal ? { signal: options.signal } : {}) };

  const result: CreateVariantsResult = { workDir, candidates: { backend: 0, frontend: 0 }, mutants: 0 };
  let codeVariants: CodeVariant[] = [];
  let stryker: Variants['stryker'] = null;
  let discards: Variants['discards'] = [];
  const patches = new Map<string, string>();

  if (!options.envOnly) {
    log('Listing mutants with Stryker (no-op command runner)...');
    const tree = await buildSourceTree({ repoDir, commit });
    const list = await listMutants(tree.dir, evaluation.mutate, workDir).finally(() => tree.remove());
    const candidates = candidatesFrom(list.report, evaluation.mutate);
    const count = (layer: Candidate['layer']) => candidates.filter((c) => c.layer === layer).length;
    result.mutants = list.mutants;
    result.candidates = { backend: count('backend'), frontend: count('frontend') };
    log(`Stryker ${list.version}: ${list.mutants} mutants in ${Object.keys(list.report.files).length} files; candidates backend ${result.candidates.backend}, frontend ${result.candidates.frontend}`);
    if (options.listOnly) return result;
    stryker = { version: list.version, mutate: evaluation.mutate, mutators: [...MUTATORS], mutants: list.mutants, candidates: candidates.length, mutationJsonSha256: list.sha256 };

    const devBugs = await readDevBugs(targetDir);
    log(`Dev-bug lines: ${devBugs.map((d) => `${d.file} ${d.lines.join(',')}`).join('; ') || 'none'}`);
    const lines = new Map<string, ReturnType<typeof mutantLines>>();
    const health = new Map<string, StartObservation['healthChecks']>();
    await mkdir(path.join(workDir, 'patches'), { recursive: true });
    const drawn = await draw(shuffle(candidates, seed), { quota: evaluation.codeVariants, window: OVERLAP_LINES, devBugs }, async (c, attempt) => {
      const source = list.report.files[c.file]!.source;
      const mutated = applyMutant(source, c);
      const patch = await filePatch(c.file, source, mutated);
      const patchFile = path.join(workDir, 'patches', `m${c.mutantId}.patch`);
      await writeFile(patchFile, patch);
      log(`[${attempt}] mutant ${c.mutantId} ${c.mutator} ${c.file}:${c.lines.join('-')}: starting`);
      const checked = await startCheck({ ...common, patchFile, logsDir: path.join(workDir, 'starts', `${String(attempt).padStart(2, '0')}-m${c.mutantId}`) });
      if ('patchFailed' in checked) {
        log(`[${attempt}] discarded: patch-failed: ${checked.patchFailed}`);
        return { ok: false, reason: 'patch-failed', detail: checked.patchFailed };
      }
      const failure = startFailure(checked.observation);
      if (failure) {
        log(`[${attempt}] discarded: start-failed: ${failure}`);
        return { ok: false, reason: 'start-failed', detail: failure };
      }
      const hc = checked.observation.healthChecks;
      log(`[${attempt}] kept (health checks: backend ${hc.backend ? 'ok' : 'FAILED'}, frontend ${hc.frontend ? 'ok' : 'FAILED'})`);
      patches.set(c.mutantId, patch);
      lines.set(c.mutantId, mutantLines(source, mutated, c));
      health.set(c.mutantId, hc);
      return { ok: true };
    });
    discards = drawn.discards;
    codeVariants = drawn.accepted.map((c, i) => ({
      id: `bug-${String(i + 1).padStart(3, '0')}`,
      kind: 'code',
      patch: `variants/bug-${String(i + 1).padStart(3, '0')}.patch`,
      layer: c.layer,
      mutator: c.mutator,
      strykerMutantId: c.mutantId,
      file: c.file,
      lines: c.lines,
      ...lines.get(c.mutantId)!,
      healthChecks: health.get(c.mutantId)!,
      expectedClassification: 'app_defect',
    }));
  }

  result.envChecks = await checkEnvironmentFaults(config, evaluation, common, workDir, log);
  const unrepeatable = result.envChecks.filter((c) => !c.repeatable).map((c) => c.id);
  if (unrepeatable.length > 0) throw new Error(`Environment faults not repeatable on two starts: ${unrepeatable.join(', ')}; see ${workDir}/env-checks.json`);
  if (!writes) return result;

  const environmentVariants: Variant[] = evaluation.environmentFaults.map((f) => ({
    id: f.id,
    kind: 'environment',
    ...(f.configOverride ? { configOverride: f.configOverride } : {}),
    skipSeed: f.skipSeed,
    description: f.description,
    expectedClassification: 'environment_issue',
  }));
  const variants = Variants.parse({
    schemaVersion: '1.0',
    target: options.target,
    goldenRef: config.goldenRef,
    goldenCommit: commit,
    method: 'stryker',
    seed,
    stryker,
    overlapLines: OVERLAP_LINES,
    variants: [...codeVariants, ...environmentVariants],
    discards,
  });
  await rm(paths.variantsDir, { recursive: true, force: true });
  await mkdir(paths.variantsDir, { recursive: true });
  for (const v of codeVariants) await writeFile(path.join(targetDir, v.patch), patches.get(v.strykerMutantId!)!);
  await writeFile(paths.variants, `${JSON.stringify(variants, null, 2)}\n`);
  log(`Wrote ${paths.variants}: ${codeVariants.length} code and ${environmentVariants.length} environment variants, ${discards.length} discards`);
  result.variants = variants;
  return result;
}

/** One golden start as the control, then two starts per environment fault (SPEC §11.3); writes env-checks.json. */
async function checkEnvironmentFaults(
  config: TargetConfig,
  evaluation: EvaluationConfig,
  common: Omit<Parameters<typeof startCheck>[0], 'logsDir'>,
  workDir: string,
  log: (message: string) => void,
): Promise<EnvCheck[]> {
  const observe = async (label: string, fault?: EvaluationConfig['environmentFaults'][number]) => {
    log(`[env] ${label}: starting`);
    const checked = await startCheck(
      {
        ...common,
        logsDir: path.join(workDir, 'env', label),
        ...(fault?.configOverride ? { configOverride: fault.configOverride } : {}),
        ...(fault?.skipSeed ? { skipSeed: true } : {}),
      },
      () => observeApp(config),
    );
    if ('patchFailed' in checked) throw new Error(checked.patchFailed); // no patch here: cannot happen
    const start = { ...checked.observation, app: checked.probe ?? null };
    log(`[env] ${label}: ${describeStart(start)}`);
    return start;
  };
  const checks: EnvCheck[] = [{ id: 'golden', starts: [await observe('golden')], repeatable: true }];
  for (const fault of evaluation.environmentFaults) {
    const starts = [await observe(`${fault.id}-1`, fault), await observe(`${fault.id}-2`, fault)];
    const repeatable = envSignature(starts[0]!) === envSignature(starts[1]!);
    log(`[env] ${fault.id}: ${repeatable ? 'same on both starts' : 'DIFFERENT on the two starts'}`);
    checks.push({ id: fault.id, starts, repeatable });
  }
  await writeFile(path.join(workDir, 'env-checks.json'), `${JSON.stringify(checks, null, 2)}\n`);
  return checks;
}

/** One line per start for the log and the CLI. */
export function describeStart(s: StartObservation & { app: AppObservation | null }): string {
  const parts = [
    `health backend ${s.healthChecks.backend ? 'ok' : 'FAILED'}, frontend ${s.healthChecks.frontend ? 'ok' : 'FAILED'}`,
  ];
  for (const name of ['backend', 'frontend'] as const) {
    const e = s.exited[name];
    if (e) parts.push(`${name} exited (code ${e.code ?? 'none'})`);
  }
  if (s.buildErrors.length) parts.push(`build errors: ${s.buildErrors.join(', ')}`);
  if (s.app) {
    if (s.app.seedCheck) parts.push(`seed check ${s.app.seedCheck.ok ? 'ok' : `failed (${s.app.seedCheck.status ?? 'no response'})`}`);
    parts.push(s.app.logins.unreachable ? 'logins: backend unreachable' : `logins ${s.app.logins.broken.length ? `failed: ${s.app.logins.broken.join(', ')}` : 'ok'}`);
    const failed = s.app.page.requests.filter((r) => !/-> [23]\d\d$/.test(r));
    parts.push(`page ${s.app.page.document}, ${s.app.page.requests.length} API requests (${failed.length} not ok${failed[0] ? `, e.g. ${failed[0]}` : ''})`);
  }
  return parts.join('; ');
}
