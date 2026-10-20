import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { RUNS_DIR, runPaths } from '../shared/paths.js';
import { latestRunWith } from '../shared/run-manifest.js';

export type InspectStage = 'prd' | 'cases';

export interface InspectOptions {
  stage: InspectStage;
  /** Defaults to the newest run that has a transcript for the stage. */
  runId?: string;
  runsDir?: string;
  /** Show one session in full (its n in transcripts/<stage>-<n>.jsonl). */
  session?: number;
  /** Also list the sessions of earlier runs of the stage (transcripts/previous-<timestamp>/). */
  all?: boolean;
}

interface TranscriptEvent {
  type: string;
  [key: string]: unknown;
}

const shorten = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Problem text with list positions replaced, so the same problem on many items is counted once. */
const normalise = (problem: string) => problem.replace(/\[\d+\]/g, '[*]').replace(/\.\d+(?=\.|:)/g, '.*');

function grouped(problems: string[], max: number): string[] {
  const counts = new Map<string, number>();
  for (const p of problems) counts.set(normalise(p), (counts.get(normalise(p)) ?? 0) + 1);
  return [...counts].map(([p, n]) => `${shorten(p, max)}${n > 1 ? ` ×${n}` : ''}`);
}

/** What a session was about: the feature (and gap round) for test cases, the purpose otherwise. */
function sessionLabel(stage: InspectStage, start: TranscriptEvent | undefined): string {
  const task = typeof start?.task === 'string' ? start.task : '';
  if (stage === 'cases') {
    const feature = /feature (F-\d+)/.exec(task)?.[1] ?? '?';
    return `${feature}${task.includes('got no test case') ? ' (gap round)' : ''}`;
  }
  return String(start?.purpose ?? stage);
}

function rejectionKind(e: TranscriptEvent): string {
  if (e.kind === 'invalidInput') return 'invalid input';
  if (e.kind === 'checkFailed') return 'failed checks';
  // Transcripts written before the kind was recorded: schema problems say "Invalid input".
  return (e.errors as string[]).some((p) => /Invalid (input|option)|Too (big|small)/.test(p)) ? 'invalid input' : 'failed checks';
}

/**
 * Reads a stage's transcripts and lists, per session, its turns, result and every rejected
 * submit or tool call with the problem messages. Read-only.
 */
export async function inspectStage(options: InspectOptions): Promise<string[]> {
  const runsDir = options.runsDir ?? RUNS_DIR;
  const runId = options.runId ?? (await latestRunWith(path.join('transcripts', `${options.stage}-1.jsonl`), runsDir));
  if (!runId) throw new Error(`No run with ${options.stage} transcripts in ${runsDir}`);
  const dir = runPaths(runId, runsDir).transcriptsDir;
  const pattern = new RegExp(`^${options.stage}-(\\d+)\\.jsonl$`);
  const sessionsIn = async (folder: string) =>
    (await readdir(folder).catch(() => [] as string[]))
      .map((f) => ({ f, n: Number(pattern.exec(f)?.[1]) }))
      .filter((x) => Number.isInteger(x.n))
      .sort((a, b) => a.n - b.n)
      .filter((x) => options.session === undefined || x.n === options.session);
  // Earlier runs of the stage (oldest first), then the latest one in transcripts/ itself.
  const earlier = options.all
    ? (await readdir(dir).catch(() => [] as string[])).filter((d) => d.startsWith('previous-')).sort()
    : [];
  const groups: Array<{ label: string; folder: string; files: Array<{ f: string; n: number }> }> = [];
  for (const d of earlier) {
    const files = await sessionsIn(path.join(dir, d));
    if (files.length > 0) groups.push({ label: `earlier run (${d})`, folder: path.join(dir, d), files });
  }
  const latest = await sessionsIn(dir);
  if (latest.length > 0) groups.push({ label: 'latest run', folder: dir, files: latest });
  const total = groups.reduce((n, g) => n + g.files.length, 0);
  if (total === 0) throw new Error(`No ${options.stage} transcript${options.session ? ` ${options.session}` : 's'} in ${dir}`);

  const out = [`Run ${runId}, stage ${options.stage}: ${latest.length} session(s) in the latest run${options.all ? `, ${total - latest.length} in earlier runs` : ''}`];
  for (const group of groups) {
    if (options.all) out.push('', `=== ${group.label} ===`);
    for (const { f, n } of group.files) {
      out.push(...(await describeSession(path.join(group.folder, f), f, n, options)));
    }
  }
  return out;
}

async function describeSession(file: string, f: string, n: number, options: InspectOptions): Promise<string[]> {
  const out: string[] = [];
  const events = (await readFile(file, 'utf8'))
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as TranscriptEvent);
  const end = events.findLast((e) => e.type === 'end');
  const turns = events.filter((e) => e.type === 'response').length;
  const result = end?.ok === true ? 'ok' : end ? `FAILED (${shorten(String(end.error ?? 'unknown'), 120)})` : 'unfinished';
  out.push('', `#${n} ${f}: ${sessionLabel(options.stage, events[0])}; ${turns} turns; ${result}`);

  let attempt = 0;
  let turn = 0;
  for (const e of events) {
    if (options.session !== undefined && e.type === 'response') {
      turn++;
      const calls = (e.content as Array<{ type: string; name?: string }>).filter((b) => b.type === 'tool_call').map((b) => b.name);
      out.push(`  turn ${turn}: ${calls.length ? `calls ${calls.join(', ')}` : `no tool call (${String(e.stopReason)})`}`);
      if (typeof e.reasoning === 'string' && e.reasoning) out.push(`    reasoning: ${shorten(e.reasoning, 600)}`);
    }
    if (e.type === 'submit') {
      attempt++;
      if (e.ok) {
        out.push(`  submit ${attempt}: accepted`);
        continue;
      }
      const problems = e.errors as string[];
      out.push(`  submit ${attempt}: rejected, ${rejectionKind(e)} (${problems.length} problem${problems.length === 1 ? '' : 's'})`);
      const lines = options.session === undefined ? grouped(problems, 160) : problems.map((p) => shorten(p, 400));
      for (const line of lines) out.push(`    - ${line}`);
    }
    if (e.type === 'tool_result' && e.isError) {
      const content = String(e.content);
      out.push(`  tool ${String(e.name)} rejected: ${shorten(content.split('\n')[0] ?? '', 160)}`);
      const problems = content.split('\n').slice(1).filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
      const lines = options.session === undefined ? grouped(problems, 160) : problems.map((p) => shorten(p, 400));
      for (const line of lines) out.push(`    - ${line}`);
    }
    if (e.type === 'nudge') out.push(`  nudge: ${shorten(String(e.text), 120)}`);
  }
  return out;
}
