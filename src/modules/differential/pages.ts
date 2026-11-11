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

type Line = { path: string; text: string };

/**
 * The differences between two lists of lines with role or element paths. Lines are grouped by path;
 * within a path, lines on both sides cancel out (order is not compared), then a removed and an added line
 * pair up as a changed text (field = the path), and a line left over is present on one side only (field
 * `<path><leftover>`).
 */
export function diffLines(la: readonly Line[], lb: readonly Line[], leftover: string): Array<{ field: string; path: string; a: unknown; b: unknown }> {
  const group = (lines: readonly Line[]) => {
    const m = new Map<string, string[]>();
    for (const l of lines) m.set(l.path, [...(m.get(l.path) ?? []), l.text]);
    return m;
  };
  const ga = group(la);
  const gb = group(lb);
  const out: Array<{ field: string; path: string; a: unknown; b: unknown }> = [];
  for (const path of [...new Set([...ga.keys(), ...gb.keys()])].sort()) {
    const xa = ga.get(path) ?? [];
    const xb = gb.get(path) ?? [];
    const removed = minus(xa, xb);
    const added = minus(xb, xa);
    const changed = Math.min(removed.length, added.length);
    for (let i = 0; i < changed; i++) out.push({ field: path, path: `${path}#${i + 1}`, a: removed[i], b: added[i] });
    for (const t of removed.slice(changed)) out.push({ field: `${path}${leftover}`, path, a: t, b: ABSENT });
    for (const t of added.slice(changed)) out.push({ field: `${path}${leftover}`, path, a: ABSENT, b: t });
  }
  return out;
}

/** The items of `xs` left after taking out one copy of each item of `ys`. */
function minus(xs: readonly string[], ys: readonly string[]): string[] {
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
}

/**
 * The differences between two snapshots of the same page: `diffLines` over their role paths, a line
 * present on one side only as field `<role path>(line)`.
 */
export function diffPageText(a: string, b: string): Array<{ field: string; path: string; a: unknown; b: unknown }> {
  return diffLines(ariaLines(a), ariaLines(b), '(line)');
}

/** Below this share of common lines, two snapshots taken at the same step show different pages. */
export const SAME_PAGE_MIN_SHARE = 0.5;

/**
 * The share of lines two snapshots have in common (common lines over all distinct lines, each line with
 * its role path). Two snapshots of one page that changed in a few places share most lines; a snapshot
 * taken while a fast chain of redirects moved on shows another page and shares only its frame.
 */
export function pageLineShare(a: string, b: string): number {
  const la = ariaLines(a).map((l) => `${l.path}\u0000${l.text}`);
  const lb = ariaLines(b).map((l) => `${l.path}\u0000${l.text}`);
  const total = la.length + lb.length;
  if (total === 0) return 1;
  const common = la.length - minus(la, lb).length;
  return common / (total - common);
}

/** Attributes an element is compared by: where it leads or sends, what it holds, and how it is named. */
const HTML_ATTRIBUTES = new Set([
  'href', 'src', 'action', 'method', 'name', 'value', 'type', 'checked', 'selected', 'disabled', 'placeholder', 'title', 'alt', 'role',
  'aria-label', 'for', 'hx-get', 'hx-post', 'hx-put', 'hx-patch', 'hx-delete',
]);
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style']);

/** True for a text body that is an HTML page or fragment. */
export function isHtml(contentType: string | undefined, body: unknown): boolean {
  if (typeof body !== 'string') return false;
  return /html/i.test(contentType ?? '') || /^\s*</.test(body);
}

/**
 * The elements of an HTML page or fragment as lines: each element that has text of its own or a compared
 * attribute (HTML_ATTRIBUTES) gives one line `tag[attr="value" ...] "text"`, with its path of ancestor
 * tags (`html>body>nav>ul>li>a`). Whitespace is collapsed, comments and the contents of script and style
 * elements are left out (scripts with a `src` keep it). A tolerant reader: an unclosed element ends with its
 * parent.
 */
export function htmlLines(html: string): Line[] {
  type Open = { tag: string; attrs: string; text: string[]; line: number };
  const lines: Array<Line | null> = [];
  const stack: Open[] = [];
  const close = (e: Open) => {
    const text = e.text.join(' ').replace(/\s+/g, ' ').trim();
    const path = [...stack.map((s) => s.tag), e.tag].join('>');
    lines[e.line] = text || e.attrs ? { path, text: `${e.tag}${e.attrs ? `[${e.attrs}]` : ''}${text ? ` ${JSON.stringify(text)}` : ''}` } : null;
  };
  const token = /<!--[\s\S]*?-->|<![^>]*>|<\/\s*([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
  let at = 0;
  let m: RegExpExecArray | null;
  const addText = (t: string) => {
    if (stack.length > 0 && t.trim()) stack[stack.length - 1]!.text.push(t);
  };
  while ((m = token.exec(html)) !== null) {
    addText(html.slice(at, m.index));
    at = token.lastIndex;
    if (m[1]) {
      const tag = m[1].toLowerCase();
      const i = stack.map((s) => s.tag).lastIndexOf(tag);
      if (i < 0) continue;
      while (stack.length > i) close(stack.pop()!);
      continue;
    }
    if (!m[2]) continue; // a comment or a doctype
    const tag = m[2].toLowerCase();
    const attrs = [...(m[3] ?? '').matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)]
      .map((a) => [a[1]!.toLowerCase(), (a[2] ?? a[3] ?? a[4] ?? '').replace(/\s+/g, ' ').trim()] as const)
      .filter(([k]) => HTML_ATTRIBUTES.has(k))
      .sort(([x], [y]) => x.localeCompare(y))
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(' ');
    const open: Open = { tag, attrs, text: [], line: lines.length };
    lines.push(null);
    if (VOID_ELEMENTS.has(tag) || m[4] === '/') {
      close(open);
      continue;
    }
    if (RAW_TEXT.has(tag)) {
      const end = html.toLowerCase().indexOf(`</${tag}`, at);
      const stop = end < 0 ? html.length : end;
      at = stop;
      token.lastIndex = stop;
    }
    stack.push(open);
  }
  addText(html.slice(at));
  while (stack.length > 0) close(stack.pop()!);
  return lines.filter((l): l is Line => l !== null);
}

/**
 * The differences between two HTML bodies, element by element: `diffLines` over `htmlLines`, an element
 * present on one side only as field `<element path>(element)`. Elements in another order are no difference.
 */
export function diffHtml(a: string, b: string): Array<{ field: string; path: string; a: unknown; b: unknown }> {
  return diffLines(htmlLines(a), htmlLines(b), '(element)');
}
