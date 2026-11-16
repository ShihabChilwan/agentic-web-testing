// Scores the analyzer sample of the scenario measurement (scoring/scenarios/PROTOCOL.md, "Diagnosis on a sample").
// The per-file rules are those of scoring/differential/PROTOCOL.md, used unchanged through its exported `scoreFile`.
// Written and committed before the first analysis of the sample ran. Run:
//   npx tsx scoring/scenarios/score-sample.ts --sample scoring/scenarios/out/analysis-sample.json \
//     --suite <label>=<run dir> [--suite ...] [--file diagnoses.scenarios.json] [--out scoring/scenarios/out]
// The bug's file and lines come from targets/<target>/sealed-2/variants.json (target from the run's run.json).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { scoreFile, type Score } from '../differential/score.js';

interface SamplePair { suite: string; bug: string; execId: string | null; scenarioOnly: boolean; comparatorOnly: boolean }
interface Variant { id: string; file: string; lines: [number, number] }

const json = <T>(file: string): Promise<T | null> => readFile(file, 'utf8').then((t) => JSON.parse(t) as T, () => null);

export interface PairScore extends SamplePair { analysed: boolean; score: Score }

/** One pair: not analysed when its execution has no diagnoses file (e.g. the cost cap stopped the calls). */
export function scorePair(pair: SamplePair, file: Parameters<typeof scoreFile>[0], variant: Variant): PairScore {
  return { ...pair, analysed: file !== null, score: scoreFile(file, variant) };
}

const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${n}/${d} (${((100 * n) / d).toFixed(1)}%)`);

export function sampleMarkdown(scores: readonly PairScore[]): string {
  const analysed = scores.filter((s) => s.analysed);
  const rate = (set: readonly PairScore[], f: (s: Score) => boolean) => pct(set.filter((s) => f(s.score)).length, set.length);
  const row = (label: string, set: readonly PairScore[]) => `| ${label} | ${set.length} | ${rate(set, (s) => s.classOk)} | ${rate(set, (s) => s.fileOk)} | ${rate(set, (s) => s.linesOk)} |`;
  const cost = analysed.reduce((a, s) => a + s.score.costUsd, 0);
  const ms = analysed.reduce((a, s) => a + s.score.durationMs, 0);
  return [
    '# Scenario measurement: analyzer sample',
    '',
    'Rules: scoring/differential/PROTOCOL.md (unchanged). Primary rates are over the analysed pairs; pairs not analysed are listed (PROTOCOL.md of the scenario measurement). The second row counts them as wrong (rule 6 of the differential protocol).',
    '',
    '| Set | Pairs | Class right | File right | Lines right |',
    '|---|---|---|---|---|',
    row('Analysed', analysed),
    row('All sampled (not analysed = wrong)', scores),
    row('Scenario-only pairs (analysed)', analysed.filter((s) => s.scenarioOnly)),
    row('Comparator-only pairs (analysed)', analysed.filter((s) => s.comparatorOnly)),
    '',
    `Cost ${cost.toFixed(4)} USD; analysis time ${(ms / 60000).toFixed(1)} min; sessions ${analysed.reduce((a, s) => a + s.score.sessions, 0)}.`,
    '',
    '## Per pair',
    '',
    '| Suite | Bug | Exec | Scenario-only | Comparator-only | Analysed | Class | File | Lines | Primary (confidence, class) | Located diagnosis |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...scores.map((s) => {
      const p = s.score.primary;
      const l = s.score.located;
      const yes = (b: boolean) => (b ? 'yes' : 'no');
      return `| ${s.suite} | ${s.bug} | ${s.execId ?? '-'} | ${yes(s.scenarioOnly)} | ${yes(s.comparatorOnly)} | ${yes(s.analysed)} | ${yes(s.score.classOk)} | ${yes(s.score.fileOk)} | ${yes(s.score.linesOk)} | ${p ? `${p.confidence}, ${p.classification}` : '-'} | ${l?.location ? `${l.location.file} ${l.location.lines[0]}-${l.location.lines[1]}` : '-'} |`;
    }),
    '',
  ].join('\n');
}

async function main(argv: string[]): Promise<void> {
  const opt = (name: string) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]!] : []));
  const sampleFile = opt('--sample')[0] ?? path.join('scoring', 'scenarios', 'out', 'analysis-sample.json');
  const fileName = opt('--file')[0] ?? 'diagnoses.scenarios.json';
  const out = opt('--out')[0] ?? path.join('scoring', 'scenarios', 'out');
  const suites = new Map(opt('--suite').map((s) => [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)] as const));
  const { sample } = JSON.parse(await readFile(sampleFile, 'utf8')) as { sample: SamplePair[] };
  const scores: PairScore[] = [];
  for (const pair of sample) {
    const runDir = suites.get(pair.suite);
    if (!runDir) throw new Error(`No --suite for ${pair.suite}`);
    const target = (await json<{ target: string }>(path.join(runDir, 'run.json')))?.target;
    const variants = await json<{ variants: Variant[] }>(path.join('targets', target ?? '?', 'sealed-2', 'variants.json'));
    const variant = variants?.variants.find((v) => v.id === pair.bug);
    if (!variant) throw new Error(`${pair.suite} ${pair.bug}: not in targets/${target}/sealed-2/variants.json`);
    const file = pair.execId ? await json<Parameters<typeof scoreFile>[0] & object>(path.join(runDir, 'executions', pair.execId, fileName)) : null;
    scores.push(scorePair(pair, file, variant));
  }
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'analysis-scores.json'), `${JSON.stringify(scores, null, 2)}\n`);
  await writeFile(path.join(out, 'analysis-scores.md'), sampleMarkdown(scores));
  console.log(`wrote ${path.join(out, 'analysis-scores.json')} and analysis-scores.md (${scores.filter((s) => s.analysed).length}/${scores.length} analysed)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
