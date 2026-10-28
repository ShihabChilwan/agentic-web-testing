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

/**
 * How well a line of frontend code (with the line before it) is a request for the endpoint: a call of the endpoint's
 * HTTP method (`axios.put(`, `http.put(`, `fetch(` with the method named) naming its whole path, where a parameter
 * is anything in one segment (`${id}`, `:id`, a variable). Page routes and links that only mention the path rank 0.
 */
export function rankHit(endpoint: Endpoint, apiPrefix: string, line: string, previous = ''): HitRank {
  const method = endpoint.method.toLowerCase();
  const text = `${previous}\n${line}`;
  const calls = new RegExp(`\\.${method}\\s*[(<]`, 'i').test(text) || (/\bfetch\s*\(/.test(text) && new RegExp(`method\\s*:\\s*['"\`]${endpoint.method}['"\`]`, 'i').test(text));
  if (!calls) return 0;
  const prefix = apiPrefix.replace(/\/$/, '');
  const rest = prefix && endpoint.path.startsWith(prefix) ? endpoint.path.slice(prefix.length) : endpoint.path;
  const whole = rest
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '(?:\\$\\{[^}]*\\}|[^/\\s\'"`?)]+)' : escapeRegex(segment)))
    .join('/');
  return new RegExp(`${whole}(?=[\\s'"\`?),]|$)`).test(line) ? 2 : 1;
}

/**
 * Frontend code that calls the endpoints a test case uses, read at the generation commit: it shows the
 * request shape the app really sends (fields, nesting), which the route handler alone often does not.
 * Searched with `git grep` in `frontend.sourceRoots`; hidden paths are skipped.
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
      found.map(async (h) => ({ ...h, rank: rankHit(endpoint, options.apiPrefix, h.text, h.line > 1 ? ((await options.read(h.file))?.[h.line - 2] ?? '') : '') })),
    );
    const requests = ranked.filter((h) => h.rank > 0).sort((a, b) => b.rank - a.rank);
    const hits = (requests.length > 0 ? requests : ranked).slice(0, HITS_PER_ENDPOINT);
    for (const hit of hits) {
      const lines = await options.read(hit.file);
      if (!lines) continue;
      const start = Math.max(1, hit.line - LINES_AROUND);
      const end = Math.min(lines.length, hit.line + LINES_AROUND);
      const calls = `${endpoint.method} ${endpoint.path}`;
      const candidates: EvidenceBlock[] = [
        { file: hit.file, start, end, lines: lines.slice(start - 1, end), calls },
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
