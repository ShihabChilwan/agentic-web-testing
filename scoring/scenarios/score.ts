// Scenario measurement scoring (scoring/scenarios/PROTOCOL.md). Pure code over files written by the pipeline:
// eval/mapping.json, executions/<x>/results.json and differential/compare-<base>-<x>.json of one imported run per suite.
// No model call. Run:
//   npx tsx scoring/scenarios/score.ts detect --suite <label>=<run dir> [--suite ...] [--out scoring/scenarios/out]
//   npx tsx scoring/scenarios/score.ts sample --detection scoring/scenarios/out/detection.json [--seed 20261116] [--n 10]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type Origin = 'TC' | 'SC';
export const ORIGINS: readonly Origin[] = ['TC', 'SC'];
export const SAMPLE_SEED = 20261116;
export const SAMPLE_SIZE = 10;
/** The correct-version runs of one repeat: base, two more for the noise, one as the fresh check. */
export const BASE = 'golden';
export const NOISE_RUNS = ['golden', 'golden-2', 'golden-3'] as const;
export const FRESH_CHECK = 'golden-4';

export interface TestResult {
  testCaseId: string;
  status: 'passed' | 'failed' | 'errored';
}
export interface Comparison {
  findings?: Array<{ kind: string; count: number }>;
  tests: Array<{ testCaseId: string; endpoints: Array<{ differences: Array<{ strength?: 'strong' | 'weak' }> }> }>;
}

export const originOf = (testCaseId: string): Origin | null => (testCaseId.startsWith('TC-') ? 'TC' : testCaseId.startsWith('SC-') ? 'SC' : null);

/** Per origin, tests with at least one strong difference; a folded setup-changed finding counts for both origins. */
export function strongTests(c: Comparison): Record<Origin, string[]> {
  const out: Record<Origin, string[]> = { TC: [], SC: [] };
  for (const t of c.tests) {
    const origin = originOf(t.testCaseId);
    if (!origin) continue;
    if (t.endpoints.some((e) => e.differences.some((d) => (d.strength ?? 'strong') === 'strong'))) out[origin].push(t.testCaseId);
  }
  return out;
}

export const setupChanged = (c: Comparison): boolean => (c.findings ?? []).some((f) => f.kind === 'setup-changed' && f.count > 0);

export interface BugDetection {
  suite: string;
  bug: string;
  execId: string | null;
  /** Tests of each origin that failed or errored here and passed in every correct-version run. */
  failing: Record<Origin, string[]>;
  /** Tests of each origin with a strong difference against the base run. */
  differing: Record<Origin, string[]>;
  setupChanged: boolean;
  caughtBy: { tcTests: boolean; tcComparator: boolean; scTests: boolean; scComparator: boolean };
  /** Caught by the suite alone (TC tests or TC comparator, or a setup-changed finding). */
  bySuite: boolean;
  /** Caught by the suite with scenarios (any of the four, or a setup-changed finding). */
  withScenarios: boolean;
  /** Caught only through scenario tests (SC tests or SC comparator) and not by the suite. */
  scenarioOnly: boolean;
  /** Caught with no failing test of either origin, only by strong differences. */
  comparatorOnly: boolean;
  /** No execution, or no comparison: reported, never counted as caught or missed. */
  missingData?: string;
}

/** One bug's detection from its results and comparison and the correct-version runs' results. */
export function detectBug(input: { suite: string; bug: string; execId: string | null; results: TestResult[] | null; comparison: Comparison | null; goldenResults: TestResult[][] }): BugDetection {
  const stable = new Set<string>();
  const ids = new Set(input.goldenResults.flatMap((r) => r.map((t) => t.testCaseId)));
  for (const id of ids) if (input.goldenResults.every((r) => r.find((t) => t.testCaseId === id)?.status === 'passed')) stable.add(id);
  const failing: Record<Origin, string[]> = { TC: [], SC: [] };
  for (const t of input.results ?? []) {
    const origin = originOf(t.testCaseId);
    if (origin && t.status !== 'passed' && stable.has(t.testCaseId)) failing[origin].push(t.testCaseId);
  }
  const differing = input.comparison ? strongTests(input.comparison) : { TC: [], SC: [] };
  const setup = input.comparison ? setupChanged(input.comparison) : false;
  const caughtBy = { tcTests: failing.TC.length > 0, tcComparator: differing.TC.length > 0 || setup, scTests: failing.SC.length > 0, scComparator: differing.SC.length > 0 || setup };
  const bySuite = caughtBy.tcTests || caughtBy.tcComparator;
  const withScenarios = bySuite || caughtBy.scTests || caughtBy.scComparator;
  const missingData = !input.results ? 'no execution results' : !input.comparison ? 'no comparison' : undefined;
  return {
    suite: input.suite,
    bug: input.bug,
    execId: input.execId,
    failing,
    differing,
    setupChanged: setup,
    caughtBy,
    bySuite,
    withScenarios,
    scenarioOnly: withScenarios && !bySuite,
    comparatorOnly: withScenarios && failing.TC.length === 0 && failing.SC.length === 0,
    ...(missingData ? { missingData } : {}),
  };
}

export interface FalseAlarms {
  suite: string;
  /** Tests per origin with a strong difference in the fresh check (golden-4 against the base). */
  differing: Record<Origin, number>;
  setupChanged: boolean;
  /** Tests per origin that failed in the fresh check and passed in the other correct runs. */
  failing: Record<Origin, number>;
}

/** A small seeded PRNG (mulberry32), so the sample is the same on every machine. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates with the seeded PRNG. */
export function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const rand = prng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * The analyzer sample (PROTOCOL.md, "Diagnosis"): the caught (suite, bug) pairs sorted by suite and bug, shuffled with
 * the seed; the first scenario-only pair and the first comparator-only pair in that order are taken when there are
 * any; the rest is filled in that order up to `n`.
 */
export function sampleForAnalysis(detections: readonly BugDetection[], seed = SAMPLE_SEED, n = SAMPLE_SIZE): BugDetection[] {
  const caught = detections.filter((d) => d.withScenarios && !d.missingData).sort((a, b) => a.suite.localeCompare(b.suite) || a.bug.localeCompare(b.bug));
  const order = shuffle(caught, seed);
  const picked: BugDetection[] = [];
  for (const special of [(d: BugDetection) => d.scenarioOnly, (d: BugDetection) => d.comparatorOnly]) {
    const first = order.find((d) => special(d) && !picked.includes(d));
    if (first && picked.length < n) picked.push(first);
  }
  for (const d of order) {
    if (picked.length >= n) break;
    if (!picked.includes(d)) picked.push(d);
  }
  return picked;
}

// ---------------------------------------------------------------------------------------------------------------
// Files

interface Mapping {
  versions: Array<{ version: string; execId: string | null }>;
}

async function json<T>(file: string): Promise<T | null> {
  return readFile(file, 'utf8').then((t) => JSON.parse(t) as T, () => null);
}

async function resultsOf(runDir: string, execId: string | null): Promise<TestResult[] | null> {
  if (!execId) return null;
  return (await json<{ results: TestResult[] }>(path.join(runDir, 'executions', execId, 'results.json')))?.results ?? null;
}

/** One suite: every bug version's detection and the fresh check's false alarms. */
export async function scoreSuite(label: string, runDir: string): Promise<{ detections: BugDetection[]; falseAlarms: FalseAlarms | null; problems: string[] }> {
  const mapping = await json<Mapping>(path.join(runDir, 'eval', 'mapping.json'));
  if (!mapping) throw new Error(`${runDir}/eval/mapping.json is missing`);
  const exec = (v: string) => mapping.versions.find((x) => x.version === v)?.execId ?? null;
  const problems: string[] = [];
  const base = exec(BASE);
  if (!base) throw new Error(`${label}: no execution of ${BASE}`);
  const goldenRuns = [...NOISE_RUNS, FRESH_CHECK];
  const goldenResults: TestResult[][] = [];
  for (const v of goldenRuns) {
    const r = await resultsOf(runDir, exec(v));
    if (r) goldenResults.push(r);
    else problems.push(`${label}: no results for ${v}`);
  }
  const compare = (other: string) => json<Comparison>(path.join(runDir, 'differential', `compare-${base}-${other}.json`));
  const detections: BugDetection[] = [];
  for (const v of mapping.versions.filter((x) => /^bug-\d+$/.test(x.version)).sort((a, b) => a.version.localeCompare(b.version))) {
    detections.push(detectBug({ suite: label, bug: v.version, execId: v.execId, results: await resultsOf(runDir, v.execId), comparison: v.execId ? await compare(v.execId) : null, goldenResults }));
  }
  let falseAlarms: FalseAlarms | null = null;
  const fresh = exec(FRESH_CHECK);
  const freshComparison = fresh ? await compare(fresh) : null;
  if (fresh && freshComparison) {
    const others = await Promise.all(NOISE_RUNS.map((v) => resultsOf(runDir, exec(v))));
    const freshResults = (await resultsOf(runDir, fresh)) ?? [];
    const failing: Record<Origin, number> = { TC: 0, SC: 0 };
    for (const t of freshResults) {
      const origin = originOf(t.testCaseId);
      if (origin && t.status !== 'passed' && others.every((r) => r?.find((x) => x.testCaseId === t.testCaseId)?.status === 'passed')) failing[origin]++;
    }
    const strong = strongTests(freshComparison);
    falseAlarms = { suite: label, differing: { TC: strong.TC.length, SC: strong.SC.length }, setupChanged: setupChanged(freshComparison), failing };
  } else problems.push(`${label}: no fresh check (${FRESH_CHECK} execution and its comparison)`);
  return { detections, falseAlarms, problems };
}

const count = (ds: readonly BugDetection[], f: (d: BugDetection) => boolean) => ds.filter((d) => !d.missingData && f(d)).length;

export function detectionMarkdown(detections: readonly BugDetection[], falseAlarms: readonly FalseAlarms[], problems: readonly string[]): string {
  const suites = [...new Set(detections.map((d) => d.suite))];
  const row = (label: string, ds: readonly BugDetection[]) =>
    `| ${label} | ${count(ds, () => true)} | ${count(ds, (d) => d.caughtBy.tcTests)} | ${count(ds, (d) => d.bySuite)} | ${count(ds, (d) => d.caughtBy.scTests)} | ${count(ds, (d) => d.caughtBy.scComparator)} | ${count(ds, (d) => d.withScenarios)} | ${count(ds, (d) => d.scenarioOnly)} |`;
  return [
    '# Scenario measurement: detection',
    '',
    '| Suite | Bugs | TC tests | Suite (TC tests or comparator) | SC tests | SC comparator | With scenarios | Added by scenarios |',
    '|---|---|---|---|---|---|---|---|',
    ...suites.map((s) => row(s, detections.filter((d) => d.suite === s))),
    row('All', detections),
    '',
    '## False alarms (fresh check against the base run)',
    '',
    '| Suite | TC tests differing | SC tests differing | setup changed | TC failing | SC failing |',
    '|---|---|---|---|---|---|',
    ...falseAlarms.map((f) => `| ${f.suite} | ${f.differing.TC} | ${f.differing.SC} | ${f.setupChanged ? 'yes' : 'no'} | ${f.failing.TC} | ${f.failing.SC} |`),
    '',
    '## Per bug',
    '',
    '| Suite | Bug | TC failing | TC differing | SC failing | SC differing | Caught by |',
    '|---|---|---|---|---|---|---|',
    ...detections.map((d) => `| ${d.suite} | ${d.bug} | ${d.failing.TC.length} | ${d.differing.TC.length} | ${d.failing.SC.length} | ${d.differing.SC.length} | ${d.missingData ? `(${d.missingData})` : d.scenarioOnly ? 'scenarios only' : d.bySuite ? 'suite' : 'none'}${d.setupChanged ? ', setup changed' : ''} |`),
    ...(problems.length ? ['', '## Problems', '', ...problems.map((p) => `- ${p}`)] : []),
    '',
  ].join('\n');
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const opt = (name: string) => rest.flatMap((a, i) => (a === name && rest[i + 1] ? [rest[i + 1]!] : []));
  const out = opt('--out')[0] ?? path.join('scoring', 'scenarios', 'out');
  if (command === 'detect') {
    const suites = opt('--suite').map((s) => {
      const i = s.indexOf('=');
      if (i < 1) throw new Error(`--suite takes <label>=<run dir>: ${s}`);
      return { label: s.slice(0, i), dir: s.slice(i + 1) };
    });
    if (suites.length === 0) throw new Error('Give at least one --suite <label>=<run dir>');
    const all = await Promise.all(suites.map((s) => scoreSuite(s.label, s.dir)));
    const detections = all.flatMap((a) => a.detections);
    const falseAlarms = all.flatMap((a) => (a.falseAlarms ? [a.falseAlarms] : []));
    const problems = all.flatMap((a) => a.problems);
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, 'detection.json'), `${JSON.stringify({ detections, falseAlarms, problems }, null, 2)}\n`);
    await writeFile(path.join(out, 'detection.md'), detectionMarkdown(detections, falseAlarms, problems));
    console.log(`wrote ${path.join(out, 'detection.json')} and detection.md`);
    return;
  }
  if (command === 'sample') {
    const file = opt('--detection')[0] ?? path.join(out, 'detection.json');
    const seed = Number(opt('--seed')[0] ?? SAMPLE_SEED);
    const n = Number(opt('--n')[0] ?? SAMPLE_SIZE);
    const { detections } = JSON.parse(await readFile(file, 'utf8')) as { detections: BugDetection[] };
    const sample = sampleForAnalysis(detections, seed, n).map((d) => ({ suite: d.suite, bug: d.bug, execId: d.execId, scenarioOnly: d.scenarioOnly, comparatorOnly: d.comparatorOnly }));
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, 'analysis-sample.json'), `${JSON.stringify({ seed, n, sample }, null, 2)}\n`);
    console.log(`wrote ${path.join(out, 'analysis-sample.json')} (${sample.length} pairs)`);
    return;
  }
  throw new Error('Usage: score.ts detect --suite <label>=<run dir> ... | sample --detection <file>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
