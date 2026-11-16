// Same LEAK_PATTERN and file rules as src/eval/cloud/leaks.ts, with two differences: every line is checked (not only the
// first hit per file), and a match that is an HTTP PATCH call ('.patch(' as in api.patch(...)) is not a leak word.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { LEAK_PATTERN, type Leak } from '/workspaces/agentic-web-testing/src/eval/cloud/leaks.js';
import { filesUnder } from '/workspaces/agentic-web-testing/src/eval/cloud/suite.js';
const BINARY = /\.(zip|png|jpe?g|webm|gz)$/i;
const G = new RegExp(LEAK_PATTERN.source, 'g');
const leakWords = (s: string) => [...s.matchAll(G)].filter((m) => !(m[0] === '.patch' && s[m.index! + m[0].length] === '(')).map((m) => m[0]);
export async function findLeaks(dir: string): Promise<Leak[]> {
  const leaks: Leak[] = [];
  let patchCalls = 0;
  for (const rel of (await filesUnder(dir)).sort()) {
    const named = leakWords(rel);
    if (named.length) { leaks.push({ file: rel, line: 0, match: named[0]! }); continue; }
    if (BINARY.test(rel)) continue;
    const text = await readFile(path.join(dir, rel), 'utf8');
    if (text.includes('\u0000')) continue;
    text.split('\n').forEach((l, i) => {
      for (const w of leakWords(l)) leaks.push({ file: rel, line: i + 1, match: w });
      patchCalls += (l.match(/\.patch\(/g) ?? []).length;
    });
  }
  console.log(`${path.basename(dir)}: every line checked, ${leaks.length} leak words, ${patchCalls} HTTP PATCH calls ignored`);
  return leaks;
}
