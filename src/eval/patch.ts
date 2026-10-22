import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Candidate, Position } from './sample.js';

const execFileAsync = promisify(execFile);

function offsetOf(lineStarts: number[], p: Position): number {
  const start = lineStarts[p.line - 1];
  if (start === undefined) throw new Error(`Line ${p.line} is outside the file`);
  return start + p.column - 1;
}

/** The source with the mutant's range replaced (1-based positions, `end` exclusive). */
export function applyMutant(source: string, c: Pick<Candidate, 'start' | 'end' | 'replacement'>): string {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStarts.push(i + 1);
  return source.slice(0, offsetOf(lineStarts, c.start)) + c.replacement + source.slice(offsetOf(lineStarts, c.end));
}

/** The mutant's whole lines before and after the change (SPEC §11.4 `original` and `mutated`). */
export function mutantLines(source: string, mutated: string, c: Pick<Candidate, 'lines'>): { original: string; mutated: string } {
  const before = source.split('\n');
  const after = mutated.split('\n');
  const [first, last] = c.lines;
  const lastAfter = last + (after.length - before.length);
  return { original: before.slice(first - 1, last).join('\n'), mutated: after.slice(first - 1, lastAfter).join('\n') };
}

/**
 * A patch relative to the repo root (`a/<file>`, `b/<file>`) that turns `source` into `mutated`, written by
 * `git diff --no-index` from a scratch folder holding both versions.
 */
export async function filePatch(file: string, source: string, mutated: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'awt-diff-'));
  try {
    for (const [side, text] of [['a', source], ['b', mutated]] as const) {
      await mkdir(path.dirname(path.join(dir, side, file)), { recursive: true });
      await writeFile(path.join(dir, side, file), text);
    }
    try {
      await execFileAsync('git', ['diff', '--no-index', '--no-prefix', '--no-color', path.posix.join('a', file), path.posix.join('b', file)], { cwd: dir });
    } catch (err) {
      // git diff --no-index exits 1 when the files differ: that is the expected case.
      const { code, stdout } = err as { code?: number; stdout?: string };
      if (code === 1 && stdout) return stdout;
      throw new Error(`git diff --no-index failed for ${file}`, { cause: err });
    }
    throw new Error(`The mutant does not change ${file}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
