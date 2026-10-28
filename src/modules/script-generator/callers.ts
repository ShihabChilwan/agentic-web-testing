import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isHidden } from '../../agent/tools/repo-tools.js';
import type { RepoScope } from '../../agent/tools/repo-tools.js';
import type { Prd, TestCase } from '../../shared/schemas.js';
import type { EvidenceBlock, ReadLines } from '../test-case-generator/context.js';

const execFileAsync = promisify(execFile);

/** Characters of frontend calling code added per test case. */
export const CALLERS_CHAR_CAP = 8_000;
const LINES_AROUND = 12;
const HITS_PER_ENDPOINT = 2;
/** Lines before a hit that rankHit may read (a multi-line `<form` tag), and the most a form block may span. */
const FORM_LINES_BEFORE = 5;
const FORM_MAX_LINES = 80;
/** Rank a hit: 2 = a call with the endpoint's method to its whole path, 1 = a call with its method, 0 = any other mention. */
export type HitRank = 0 | 1 | 2;
const MAX_ENDPOINTS = 6;

type Endpoint = Prd['apiEndpoints'][number];

/** A regex for an endpoint path, with `:param` segments matching any value (e.g. /api/items/:id). */
const pathPattern = (p: string) => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z_]\w*/g, '[^/\\s]+')}$`);

/** The PRD endpoints a test case's steps, preconditions and title mention, by method and path. */
export function endpointsUsed(tc: TestCase, endpoints: Endpoint[]): Endpoint[] {
  const text = [tc.title, ...tc.preconditions, ...tc.steps].join('\n');
  const found: Endpoint[] = [];
  for (const m of text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)?\s*(\/[A-Za-z0-9_\-/:.{}<>]+)/g)) {
    const method = m[1];
    const urlPath = m[2]!.replace(/[.,;:]+$/, '').split('?')[0]!;
    const match = endpoints.find((e) => (!method || e.method === method) && pathPattern(e.path).test(urlPath));
    if (match && !found.includes(match)) found.push(match);
  }
  return found.slice(0, MAX_ENDPOINTS);
}

/**
 * Definitions, in the same file, of functions whose results the calling code uses
 * (e.g. `const lines = toLines(items)`): they often build the request body.
 */
export function helperRanges(lines: string[], start: number, end: number): Array<{ start: number; end: number; name: string }> {
  const names = new Set<string>();
  for (const line of lines.slice(start - 1, end)) {
    for (const m of line.matchAll(/=\s*(?:await\s+)?([A-Za-z_$][\w$]*)\(/g)) names.add(m[1]!);
  }
  const ranges: Array<{ start: number; end: number; name: string }> = [];
  for (const name of names) {
    const def = lines.findIndex((l) => new RegExp(`^(export\\s+)?(const|let|var|function|async function)\\s+${name.replace(/\$/g, '\\$')}\\b`).test(l));
    if (def < 0 || (def + 1 >= start && def + 1 <= end)) continue;
    let last = def;
    while (last < lines.length - 1 && last - def < 30 && !/^\}/.test(lines[last]!)) last++;
    ranges.push({ start: def + 1, end: last + 1, name });
  }
  return ranges;
}

/** The fixed part of an endpoint path to search for in the frontend: without the API prefix, up to the first parameter. */
export function searchText(endpoint: Endpoint, apiPrefix: string): string | null {
  const prefix = apiPrefix.replace(/\/$/, '');
  const rest = prefix && endpoint.path.startsWith(prefix) ? endpoint.path.slice(prefix.length) : endpoint.path;
  const fixed = rest.split('/:')[0]!;
  return fixed.length >= 4 && fixed !== '/' ? fixed : null;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** An htmx request attribute (`hx-post="/x"`, also `data-hx-post`) or a form's `action=` on this line. */
export const MARKUP_REQUEST = /\b(?:data-)?hx-(?:get|post|put|patch|delete)\s*=|\baction\s*=/i;

/**
 * How well a line of frontend code (with the lines before it, the last one first considered) is a request for the
 * endpoint: a call of the endpoint's HTTP method (`axios.put(`, `http.put(`, `fetch(` with the method named), an htmx
 * attribute of that method (`hx-post=`), or a `<form>` whose `action=` is on this line and whose method is that one
 * (no `method=` means GET), naming its whole path, where a parameter is anything in one segment (`${id}`, `:id`,
 * `{id}`, a variable). Page routes and links that only mention the path rank 0.
 */
export function rankHit(endpoint: Endpoint, apiPrefix: string, line: string, previous = ''): HitRank {
  const method = endpoint.method.toLowerCase();
  const text = `${previous.split('\n').at(-1) ?? ''}\n${line}`;
  const code = new RegExp(`\\.${method}\\s*[(<]`, 'i').test(text) || (/\bfetch\s*\(/.test(text) && new RegExp(`method\\s*:\\s*['"\`]${endpoint.method}['"\`]`, 'i').test(text));
  const htmx = new RegExp(`\\b(?:data-)?hx-${method}\\s*=`, 'i').test(line);
  // The form's opening tag may run over several lines: its method sits in the lines before `action=`, but only in the
  // tag the `action=` belongs to (the last `<form` before it), not in an earlier form.
  const formText = `${previous}\n${line}`;
  const tag = formText.includes('<form') ? formText.slice(formText.toLowerCase().lastIndexOf('<form')) : '';
  const form =
    tag !== '' &&
    /\baction\s*=/i.test(line) &&
    (new RegExp(`\\bmethod\\s*=\\s*["']?${method}\\b`, 'i').test(tag) || (method === 'get' && !/\bmethod\s*=/i.test(tag)));
  if (!code && !htmx && !form) return 0;
  const prefix = apiPrefix.replace(/\/$/, '');
  const rest = prefix && endpoint.path.startsWith(prefix) ? endpoint.path.slice(prefix.length) : endpoint.path;
  const whole = rest
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '(?:\\$\\{[^}]*\\}|[^/\\s\'"`?)]+)' : escapeRegex(segment)))
    .join('/');
  return new RegExp(`${whole}(?=[\\s'"\`?),]|$)`).test(line) ? 2 : 1;
}

/**
 * The `<form> ... </form>` around a line, when there is one: where its fields are, which show the request shape
 * (field names) that an htmx or a plain form sends. 1-based, inclusive; null when no form encloses the line.
 */
export function enclosingForm(lines: readonly string[], line: number): { start: number; end: number } | null {
  let start = -1;
  for (let i = line - 1; i >= Math.max(0, line - 40); i--) {
    if (i < line - 1 && /<\/form\b/i.test(lines[i]!)) return null; // that form was closed before this line
    if (/<form\b/i.test(lines[i]!)) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return null;
  for (let i = line - 1; i < Math.min(lines.length, start + FORM_MAX_LINES); i++) {
    if (/<\/form\b/i.test(lines[i]!)) return { start, end: i + 1 };
  }
  return null;
}

/**
 * How the markup request at `line` sends its body, when the page itself decides it: `form` (urlencoded, what a plain
 * form and htmx send by default), `multipart` (`enctype` or `hx-encoding` multipart), null when there is no body to
 * encode (GET) or the page does not send a form (htmx with a JSON extension, `jsonEncoded`).
 */
export function requestEncoding(
  endpoint: Endpoint,
  lines: readonly string[],
  line: number,
  form: { start: number } | null,
  jsonEncoded: boolean,
): 'form' | 'multipart' | null {
  if (endpoint.method === 'GET' || endpoint.method === 'DELETE') return null; // htmx puts their values in the URL
  const hit = lines[line - 1] ?? '';
  const isHtmx = /\b(?:data-)?hx-(?:get|post|put|patch|delete)\s*=/i.test(hit);
  // The opening tag of the form (it may run over several lines) and the hit's own line.
  const tag = form ? lines.slice(form.start - 1, Math.min(lines.length, form.start + 5)).join('\n').split('>')[0]! : '';
  const own = `${hit}\n${tag}`;
  if (isHtmx && (jsonEncoded || lines.slice(0, line).some((l) => /\bhx-ext\s*=\s*["'][^"']*json-enc/i.test(l)))) return null;
  return /\b(?:enctype\s*=\s*["']?multipart\/form-data|(?:data-)?hx-encoding\s*=\s*["']?multipart\/form-data)/i.test(own) ? 'multipart' : 'form';
}

/**
 * Frontend code that calls the endpoints a test case uses, read at the generation commit: it shows the
 * request shape the app really sends (fields, nesting), which the route handler alone often does not.
 * Searched with `git grep` in the page source folders; hidden paths are skipped.
 */
export async function callerBlocks(
  tc: TestCase,
  options: {
    endpoints: Endpoint[];
    apiPrefix: string;
    frontendRoots: string[];
    scope: RepoScope;
    commit: string;
    read: ReadLines;
    /** The login endpoint (auth.login): the helpers handle it, so its callers are not shown. */
    skip?: { method: string; path: string };
  },
): Promise<EvidenceBlock[]> {
  const blocks: EvidenceBlock[] = [];
  let used = 0;
  // An htmx JSON extension anywhere in the page source (it is usually set on a layout above the request): then an
  // htmx request's encoding is not known to be a form, and nothing is claimed.
  let jsonEncoded: boolean | undefined;
  const anyJsonEncoding = async () => {
    jsonEncoded ??= await execFileAsync('git', ['-C', options.scope.root, 'grep', '-l', '-i', '-F', '-e', 'json-enc', options.commit, '--', ...options.frontendRoots]).then(
      () => true,
      () => false,
    );
    return jsonEncoded;
  };
  for (const endpoint of endpointsUsed(tc, options.endpoints)) {
    if (options.skip && endpoint.method === options.skip.method && endpoint.path === options.skip.path) continue;
    const needle = searchText(endpoint, options.apiPrefix);
    if (!needle) continue;
    let out: string;
    try {
      ({ stdout: out } = await execFileAsync('git', ['-C', options.scope.root, 'grep', '-n', '-F', '-e', needle, options.commit, '--', ...options.frontendRoots], { maxBuffer: 10 * 1024 * 1024 }));
    } catch {
      continue; // no match (git grep exits 1)
    }
    const found = out
      .split('\n')
      .map((l) => /^[^:]+:(.+?):(\d+):(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ file: m[1]!, line: Number(m[2]), text: m[3]! }))
      .filter((h) => !isHidden(h.file, options.scope));
    // Requests first: a mention of the path in a page route or a link says nothing about the request's shape.
    const ranked = await Promise.all(
      found.map(async (h) => {
        const before = ((await options.read(h.file)) ?? []).slice(Math.max(0, h.line - 1 - FORM_LINES_BEFORE), h.line - 1).join('\n');
        return { ...h, rank: rankHit(endpoint, options.apiPrefix, h.text, before) };
      }),
    );
    // Only the best rank counts: a request to a longer path (rank 1) would show another endpoint's fields next to it.
    const best = Math.max(0, ...ranked.map((h) => h.rank));
    const hits = (best > 0 ? ranked.filter((h) => h.rank === best) : ranked).slice(0, HITS_PER_ENDPOINT);
    for (const hit of hits) {
      const lines = await options.read(hit.file);
      if (!lines) continue;
      // A request in markup (htmx attribute, form action) is shown with its whole form, where the fields are.
      const form = hit.rank > 0 && MARKUP_REQUEST.test(hit.text) ? enclosingForm(lines, hit.line) : null;
      const start = form?.start ?? Math.max(1, hit.line - LINES_AROUND);
      const end = form?.end ?? Math.min(lines.length, hit.line + LINES_AROUND);
      const calls = `${endpoint.method} ${endpoint.path}`;
      const encoding = hit.rank > 0 && MARKUP_REQUEST.test(hit.text) ? requestEncoding(endpoint, lines, hit.line, form, await anyJsonEncoding()) : null;
      const candidates: EvidenceBlock[] = [
        { file: hit.file, start, end, lines: lines.slice(start - 1, end), calls, ...(encoding ? { encoding } : {}) },
        ...helperRanges(lines, start, end).map((r) => ({
          file: hit.file, start: r.start, end: r.end, lines: lines.slice(r.start - 1, r.end), calls: `${calls}, helper ${r.name}`,
        })),
      ];
      for (const block of candidates) {
        // The same lines may serve several endpoints (e.g. /items/add and /items/add/:listId): show them once.
        if (blocks.some((b) => b.file === block.file && b.start === block.start && b.end === block.end)) continue;
        const size = block.lines.join('\n').length;
        if (used + size > CALLERS_CHAR_CAP) return blocks;
        used += size;
        blocks.push(block);
      }
    }
  }
  return blocks;
}
