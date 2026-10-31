import type { Aggregate, Spread } from './aggregate.js';

const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const usd = (x: number | null) => (x === null ? 'n/a' : `$${x.toFixed(3)}`);
const secs = (x: number | null) => (x === null ? 'n/a' : `${(x / 1000).toFixed(0)} s`);
const mark = (b: boolean) => (b ? 'yes' : '-');

function row(label: string, s: Spread, fmt: (x: number | null) => string): string {
  return `| ${label} | ${s.values.map(fmt).join(' / ')} | ${fmt(s.mean)} | ${fmt(s.min)} – ${fmt(s.max)} | ${s.sd === null ? 'n/a' : fmt(s.sd)} |`;
}

const LABELS: Array<[string, string]> = [
  ['mutationScoreRaw', 'Mutation score (raw, code variants)'],
  ['mutationScoreAdjusted', 'Mutation score (equivalent mutants excluded)'],
  ['codeClassification', 'Classification correct (code, caught)'],
  ['codeFile', 'File correct (code, caught)'],
  ['codeLine', 'Line within ±5 (code, caught)'],
  ['envDetection', 'Environment faults detected'],
  ['envClassification', 'Environment faults: classification correct (caught)'],
  ['codeClassificationAnyGroup', 'Supplementary: classification, any group'],
  ['codeFileAnyGroup', 'Supplementary: file, any group'],
  ['codeLineAnyGroup', 'Supplementary: line, any group'],
  ['envClassificationAnyGroup', 'Supplementary: environment classification, any group'],
  ['envClassificationMajority', 'Supplementary: environment classification, majority of failing tests'],
];

export function renderMarkdown(a: Aggregate, protocolSha256: string): string {
  const out: string[] = [];
  out.push(`# Scores over ${a.suites} suite(s)`, '', `Protocol SHA-256: \`${protocolSha256}\``, '');
  out.push('Values per suite are separated by " / ". SD is the sample standard deviation (n − 1); with three suites read the range first.', '');
  out.push('| Metric | Per suite | Mean | Range | SD |', '|---|---|---|---|---|');
  for (const [key, label] of LABELS) if (a.rates[key]) out.push(row(label, a.rates[key], pct));
  out.push(row('Golden false-alarm rate (golden failures diagnosed app_defect)', a.goldenFalseAlarm, pct));
  out.push('', '| Cost and time | Per suite | Mean | Range | SD |', '|---|---|---|---|---|');
  out.push(row('Analysis cost', a.cost.analysisCostUsd, usd), row('Analysis time (sum of groups)', a.cost.analysisMs, secs), row('Execution time per version (cloud task, mean)', a.cost.executionMsMean, secs));
  out.push('', '## Per version', '', '| Version | Kind | Equivalent | Caught (suites) | Caught per suite | Class ok | File ok | Line ok |', '|---|---|---|---|---|---|---|---|');
  for (const v of a.variants) {
    out.push(`| ${v.version} | ${v.kind} | ${v.equivalent ? 'yes' : '-'} | ${v.caughtInSuites} of ${a.suites} | ${v.caught.map(mark).join(' / ')} | ${v.classCorrect.map(mark).join(' / ')} | ${v.fileCorrect.map(mark).join(' / ')} | ${v.lineCorrect.map(mark).join(' / ')} |`);
  }
  out.push('', `Code variants caught by no suite (review by hand for equivalence, then list in equivalents.json): ${a.caughtByNoSuite.join(', ') || 'none'}`);
  out.push('', '## Confusion (expected → highest-confidence diagnosis, summed over suites, caught versions only)', '');
  const cols = [...new Set(Object.values(a.confusion).flatMap((r) => Object.keys(r)))].sort();
  out.push(`| Expected | ${cols.join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`);
  for (const [expected, r] of Object.entries(a.confusion)) out.push(`| ${expected} | ${cols.map((c) => r[c] ?? 0).join(' | ')} |`);
  if (a.warnings.length > 0) out.push('', '## Warnings', '', ...a.warnings.map((w) => `- ${w}`));
  return `${out.join('\n')}\n`;
}
