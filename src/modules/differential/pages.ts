import type { RecordedPage, RecordedResponse } from '../../shared/schemas.js';
import { ABSENT } from './shapes.js';

/** The methods that mark a page snapshot among the records compared: after a navigation, or at the end of a test. */
export const PAGE_METHODS: ReadonlySet<string> = new Set(['PAGE', 'END']);

/**
 * Page snapshots as records the comparison handles like responses: method `PAGE` (after a navigation) or
 * `END` (end of the test), the page's path, and the snapshot text as a text body (status 0 and no body
 * when it could not be taken).
 */
export function pageRecords(pages: readonly RecordedPage[]): RecordedResponse[] {
  return pages.map((p) => ({
    testCaseId: p.testCaseId,
    seq: p.seq,
    source: 'page' as const,
    method: p.kind === 'end' ? 'END' : 'PAGE',
    path: p.path,
    status: p.snapshot === null ? 0 : 200,
    contentType: 'text/aria-snapshot',
    bodyKind: p.snapshot === null ? ('none' as const) : ('text' as const),
    body: p.snapshot,
    ...(p.error ? { error: p.error } : {}),
  }));
}

/**
 * The lines of an accessibility snapshot, each with its role path (the roles of its ancestors and its own,
 * e.g. `main>table>row>cell`) and its text without the leading `- ` and a trailing `:`.
 */
export function ariaLines(snapshot: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const stack: Array<{ indent: number; role: string }> = [];
  for (const raw of snapshot.split('\n')) {
    if (raw.trim() === '') continue;
    const indent = raw.length - raw.trimStart().length;
    let content = raw.trim();
    if (content.startsWith('- ')) content = content.slice(2);
    const role = /^([^\s:"[]+)/.exec(content)?.[1] ?? 'text';
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    out.push({ path: [...stack.map((s) => s.role), role].join('>'), text: content.replace(/:$/, '') });
    stack.push({ indent, role });
  }
  return out;
}

/**
 * The differences between two snapshots of the same page. Lines are grouped by role path; within a path,
 * lines on both sides cancel out (order is not compared), then a removed and an added line pair up as a
 * changed text (field = the role path), and a line left over is present on one side only (field
 * `<role path>(line)`).
 */
export function diffPageText(a: string, b: string): Array<{ field: string; path: string; a: unknown; b: unknown }> {
  const group = (lines: Array<{ path: string; text: string }>) => {
    const m = new Map<string, string[]>();
    for (const l of lines) m.set(l.path, [...(m.get(l.path) ?? []), l.text]);
    return m;
  };
  const ga = group(ariaLines(a));
  const gb = group(ariaLines(b));
  const minus = (xs: string[], ys: string[]) => {
    const left = new Map<string, number>();
    for (const y of ys) left.set(y, (left.get(y) ?? 0) + 1);
    return xs.filter((x) => {
      const n = left.get(x) ?? 0;
      if (n > 0) {
        left.set(x, n - 1);
        return false;
      }
      return true;
    });
  };
  const out: Array<{ field: string; path: string; a: unknown; b: unknown }> = [];
  for (const path of [...new Set([...ga.keys(), ...gb.keys()])].sort()) {
    const xa = ga.get(path) ?? [];
    const xb = gb.get(path) ?? [];
    const removed = minus(xa, xb);
    const added = minus(xb, xa);
    const changed = Math.min(removed.length, added.length);
    for (let i = 0; i < changed; i++) out.push({ field: path, path: `${path}#${i + 1}`, a: removed[i], b: added[i] });
    for (const t of removed.slice(changed)) out.push({ field: `${path}(line)`, path, a: t, b: ABSENT });
    for (const t of added.slice(changed)) out.push({ field: `${path}(line)`, path, a: ABSENT, b: t });
  }
  return out;
}
