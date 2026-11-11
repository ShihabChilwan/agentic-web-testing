// Scores the analyzer on comparator differences (rules: PROTOCOL.md in this folder).
// Usage: npx tsx scoring/differential-kutt/score.ts [hash] [--out <dir>]
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

interface Case { suite: string; bug: string; run: string; execId: string; comparison: string; testCaught: boolean }
interface Variant { id: string; file: string; lines: [number, number] }
interface Diagnosis { id: string; testCaseIds: string[]; classification: string; confidence: number; summary: string; location?: { file: string; lines: [number, number] } | null; basis?: string }
interface DiagnosesFile { diagnoses: Diagnosis[]; summary?: { costUsd: number | null; durationMs: number; sessions: number; differenceGroups?: number } }

export interface Score { classOk: boolean; fileOk: boolean; linesOk: boolean; missing: boolean; primary?: Diagnosis; located?: Diagnosis; costUsd: number; durationMs: number; sessions: number }

const normalise = (f: string) => f.replace(/\\/g, '/').replace(/^\.\//, '');
const byRank = (a: Diagnosis, b: Diagnosis) => b.confidence - a.confidence || b.testCaseIds.length - a.testCaseIds.length || a.id.localeCompare(b.id);

/** Rules 1 to 6 of PROTOCOL.md for one analysis file (null when it is missing). */
export function scoreFile(file: DiagnosesFile | null, variant: Variant): Score {
  if (!file) return { classOk: false, fileOk: false, linesOk: false, missing: true, costUsd: 0, durationMs: 0, sessions: 0 };
  const ranked = [...file.diagnoses].sort(byRank);
  const primary = ranked[0];
  const located = ranked.find((d) => d.classification === 'app_defect' && d.location);
  const fileOk = located !== undefined && normalise(located.location!.file) === normalise(variant.file);
  const [s, e] = located?.location?.lines ?? [0, 0];
  const linesOk = fileOk && s <= variant.lines[1] + 5 && e >= variant.lines[0] - 5;
  return {
    classOk: primary?.classification === 'app_defect',
    fileOk,
    linesOk,
    missing: false,
    ...(primary ? { primary } : {}),
    ...(located ? { located } : {}),
    costUsd: file.summary?.costUsd ?? 0,
    durationMs: file.summary?.durationMs ?? 0,
    sessions: file.summary?.sessions ?? 0,
  };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => (xs.length < 2 ? 0 : Math.sqrt(xs.reduce((a, x) => a + (x - mean(xs)) ** 2, 0) / (xs.length - 1)));
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

async function sha(file: string) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'hash') {
    for (const f of ['PROTOCOL.md', 'cases.json', 'score.ts']) console.log(`${f} ${await sha(path.join(HERE, f))}`);
    return;
  }
  const out = args.includes('--out') ? path.resolve(args[args.indexOf('--out') + 1]!) : path.join(HERE, 'out');
  const spec = JSON.parse(await readFile(path.join(HERE, 'cases.json'), 'utf8')) as { variants: string; repeats: number; cases: Case[] };
  const variants = new Map((JSON.parse(await readFile(path.join(ROOT, spec.variants), 'utf8')) as { variants: Variant[] }).variants.map((v) => [v.id, v]));
  const read = async (c: Case, name: string) =>
    readFile(path.join(ROOT, c.run, 'executions', c.execId, name), 'utf8').then((t) => JSON.parse(t) as DiagnosesFile, () => null);

  const repeats = Array.from({ length: spec.repeats }, (_, i) => i + 1);
  const rows: Array<{ c: Case; mode: 'with' | 'without'; repeat: number; s: Score }> = [];
  for (const c of spec.cases) {
    const v = variants.get(c.bug)!;
    for (const r of repeats) {
      rows.push({ c, mode: 'with', repeat: r, s: scoreFile(await read(c, `diagnoses.differential.r${r}.json`), v) });
      if (c.testCaught) rows.push({ c, mode: 'without', repeat: r, s: scoreFile(await read(c, `diagnoses.r${r}.json`), v) });
    }
  }

  const nTests = spec.cases.filter((c) => c.testCaught).length;
  const nOnly = spec.cases.length - nTests;
  const sets: Array<[string, (x: (typeof rows)[number]) => boolean]> = [
    [`Comparator-only cases (${nOnly}), with differences`, (x) => !x.c.testCaught && x.mode === 'with'],
    [`Test-caught cases (${nTests}), with differences`, (x) => x.c.testCaught && x.mode === 'with'],
    [`Test-caught cases (${nTests}), without differences`, (x) => x.c.testCaught && x.mode === 'without'],
    [`All ${spec.cases.length} cases, with differences`, (x) => x.mode === 'with'],
  ];
  const lines = ['# Diagnosing comparator differences', '', `Protocol: \`scoring/differential-kutt/PROTOCOL.md\` (sha256 ${await sha(path.join(HERE, 'PROTOCOL.md'))}); score.ts sha256 ${await sha(path.join(HERE, 'score.ts'))}.`, ''];
  lines.push('## Totals (per repeat; mean, range, sample SD)', '', '| Set | Measure | ' + repeats.map((r) => `R${r}`).join(' | ') + ' | Mean | Range | SD |', '|---|---|' + repeats.map(() => '---|').join('') + '---|---|---|');
  const totals: Record<string, unknown> = {};
  for (const [name, pick] of sets) {
    for (const [measure, key] of [['Class right', 'classOk'], ['File right', 'fileOk'], ['Lines right (±5)', 'linesOk']] as const) {
      const per = repeats.map((r) => {
        const xs = rows.filter((x) => pick(x) && x.repeat === r);
        return xs.filter((x) => x.s[key]).length / xs.length;
      });
      totals[`${name} | ${measure}`] = per;
      lines.push(`| ${name} | ${measure} | ${per.map(pct).join(' | ')} | ${pct(mean(per))} | ${pct(Math.min(...per))}–${pct(Math.max(...per))} | ${pct(sd(per))} |`);
    }
  }
  const missing = rows.filter((x) => x.s.missing);
  lines.push('', `Missing analysis files (scored wrong): ${missing.length === 0 ? 'none' : missing.map((x) => `${x.c.suite} ${x.c.bug} ${x.mode} R${x.repeat}`).join(', ')}`);

  lines.push('', '## Cost and time', '', '| Repeat | With differences: cost | time | sessions | Without: cost | time | sessions |', '|---|---|---|---|---|---|---|');
  for (const r of repeats) {
    const w = rows.filter((x) => x.repeat === r && x.mode === 'with');
    const o = rows.filter((x) => x.repeat === r && x.mode === 'without');
    const sum = (xs: typeof rows, k: 'costUsd' | 'durationMs' | 'sessions') => xs.reduce((a, x) => a + x.s[k], 0);
    lines.push(`| R${r} | $${sum(w, 'costUsd').toFixed(3)} | ${Math.round(sum(w, 'durationMs') / 1000)} s | ${sum(w, 'sessions')} | $${sum(o, 'costUsd').toFixed(3)} | ${Math.round(sum(o, 'durationMs') / 1000)} s | ${sum(o, 'sessions')} |`);
  }
  const total = rows.reduce((a, x) => a + x.s.costUsd, 0);
  lines.push('', `Total cost: $${total.toFixed(3)}; total analysis time: ${Math.round(rows.reduce((a, x) => a + x.s.durationMs, 0) / 1000)} s.`);

  lines.push('', '## Per case (with differences; repeats right of 3, then R1..R3 primary diagnosis)', '', '| Suite | Bug | Exec | Test-caught | Class | File | Lines | R1 | R2 | R3 |', '|---|---|---|---|---|---|---|---|---|---|');
  const cell = (s: Score) =>
    s.missing ? 'missing' : `${s.primary?.classification ?? '-'} ${s.primary?.confidence ?? ''} (${s.primary?.basis ?? '-'})${s.located ? ` @ ${s.located.location!.file}:${s.located.location!.lines.join('-')}` : ''}: ${(s.primary?.summary ?? '').replace(/\|/g, '\\|').slice(0, 140)}`;
  for (const c of spec.cases) {
    const xs = rows.filter((x) => x.c === c && x.mode === 'with');
    const n = (k: 'classOk' | 'fileOk' | 'linesOk') => xs.filter((x) => x.s[k]).length;
    lines.push(`| ${c.suite} | ${c.bug} | ${c.execId} | ${c.testCaught ? 'yes' : 'no'} | ${n('classOk')}/3 | ${n('fileOk')}/3 | ${n('linesOk')}/3 | ${xs.map((x) => cell(x.s)).join(' | ')} |`);
  }
  lines.push('', '## Test-caught cases without differences (baseline)', '', '| Suite | Bug | Class | File | Lines | R1 | R2 | R3 |', '|---|---|---|---|---|---|---|---|');
  for (const c of spec.cases.filter((x) => x.testCaught)) {
    const xs = rows.filter((x) => x.c === c && x.mode === 'without');
    const n = (k: 'classOk' | 'fileOk' | 'linesOk') => xs.filter((x) => x.s[k]).length;
    lines.push(`| ${c.suite} | ${c.bug} | ${n('classOk')}/3 | ${n('fileOk')}/3 | ${n('linesOk')}/3 | ${xs.map((x) => cell(x.s)).join(' | ')} |`);
  }
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'scores.md'), `${lines.join('\n')}\n`);
  await writeFile(path.join(out, 'scores.json'), `${JSON.stringify({ totals, rows: rows.map((x) => ({ suite: x.c.suite, bug: x.c.bug, execId: x.c.execId, mode: x.mode, repeat: x.repeat, ...x.s })) }, null, 2)}\n`);
  console.log(lines.join('\n'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
