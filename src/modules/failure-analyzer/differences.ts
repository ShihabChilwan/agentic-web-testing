import { readFile } from 'node:fs/promises';
import { ResponseComparison } from '../../shared/schemas.js';

/** At most this many difference groups get a session per execution; the rest stay readable through get_differences. */
export const MAX_DIFFERENCE_GROUPS = 6;
/** Example tests per difference group: the session diagnoses these; the other tests show the same differences. */
export const MAX_GROUP_TESTS = 5;
const MAX_VALUE_CHARS = 300;

/**
 * One strong difference between a reference run and this run (SPEC §8.5), as the analyzer may see it:
 * no execution ids, no file names, only the test, the endpoint and the two values.
 */
export interface DifferenceLine {
  testCaseId: string;
  endpoint: string;
  occurrence: number;
  field: string;
  path: string;
  reference: unknown;
  current: unknown;
  reason: string;
}

/** Tests that passed but whose responses or pages differ from the reference run in the same way, or a setup finding. */
export interface DifferenceGroup {
  kind: 'difference' | 'setup';
  /** Endpoint path (without query values) and the differing fields: what the tests have in common. */
  key: string;
  /** The tests the session diagnoses (at most MAX_GROUP_TESTS examples). */
  testCaseIds: string[];
  /** Every test that shows these differences. */
  allTests: string[];
  lines: DifferenceLine[];
  /** For a setup finding: what the comparator found. */
  message?: string;
}

export interface DifferenceEvidence {
  /** Strong differences of tests that failed: evidence added to their failure group. */
  byFailingTest: Map<string, DifferenceLine[]>;
  /** Strong differences of tests that passed, grouped, largest first, capped. */
  groups: DifferenceGroup[];
  /** Groups left out by the cap. */
  leftOut: number;
  /** Every strong difference, for get_differences. */
  all: DifferenceLine[];
  /** Weak differences (a browser call or page line in one run only); counted, never analysed. */
  weak: number;
}

const short = (v: unknown): unknown => {
  const text = typeof v === 'string' ? v : JSON.stringify(v);
  if (text === undefined || text.length <= MAX_VALUE_CHARS) return v;
  return `${text.slice(0, MAX_VALUE_CHARS)}… (${text.length} characters)`;
};

/**
 * Groups a comparison's strong differences for the analyzer (SPEC §8.5): differences of failing tests go
 * to those tests as evidence; differences of passing tests are grouped by endpoint path (query values
 * left out) and the set of differing fields, across tests, so one cause that shows in 50 tests is one
 * group; a setup finding is a group of its own. Groups are ordered by size and capped.
 */
export function groupDifferences(comparison: ResponseComparison, failing: ReadonlySet<string>): DifferenceEvidence {
  const all: DifferenceLine[] = [];
  let weak = 0;
  for (const t of comparison.tests) {
    for (const e of t.endpoints) {
      for (const d of e.differences) {
        if (d.strength === 'weak') {
          weak += 1;
          continue;
        }
        all.push({ testCaseId: t.testCaseId, endpoint: e.endpoint, occurrence: e.occurrence, field: d.field, path: d.path, reference: short(d.base), current: short(d.other), reason: d.reason });
      }
    }
  }
  const byFailingTest = new Map<string, DifferenceLine[]>();
  const byKey = new Map<string, { tests: string[]; lines: DifferenceLine[] }>();
  // Per test and endpoint first: the set of fields that differ there is the symptom.
  const perTestEndpoint = new Map<string, DifferenceLine[]>();
  for (const line of all) {
    if (failing.has(line.testCaseId)) {
      byFailingTest.set(line.testCaseId, [...(byFailingTest.get(line.testCaseId) ?? []), line]);
      continue;
    }
    const k = `${line.testCaseId}\u0000${line.endpoint}`;
    perTestEndpoint.set(k, [...(perTestEndpoint.get(k) ?? []), line]);
  }
  for (const lines of perTestEndpoint.values()) {
    const endpoint = lines[0]!.endpoint.split('?')[0]!;
    const key = `${endpoint} [${[...new Set(lines.map((l) => l.field))].sort().join(', ')}]`;
    const entry = byKey.get(key) ?? { tests: [], lines: [] };
    if (!entry.tests.includes(lines[0]!.testCaseId)) entry.tests.push(lines[0]!.testCaseId);
    entry.lines.push(...lines);
    byKey.set(key, entry);
  }
  const groups: DifferenceGroup[] = [...byKey.entries()]
    .map(([key, e]) => {
      const tests = [...e.tests].sort();
      return { kind: 'difference' as const, key, testCaseIds: tests.slice(0, MAX_GROUP_TESTS), allTests: tests, lines: e.lines };
    })
    .sort((x, y) => y.lines.length - x.lines.length || x.key.localeCompare(y.key));
  // A setup finding: the whole execution's data was set up differently. Its example tests are the
  // passing tests with the most differences; without any, the first tests of the comparison.
  const setup: DifferenceGroup[] = comparison.findings.map((f) => {
    const candidates = [...new Set([...groups.flatMap((g) => g.allTests), ...comparison.tests.map((t) => t.testCaseId)])].filter((id) => !failing.has(id));
    const examples = (candidates.length > 0 ? candidates : comparison.tests.map((t) => t.testCaseId)).slice(0, 3);
    return { kind: 'setup', key: f.kind, testCaseIds: examples, allTests: examples, lines: [], message: `${f.message} (${f.count} differences that only change ids)` };
  });
  const ordered = [...setup, ...groups].filter((g) => g.testCaseIds.length > 0);
  return {
    byFailingTest,
    groups: ordered.slice(0, MAX_DIFFERENCE_GROUPS),
    leftOut: Math.max(0, ordered.length - MAX_DIFFERENCE_GROUPS),
    all,
    weak,
  };
}

/** Reads a comparison file (SPEC §7.6). Only its differences reach the analyzer, never its execution ids or file names. */
export async function readComparison(file: string): Promise<ResponseComparison> {
  return ResponseComparison.parse(JSON.parse(await readFile(file, 'utf8')));
}

const value = (v: unknown) => (typeof v === 'string' ? JSON.stringify(v) : (JSON.stringify(v) ?? 'undefined'));

/** Difference lines as text for a task or a tool: test, endpoint, field, reference value, this run's value, reason. */
export function formatDifferences(lines: readonly DifferenceLine[], max: number): string[] {
  const shown = lines.slice(0, max).map((l) => `- ${l.testCaseId} ${l.endpoint}${l.occurrence > 1 ? ` (call ${l.occurrence})` : ''} ${l.path}: reference ${value(l.reference)} → this run ${value(l.current)} [${l.reason}]`);
  return lines.length > max ? [...shown, `- … ${lines.length - max} more (get_differences shows all)`] : shown;
}
