import { classifyDryRun, stripAnsi } from '../script-generator/classify.js';
import type { ResultCategory, TestResult } from '../../shared/schemas.js';

/** One test's result in Playwright's JSON report (1.64.0; recorded in tests/fixtures/playwright-json-report/). */
export interface ReportedTest {
  status: string;
  duration: number;
  error?: { message?: string; stack?: string };
  errors?: Array<{ message?: string }>;
  attachments?: Array<{ name: string; path?: string; contentType?: string }>;
}

interface ReportSuite {
  specs?: Array<{ file: string; tests: Array<{ results: ReportedTest[] }> }>;
  suites?: ReportSuite[];
}

export interface PlaywrightReport {
  suites?: ReportSuite[];
  errors?: Array<{ message?: string }>;
}

/** Each spec file's (e.g. `TC-004.spec.ts`) result, plus the report's top-level errors (e.g. a file that failed to load). */
export function readReport(report: PlaywrightReport): { byFile: Map<string, ReportedTest>; errors: string[] } {
  const byFile = new Map<string, ReportedTest>();
  const walk = (suite: ReportSuite): void => {
    for (const spec of suite.specs ?? []) {
      const result = spec.tests[0]?.results[0];
      if (result) byFile.set(spec.file, result);
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  const errors = (report.errors ?? []).map((e) => stripAnsi(e.message ?? '')).filter(Boolean);
  return { byFile, errors };
}

export type SortedResult = Pick<TestResult, 'status' | 'durationMs' | 'error'>;

/**
 * Sorts one test (SPEC §7.3): `failed` when an expect with an E-id failed, whatever the matcher or reason
 * (the script passed on golden, so a failed check most likely means the app changed); `errored` for
 * anything else. `error.category` keeps the step 5 classifier's label.
 * `valueIds` are the expectations that have a locked value.
 */
export function sortResult(reported: ReportedTest | undefined, valueIds: ReadonlySet<string>, reportErrors: string[] = []): SortedResult {
  if (!reported || reported.status === 'skipped' || reported.status === 'interrupted') {
    const why = reported ? `The test was ${reported.status}` : reportErrors.join('\n') || 'The test did not run (no result in the Playwright report)';
    return { status: 'errored', durationMs: reported?.duration ?? 0, error: { message: why, expectationId: null, category: 'not-run' } };
  }
  const durationMs = Math.max(0, Math.round(reported.duration));
  if (reported.status === 'passed') return { status: 'passed', durationMs };
  const message = stripAnsi(reported.error?.message ?? reported.errors?.map((e) => e.message ?? '').join('\n') ?? '');
  const verdict = classifyDryRun({ status: reported.status, message }, valueIds);
  const expectationId = verdict.kind === 'passed' ? null : verdict.expectationId;
  const category: ResultCategory = verdict.kind === 'failed' ? (verdict.category as ResultCategory) : 'assertion_failed';
  const stack = reported.error?.stack ? stripAnsi(reported.error.stack) : undefined;
  return {
    status: expectationId !== null ? 'failed' : 'errored',
    durationMs,
    error: { message, expectationId, category, ...(stack ? { stack } : {}) },
  };
}
