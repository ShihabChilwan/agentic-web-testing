import type { ComparisonKind, ComparisonRow, ViewExecution, ViewTest, ViewTestStatus } from '../../shared/schemas.js';

const isFailure = (s: ViewTestStatus | null) => s === 'failed' || s === 'errored';
const ran = (s: ViewTestStatus | null) => s !== null && s !== 'skipped';

/** The kind of change from one status to another, or null when nothing changed (SPEC §9.1). */
export function changeKind(from: ViewTestStatus | null, to: ViewTestStatus | null): ComparisonKind | null {
  if (from === to) return null;
  if (!ran(from) || !ran(to)) return 'only-in-one';
  if (from === 'passed') return 'newly-failing';
  if (to === 'passed') return 'fixed';
  return isFailure(from) && isFailure(to) ? 'failure-changed' : null;
}

/** One row per test whose status differs between two executions, in the order the tests first appear. */
export function compareTests(a: readonly ViewTest[], b: readonly ViewTest[]): ComparisonRow[] {
  const from = new Map(a.map((t) => [t.testCaseId, t.status]));
  const to = new Map(b.map((t) => [t.testCaseId, t.status]));
  const ids = [...new Set([...a.map((t) => t.testCaseId), ...b.map((t) => t.testCaseId)])];
  return ids.flatMap((testCaseId) => {
    const f = from.get(testCaseId) ?? null;
    const t = to.get(testCaseId) ?? null;
    const kind = changeKind(f, t);
    return kind ? [{ testCaseId, from: f, to: t, kind }] : [];
  });
}

/** Every unordered pair of executions that both have results, keyed "<a>|<b>" in the given order. */
export function allComparisons(executions: readonly ViewExecution[]): Record<string, ComparisonRow[]> {
  const withResults = executions.filter((e) => e.summary !== null);
  const out: Record<string, ComparisonRow[]> = {};
  for (const [i, a] of withResults.entries()) {
    for (const b of withResults.slice(i + 1)) out[`${a.execId}|${b.execId}`] = compareTests(a.tests, b.tests);
  }
  return out;
}
