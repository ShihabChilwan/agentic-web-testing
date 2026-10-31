import type { Classification, Diagnosis } from '../../src/shared/schemas.js';
import type { Variants } from '../../src/shared/schemas.js';
import type { LoadedSuite, LoadedVersion } from './load.js';

/** Lines of slack around the mutated lines for a diagnosed location to count (PROTOCOL.md rule 5). */
export const LINE_MARGIN = 5;

export type Kind = 'code' | 'environment';

export interface VersionScore {
  version: string;
  kind: Kind;
  /** False when the task produced no execution. */
  ran: boolean;
  /** A test passed on golden and failed or errored on this version. */
  caught: boolean;
  caughtTests: number;
  /** A diagnoses.json exists for this execution. */
  analyzed: boolean;
  /** The highest-confidence diagnosis of any classification (PROTOCOL.md rule 4a). */
  primaryClass: Classification | null;
  classCorrect: boolean;
  /** Supplementary: any group has the expected classification. */
  classAny: boolean;
  /** Supplementary: the classification covering the most failing tests. */
  majorityClass: Classification | null;
  classMajority: boolean;
  /** Code variants only: the highest-confidence app_defect group (rule 4b). */
  fileCorrect: boolean;
  lineCorrect: boolean;
  fileAny: boolean;
  lineAny: boolean;
  analysisCostUsd: number | null;
  analysisMs: number | null;
  executionMs: number;
}

export interface SuiteScore {
  repeatId: string;
  versions: VersionScore[];
  /** Rates are null when the denominator is 0. */
  rates: Record<string, number | null>;
  counts: Record<string, number>;
  /** expected classification → primary classification (or "none") → versions. */
  confusion: Record<string, Record<string, number>>;
  golden: { failures: number; diagnosedAppDefect: number; falseAlarmRate: number | null };
  totals: { analysisCostUsd: number; analysisMs: number; executionMsMean: number | null };
  warnings: string[];
}

const ratio = (n: number, d: number) => (d === 0 ? null : n / d);

/** Highest confidence; ties go to the group covering more tests, then to the earlier group. */
export function primaryDiagnosis(diagnoses: readonly Diagnosis[]): Diagnosis | null {
  let best: Diagnosis | null = null;
  for (const d of diagnoses) {
    if (!best || d.confidence > best.confidence || (d.confidence === best.confidence && d.testCaseIds.length > best.testCaseIds.length)) best = d;
  }
  return best;
}

const norm = (file: string) => file.replace(/\\/g, '/').replace(/^\.\//, '');

/** The diagnosed range overlaps the variant's lines widened by the margin on both sides. */
export function lineWithin(diagnosed: readonly [number, number], truth: readonly [number, number], margin = LINE_MARGIN): boolean {
  return diagnosed[0] <= truth[1] + margin && diagnosed[1] >= truth[0] - margin;
}

function passedIds(v: LoadedVersion): Set<string> {
  return new Set((v.results?.results ?? []).filter((r) => r.status === 'passed').map((r) => r.testCaseId));
}

function majorityClass(diagnoses: readonly Diagnosis[]): Classification | null {
  const tests = new Map<Classification, Set<string>>();
  for (const d of diagnoses) {
    const set = tests.get(d.classification) ?? new Set<string>();
    for (const t of d.testCaseIds) set.add(t);
    tests.set(d.classification, set);
  }
  let best: Classification | null = null;
  for (const [c, set] of tests) if (best === null || set.size > tests.get(best)!.size) best = c;
  return best;
}

export function scoreVersion(variant: Variants['variants'][number], suite: LoadedSuite): VersionScore {
  const loaded = suite.versions.get(variant.id);
  if (!loaded) throw new Error(`${suite.runDir}: no execution for ${variant.id} in mapping.json`);
  const golden = passedIds(suite.versions.get('golden')!);
  const failing = (loaded.results?.results ?? []).filter((r) => r.status !== 'passed' && golden.has(r.testCaseId));
  const caught = failing.length > 0;
  const diagnoses = loaded.diagnoses?.diagnoses ?? [];
  // Only groups about tests that count as caught tests decide; golden-failing tests are excluded.
  const failingIds = new Set(failing.map((r) => r.testCaseId));
  const about = diagnoses.filter((d) => d.testCaseIds.some((t) => failingIds.has(t)));
  const primary = primaryDiagnosis(about);
  const appGroups = about.filter((d) => d.classification === 'app_defect' && d.location);
  const primaryApp = primaryDiagnosis(appGroups);
  const expected = variant.expectedClassification;
  const code = variant.kind === 'code' ? variant : null;
  const fileOf = (d: Diagnosis | null) => d?.location != null && code !== null && norm(d.location.file) === norm(code.file);
  const lineOf = (d: Diagnosis | null) => fileOf(d) && lineWithin(d!.location!.lines, code!.lines);
  const majority = majorityClass(about);
  return {
    version: variant.id,
    kind: variant.kind,
    ran: loaded.results !== null,
    caught,
    caughtTests: failing.length,
    analyzed: loaded.diagnoses !== null,
    primaryClass: primary?.classification ?? null,
    classCorrect: caught && primary?.classification === expected,
    classAny: caught && about.some((d) => d.classification === expected),
    majorityClass: majority,
    classMajority: caught && majority === expected,
    fileCorrect: caught && fileOf(primaryApp),
    lineCorrect: caught && lineOf(primaryApp),
    fileAny: caught && appGroups.some((d) => fileOf(d)),
    lineAny: caught && appGroups.some((d) => lineOf(d)),
    analysisCostUsd: loaded.diagnoses?.summary?.costUsd ?? null,
    analysisMs: loaded.diagnoses?.summary?.durationMs ?? null,
    executionMs: loaded.executionMs,
  };
}

export function scoreSuite(suite: LoadedSuite, variants: Variants, equivalents: readonly string[] = []): SuiteScore {
  const warnings: string[] = [];
  const versions = variants.variants.map((v) => scoreVersion(v, suite));
  const extra = [...suite.versions.keys()].filter((k) => k !== 'golden' && !variants.variants.some((v) => v.id === k));
  if (extra.length > 0) warnings.push(`${suite.runDir}: executions without a variant in the list: ${extra.join(', ')}`);
  for (const v of versions) {
    if (!v.ran) warnings.push(`${suite.runDir}: ${v.version} has no execution (its task failed); counted as not caught`);
    if (v.caught && !v.analyzed) warnings.push(`${suite.runDir}: ${v.version} was caught but not analysed; counted as not diagnosed correctly`);
  }

  const code = versions.filter((v) => v.kind === 'code');
  const env = versions.filter((v) => v.kind === 'environment');
  const caughtCode = code.filter((v) => v.caught);
  const caughtEnv = env.filter((v) => v.caught);
  const real = code.filter((v) => !equivalents.includes(v.version));
  const count = (list: VersionScore[], f: (v: VersionScore) => boolean) => list.filter(f).length;
  const counts = {
    codeVariants: code.length,
    codeCaught: caughtCode.length,
    equivalents: code.length - real.length,
    envVariants: env.length,
    envCaught: caughtEnv.length,
  };
  const rates: Record<string, number | null> = {
    mutationScoreRaw: ratio(caughtCode.length, code.length),
    mutationScoreAdjusted: ratio(count(real, (v) => v.caught), real.length),
    codeClassification: ratio(count(caughtCode, (v) => v.classCorrect), caughtCode.length),
    codeFile: ratio(count(caughtCode, (v) => v.fileCorrect), caughtCode.length),
    codeLine: ratio(count(caughtCode, (v) => v.lineCorrect), caughtCode.length),
    codeClassificationAnyGroup: ratio(count(caughtCode, (v) => v.classAny), caughtCode.length),
    codeFileAnyGroup: ratio(count(caughtCode, (v) => v.fileAny), caughtCode.length),
    codeLineAnyGroup: ratio(count(caughtCode, (v) => v.lineAny), caughtCode.length),
    envDetection: ratio(caughtEnv.length, env.length),
    envClassification: ratio(count(caughtEnv, (v) => v.classCorrect), caughtEnv.length),
    envClassificationAnyGroup: ratio(count(caughtEnv, (v) => v.classAny), caughtEnv.length),
    envClassificationMajority: ratio(count(caughtEnv, (v) => v.classMajority), caughtEnv.length),
  };

  const confusion: SuiteScore['confusion'] = {};
  for (const variant of variants.variants) {
    const s = versions.find((v) => v.version === variant.id)!;
    if (!s.caught) continue;
    const row = (confusion[variant.expectedClassification] ??= {});
    const key = s.primaryClass ?? 'none';
    row[key] = (row[key] ?? 0) + 1;
  }

  const golden = suite.versions.get('golden')!;
  const goldenFailing = (golden.results?.results ?? []).filter((r) => r.status !== 'passed').map((r) => r.testCaseId);
  const appDefectTests = new Set((golden.diagnoses?.diagnoses ?? []).filter((d) => d.classification === 'app_defect').flatMap((d) => d.testCaseIds));
  const diagnosedAppDefect = goldenFailing.filter((t) => appDefectTests.has(t)).length;
  if (goldenFailing.length > 0) warnings.push(`${suite.runDir}: ${goldenFailing.length} test(s) fail on golden (${goldenFailing.slice(0, 5).join(', ')}); they are excluded from catching; review them by hand`);

  const ran = versions.filter((v) => v.ran);
  return {
    repeatId: suite.repeatId,
    versions,
    rates,
    counts,
    confusion,
    golden: { failures: goldenFailing.length, diagnosedAppDefect, falseAlarmRate: ratio(diagnosedAppDefect, goldenFailing.length) },
    totals: {
      analysisCostUsd: versions.reduce((n, v) => n + (v.analysisCostUsd ?? 0), 0),
      analysisMs: versions.reduce((n, v) => n + (v.analysisMs ?? 0), 0),
      executionMsMean: ran.length === 0 ? null : ran.reduce((n, v) => n + v.executionMs, 0) / ran.length,
    },
    warnings,
  };
}
