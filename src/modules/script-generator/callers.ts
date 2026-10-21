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
const MAX_ENDPOINTS = 6;

type Endpoint = Prd['apiEndpoints'][number];

/** A regex for an endpoint path, with `:param` segments matching any value (e.g. /api/product/item/:slug). */
const pathPattern = (p: string) => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z_]\w*/g, '[^/\\s]+')}$`);

/** The PRD endpoints a test case's steps, preconditions and title mention, by method and path. */
export function endpointsUsed(tc: TestCase, endpoints: Endpoint[]): Endpoint[] {
  const text = [tc.title, ...tc.preconditions, ...tc.steps].join('\n');
  const found: Endpoint[] = [];
  for (const m of text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)?\s*(\/[A-Za-z0-9_\-/:.{}]+)/g)) {
    const method = m[1];
    const urlPath = m[2]!.replace(/[.,;:]+$/, '').split('?')[0]!;
    const match = endpoints.find((e) => (!method || e.method === method) && pathPattern(e.path).test(urlPath));
    if (match && !found.includes(match)) found.push(match);
  }
  return found.slice(0, MAX_ENDPOINTS);
}

/**
 * Definitions, in the same file, of functions whose results the calling code uses
 * (e.g. `const products = getCartItems(cartItems)`): they often build the request body.
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
    const hits = out
      .split('\n')
      .map((l) => /^[^:]+:(.+?):(\d+):/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ file: m[1]!, line: Number(m[2]) }))
      .filter((h) => !isHidden(h.file, options.scope))
      .slice(0, HITS_PER_ENDPOINT);
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
        // The same lines may serve several endpoints (e.g. /cart/add and /cart/add/:cartId): show them once.
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
