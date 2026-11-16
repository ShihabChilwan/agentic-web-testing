import type { ExecutionResults, RecordedResponse, ScenarioDrop } from '../../shared/schemas.js';
import { endpointOf } from '../differential/diff.js';

/** One check run of the scenario scripts on the correct version: results and recorded responses. */
export interface CheckRun {
  results: ExecutionResults;
  responses: RecordedResponse[];
}

/** What a test's api object received, in order: endpoint (method, path with ids normalised) and status. */
function apiSequence(responses: readonly RecordedResponse[], id: string): Array<{ endpoint: string; status: number }> {
  return responses.filter((r) => r.testCaseId === id && r.source === 'api').map((r) => ({ endpoint: endpointOf(r.method, r.path), status: r.status }));
}

/**
 * Two endpoints of the same request in two runs: equal, or equal but for one path part (a value the app generates, such
 * as a random short code, which the comparator learns as a varying part).
 */
export function sameRequest(a: string, b: string): boolean {
  if (a === b) return true;
  const [pa, pb] = [a.split('?')[0]!.split('/'), b.split('?')[0]!.split('/')];
  if (pa.length !== pb.length || a.split('?')[1] !== b.split('?')[1]) return false;
  return pa.filter((part, i) => part !== pb[i]).length <= 1;
}

/** The page's own calls by endpoint: the statuses seen (presence varies with browser timing, so only shared endpoints count). */
function pageStatuses(responses: readonly RecordedResponse[], id: string): Map<string, string> {
  const out = new Map<string, Set<number>>();
  for (const r of responses.filter((x) => x.testCaseId === id && x.source === 'page')) {
    const key = endpointOf(r.method, r.path);
    if (!out.has(key)) out.set(key, new Set());
    out.get(key)!.add(r.status);
  }
  return new Map([...out.entries()].map(([k, v]) => [k, [...v].sort().join(',')]));
}

/**
 * Scenarios that behaved differently in two runs on the correct version (SPEC §6.5): a result other than passed in
 * either run, a different sequence of api responses (method, endpoint, status), or a page call to the same endpoint
 * with other statuses. Response bodies are left to the comparator's noise learning.
 */
export function unstableScenarios(ids: readonly string[], a: CheckRun, b: CheckRun): ScenarioDrop[] {
  const drops: ScenarioDrop[] = [];
  const status = (run: CheckRun, id: string) => run.results.results.find((r) => r.testCaseId === id)?.status ?? 'not run';
  for (const id of ids) {
    const [sa, sb] = [status(a, id), status(b, id)];
    if (sa !== 'passed' || sb !== 'passed') {
      drops.push({ id, reason: 'unstable-outcome', detail: `on the correct version it ${sa === sb ? `was ${sa} twice` : `was ${sa}, then ${sb}`}` });
      continue;
    }
    const [qa, qb] = [apiSequence(a.responses, id), apiSequence(b.responses, id)];
    const n = Math.max(qa.length, qb.length);
    const i = Array.from({ length: n }, (_, k) => k).find((k) => !qa[k] || !qb[k] || qa[k]!.status !== qb[k]!.status || !sameRequest(qa[k]!.endpoint, qb[k]!.endpoint));
    if (i !== undefined) {
      const show = (x: { endpoint: string; status: number } | undefined) => (x ? `${x.endpoint} ${x.status}` : '(none)');
      drops.push({ id, reason: 'unstable-responses', detail: `api responses differ between two runs at #${i + 1}: ${show(qa[i])} vs ${show(qb[i])}` });
      continue;
    }
    const [pa, pb] = [pageStatuses(a.responses, id), pageStatuses(b.responses, id)];
    const changed = [...pa.keys()].filter((k) => pb.has(k) && pb.get(k) !== pa.get(k));
    if (changed.length > 0) drops.push({ id, reason: 'unstable-responses', detail: `page calls answered differently: ${changed.map((k) => `${k} ${pa.get(k)} vs ${pb.get(k)}`).join('; ')}` });
  }
  return drops;
}
