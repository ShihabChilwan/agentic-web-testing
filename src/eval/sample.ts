import path from 'node:path';
import type { EvaluationConfig, LineRange, VariantDiscard } from '../shared/schemas.js';
import { MUTATORS, type MutationReport } from './stryker.js';

export type Layer = 'backend' | 'frontend';

export interface Position {
  line: number;
  column: number;
}

export interface Candidate {
  mutantId: string;
  file: string;
  layer: Layer;
  mutator: string;
  /** 1-based; `end` is exclusive (Stryker's convention). */
  start: Position;
  end: Position;
  replacement: string;
  lines: LineRange;
}

/** Lines changed by one dev-bug patch, in golden's numbering. */
export interface DevBugLines {
  patch: string;
  file: string;
  lines: number[];
}

const LOGGING = /\bconsole\.\w+\s*\(/;

function layerOf(file: string, mutate: EvaluationConfig['mutate']): Layer | null {
  if (mutate.backend.some((g) => path.posix.matchesGlob(file, g))) return 'backend';
  if (mutate.frontend.some((g) => path.posix.matchesGlob(file, g))) return 'frontend';
  return null;
}

/**
 * The mutants that may become code variants (SPEC §11.2 step 2): kept mutators, not on a logging line,
 * in a file matched by a layer's globs. Sorted by file, line, column and id, so the order before the
 * shuffle never depends on the report's key order.
 */
export function candidatesFrom(report: MutationReport, mutate: EvaluationConfig['mutate']): Candidate[] {
  const kept = new Set<string>(MUTATORS);
  const out: Candidate[] = [];
  for (const [file, { source, mutants }] of Object.entries(report.files)) {
    const layer = layerOf(file, mutate);
    if (!layer) continue;
    const lines = source.split('\n');
    for (const m of mutants) {
      if (!kept.has(m.mutatorName) || m.replacement === undefined) continue;
      if (LOGGING.test(lines[m.location.start.line - 1] ?? '')) continue;
      out.push({
        mutantId: m.id,
        file,
        layer,
        mutator: m.mutatorName,
        start: m.location.start,
        end: m.location.end,
        replacement: m.replacement,
        lines: [m.location.start.line, m.location.end.line],
      });
    }
  }
  return out.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.start.line - b.start.line ||
      a.start.column - b.start.column ||
      a.mutantId.localeCompare(b.mutantId, undefined, { numeric: true }),
  );
}

/** mulberry32: a small seeded PRNG giving floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle with a seeded PRNG; returns a new array. */
export function shuffle<T>(items: readonly T[], seed: number): T[] {
  const random = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * The golden-side lines a unified diff changes, per file: every removed line, and for a run of added
 * lines with nothing removed before it, the line before the insertion.
 */
export function changedLines(patchName: string, patch: string): DevBugLines[] {
  const out: DevBugLines[] = [];
  let current: DevBugLines | undefined;
  let oldLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let previous = ' ';
  for (const line of patch.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      const kind = line[0] ?? ' ';
      if (kind === '-') {
        current?.lines.push(oldLine);
        oldLine++;
        oldLeft--;
      } else if (kind === '+') {
        if (previous !== '-' && previous !== '+') current?.lines.push(Math.max(1, oldLine - 1));
        newLeft--;
      } else if (kind === ' ') {
        oldLine++;
        oldLeft--;
        newLeft--;
      }
      if (kind !== '\\') previous = kind;
      continue;
    }
    if (line.startsWith('+++ ')) {
      current = { patch: patchName, file: line.slice(4).trim().replace(/^b\//, ''), lines: [] };
      out.push(current);
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
      previous = ' ';
    }
  }
  return out
    .map((d) => ({ ...d, lines: [...new Set(d.lines)] }))
    .filter((d) => d.lines.length > 0);
}

/** True when two line ranges come within `window` lines of each other. */
export function near(a: LineRange, b: LineRange, window: number): boolean {
  return a[0] - window <= b[1] && b[0] <= a[1] + window;
}

/** The dev-bug change the candidate is too close to (SPEC §11.2 step 4), or null. */
export function devBugOverlap(c: Candidate, devBugs: readonly DevBugLines[], window: number): { patch: string; line: number } | null {
  for (const bug of devBugs) {
    if (bug.file !== c.file) continue;
    const line = bug.lines.find((l) => near(c.lines, [l, l], window));
    if (line !== undefined) return { patch: bug.patch, line };
  }
  return null;
}

/**
 * Why a drawn candidate is passed over without being recorded (SPEC §11.2 step 3), or null when it may be
 * tried: its layer is full, its file has `maxPerFile` variants, or it is near an accepted variant.
 */
export function passOver(
  c: Candidate,
  accepted: readonly Candidate[],
  quota: EvaluationConfig['codeVariants'],
  window: number,
): string | null {
  if (accepted.filter((a) => a.layer === c.layer).length >= quota[c.layer]) return 'layer full';
  const sameFile = accepted.filter((a) => a.file === c.file);
  if (sameFile.length >= quota.maxPerFile) return 'file full';
  if (sameFile.some((a) => near(a.lines, c.lines, window))) return 'near an accepted variant';
  return null;
}

export type TryResult = { ok: true } | { ok: false; reason: Exclude<VariantDiscard['reason'], 'overlaps-dev-bug'>; detail: string };

/**
 * Draws candidates in shuffled order until both quotas are met (SPEC §11.2 steps 3–7). `tryCandidate`
 * builds the patch and starts the app; dev-bug overlaps are discarded before it is called.
 */
export async function draw(
  shuffled: readonly Candidate[],
  options: { quota: EvaluationConfig['codeVariants']; window: number; devBugs: readonly DevBugLines[] },
  tryCandidate: (c: Candidate, attempt: number) => Promise<TryResult>,
): Promise<{ accepted: Candidate[]; discards: VariantDiscard[] }> {
  const { quota, window, devBugs } = options;
  const accepted: Candidate[] = [];
  const discards: VariantDiscard[] = [];
  const wanted = quota.backend + quota.frontend;
  const discard = (c: Candidate, reason: VariantDiscard['reason'], detail: string) =>
    discards.push({ strykerMutantId: c.mutantId, file: c.file, lines: c.lines, mutator: c.mutator, reason, detail });
  let attempt = 0;
  for (const c of shuffled) {
    if (accepted.length === wanted) break;
    if (passOver(c, accepted, quota, window)) continue;
    const overlap = devBugOverlap(c, devBugs, window);
    if (overlap) {
      discard(c, 'overlaps-dev-bug', `within ${window} lines of ${overlap.patch} (line ${overlap.line})`);
      continue;
    }
    const result = await tryCandidate(c, ++attempt);
    if (result.ok) accepted.push(c);
    else discard(c, result.reason, result.detail);
  }
  if (accepted.length < wanted) {
    const have = (l: Layer) => accepted.filter((a) => a.layer === l).length;
    throw new Error(
      `Only ${accepted.length} of ${wanted} code variants found (backend ${have('backend')}/${quota.backend}, frontend ${have('frontend')}/${quota.frontend}); widen the mutate globs`,
    );
  }
  return { accepted, discards };
}
