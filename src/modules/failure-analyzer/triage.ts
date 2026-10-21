import { stripAnsi } from '../script-generator/classify.js';
import type { ExecutionResults, Incident, TestResult } from '../../shared/schemas.js';

const MAX_SIGNATURE_CHARS = 500;

/**
 * The error message with only the parts that change between runs removed (SPEC §8.1): URL origins and host:port, 24-hex
 * ids, uniq() values, ISO timestamps, durations and :line:col positions. Everything else stays, so
 * "Expected: 400 Received: 200" and "Expected: 404 Received: 200" remain different.
 */
export function normaliseError(message: string): string {
  const head = stripAnsi(message).split(/^\s*Call log:/m)[0] ?? '';
  return head
    .replace(/https?:\/\/[^/\s'"`]+/g, '<origin>')
    // a host and port without a scheme, e.g. "connect ECONNREFUSED 127.0.0.1:3000"
    .replace(/\b(?:\d{1,3}(?:\.\d{1,3}){3}|localhost|\[::1\]):\d+\b/g, '<host>')
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '<time>')
    .replace(/\b[0-9a-f]{24}\b/g, '<id>')
    // uniq('item') → item-<base36 time>-<random>; the time part always holds a digit
    .replace(/\b[A-Za-z]\w*-(?=[0-9a-z]*\d)[0-9a-z]{6,12}-[0-9a-z]{1,8}\b/g, '<uniq>')
    .replace(/\b\d+ms\b/g, '<n>ms')
    .replace(/:\d+:\d+\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SIGNATURE_CHARS);
}

/** The grouping key of one non-passed result: status, category and the normalised message. */
export function signatureOf(result: TestResult): string {
  return [result.status, result.error?.category ?? '', normaliseError(result.error?.message ?? '')].join(' | ');
}

export interface FailureGroup {
  signature: string;
  /** In execution order. */
  testCaseIds: string[];
}

/** What the environment looked like during the execution, attached to every group. */
export interface EnvironmentSummary {
  healthChecks: ExecutionResults['environment']['healthChecks'];
  seed: ExecutionResults['environment']['seed'];
  seedCheck: ExecutionResults['environment']['seedCheck'] | null;
  incidents: Incident[];
  /** Tests that ran without a data restore before them (isolated: false). */
  notIsolated: string[];
}

export interface Triage {
  failures: TestResult[];
  groups: FailureGroup[];
  environment: EnvironmentSummary;
}

/** Step 1 of the analyzer, no model: failed and errored results grouped by signature, plus the environment. */
export function triage(results: ExecutionResults): Triage {
  const failures = results.results.filter((r) => r.status !== 'passed');
  const bySignature = new Map<string, FailureGroup>();
  for (const result of failures) {
    const signature = signatureOf(result);
    const group = bySignature.get(signature) ?? { signature, testCaseIds: [] };
    group.testCaseIds.push(result.testCaseId);
    bySignature.set(signature, group);
  }
  const groups = [...bySignature.values()].sort((a, b) => a.testCaseIds[0]!.localeCompare(b.testCaseIds[0]!));
  return {
    failures,
    groups,
    environment: {
      healthChecks: results.environment.healthChecks,
      seed: results.environment.seed,
      seedCheck: results.environment.seedCheck ?? null,
      incidents: results.incidents,
      notIsolated: results.results.filter((r) => !r.isolated).map((r) => r.testCaseId),
    },
  };
}
