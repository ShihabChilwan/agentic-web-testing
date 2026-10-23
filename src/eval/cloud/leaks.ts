import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { filesUnder } from './suite.js';

/** Words that name a version or its answer (SPEC §8.4): none may appear in what the analyzer can read. */
export const LEAK_PATTERN = /\bgolden\b|\bbug-\d{3}\b|\benv-\d{2}\b|variants|\.patch\b|dev-bugs/;

/** Files the analyzer cannot read (binary artifacts such as trace.zip and screenshots). */
const BINARY = /\.(zip|png|jpe?g|webm|gz)$/i;

export interface Leak {
  file: string;
  line: number;
  match: string;
}

/** Every leak word in the file names and text files under `dir` (relative paths, first hit per file; line 0 = the name). */
export async function findLeaks(dir: string): Promise<Leak[]> {
  const leaks: Leak[] = [];
  for (const rel of (await filesUnder(dir)).sort()) {
    const named = LEAK_PATTERN.exec(rel);
    if (named) {
      leaks.push({ file: rel, line: 0, match: named[0] });
      continue;
    }
    if (BINARY.test(rel)) continue;
    const text = await readFile(path.join(dir, rel), 'utf8');
    if (text.includes('\u0000')) continue;
    const lines = text.split('\n');
    const i = lines.findIndex((l) => LEAK_PATTERN.test(l));
    if (i >= 0) leaks.push({ file: rel, line: i + 1, match: LEAK_PATTERN.exec(lines[i]!)![0] });
  }
  return leaks;
}
