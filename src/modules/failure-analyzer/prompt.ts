import type { TestCase, TestResult } from '../../shared/schemas.js';
import { formatDifferences, type DifferenceGroup, type DifferenceLine } from './differences.js';
import type { EnvironmentSummary, FailureGroup } from './triage.js';

/** Difference lines shown in a task; get_differences shows all. */
const MAX_TASK_DIFFERENCES = 10;

const MAX_TASK_ERROR_CHARS = 1_500;

const CLASSIFICATIONS = `- app_defect: the application's behaviour contradicts a requirement. Give the location in the application source (file and lines) where the faulty code is.
- environment_issue: configuration or infrastructure: a service that is down or crashed, an unreachable database, a missing setting, missing seed data. Many unrelated tests failing for one shared reason often point here.
- test_defect: the test itself is wrong: a wrong expectation for what the requirement says, a locator that targets the wrong element, bad test data.
- inconclusive: the evidence does not support any of the above. Use it rather than guessing.`;

/** The part of the system prompt about comparator differences (SPEC §8.5); only when the analysis has them. */
const DIFFERENCES_SECTION = `
## Differences from a reference run
This execution's recorded HTTP responses and page snapshots were compared with a reference run of the same tests on the same starting data. Values that always vary between runs (times, generated names, ids) are already left out; what remains is a real difference. Each shows the reference value and this run's value, and a reason:
- value: a value, status code, list item, list order or page text changed.
- shape: a value that normally varies changed its form (for example it lost a suffix it always had).
- duplicate: a list now holds a value twice that it never repeated.
- request: the request itself changed (for example other query values).
- setup: most ids changed because the test data was set up differently (for example a data snapshot failed and every test re-created its data).
A difference can come from the application, the environment or timing. A test that passed can still show an application defect: its checks did not look at the value that changed. Treat the reference values as how the application is meant to behave unless the requirements say otherwise. get_differences lists all differences of this execution; get_failure also works for the tests of a difference group (they have no artifacts).
`;

/** The system prompt for a full session. The same for every target app: nothing app-specific belongs here. */
export function buildSystemPrompt(options: { differences?: boolean } = {}): string {
  const intro = options.differences
    ? 'You get either a group of failing tests that share the same error, or a group of tests that passed but whose responses or pages differ from a reference run in the same way. Find out why and submit one or more diagnoses with submit_diagnoses.'
    : 'You get a group of failing tests that share the same error. Find out why they fail and submit one or more diagnoses with submit_diagnoses.';
  return `You are a senior engineer diagnosing failed automated tests of a web application (frontend and backend). ${intro}

## How to investigate
- Look at the failure first (get_failure): the test case, the script and the full error.
- Then gather evidence from more than one source before concluding: the artifacts of the failing test (read_artifact: network, console, dom, lastResponse, serverLog), the server logs (read_server_log), the environment (get_environment) and the application source (list_files, read_file, search_code).
- Trace the behaviour to the code that produces it: find the route, handler or component involved and read it. Do not guess file paths: confirm a file and its lines with read_file before naming them.
- Compare what the test expects with what the requirement says (get_requirement), to tell a wrong application from a wrong test.
- A test marked "unstable" passed on the correct version only after an earlier dry run of it timed out or hit a browser or network error there. When such a test fails, a defect of the test (timing, a locator, a race) is likelier than a defect of the application: look for what in the failure points to the application (a wrong response, a server error, missing data) before blaming it, and say in the evidence what you found.
- Check get_environment when several tests fail in the same way or a service may have been down.
${options.differences ? DIFFERENCES_SECTION : ''}
## Classifications
${CLASSIFICATIONS}

## Submitting
- Every test of your group must be in exactly one diagnosis. Tests with the same cause share one diagnosis; tests with different causes get separate diagnoses.
- location: the file (path relative to the repo root, as the repo tools show it) and the line range of the fault in the application source, not in the test script. Required for app_defect; null when there is no single place.
- evidence: what you observed, one item per source (network, console, dom, server_log, code, requirement, test, environment), with concrete details (status codes, messages, file and line).
- violatedRequirementIds: the requirements the behaviour contradicts, if any.
- confidence: 0 to 1, how sure you are.
- suggestedFix: a short description of the fix; optionally a unified diff. Nothing is applied.
If a submission is rejected you get the reasons; fix them and submit again.`;
}

/** The system prompt without tools (ablation, SPEC §11.6): only the failure report. */
export function buildNoToolsSystemPrompt(): string {
  return `You are a senior engineer diagnosing failed automated tests of a web application (frontend and backend). You get a group of failing tests that share the same error: their titles and error messages. You have no other information and no tools. Submit one or more diagnoses with submit_diagnoses.

## Classifications
${CLASSIFICATIONS}

## Submitting
- Every test of your group must be in exactly one diagnosis.
- location: the file (path relative to the repo root) and line range of the fault in the application source. Required for app_defect; null when there is no single place. It is checked: the file must exist and have those lines.
- evidence: what in the error messages supports the diagnosis (source "test" or the source the message comes from).
- violatedRequirementIds: requirement ids if you know them; otherwise an empty list.
- confidence: 0 to 1. suggestedFix: a short description, or null.
If a submission is rejected you get the reasons; fix them and submit again.`;
}

const errorText = (r: TestResult) => {
  const message = r.error?.message ?? '(no message)';
  return message.length > MAX_TASK_ERROR_CHARS ? `${message.slice(0, MAX_TASK_ERROR_CHARS)}\n[cut; get_failure shows all of it]` : message;
};

export interface GroupTaskInput {
  group: FailureGroup;
  failures: ReadonlyMap<string, TestResult>;
  testCases: ReadonlyMap<string, TestCase>;
  environment: EnvironmentSummary;
  /** Failing tests of the execution in other groups (they are diagnosed separately). */
  otherFailures: number;
  /** Tests that were unstable when their script was validated on the correct version, with what happened (SPEC §6.2). */
  unstable?: ReadonlyMap<string, string>;
  /** Comparator differences of the group's tests (SPEC §8.5), added as evidence. */
  differences?: ReadonlyMap<string, DifferenceLine[]>;
}

function environmentNotes(env: EnvironmentSummary): string[] {
  const notes = [
    ...env.healthChecks.filter((c) => !c.ok).map((c) => `The ${c.name} health check failed at start.`),
    ...env.seed.filter((s) => !s.ok).map((s) => `Seed request ${s.request} failed (status ${s.status ?? 'no response'}).`),
    ...(env.seedCheck && !env.seedCheck.ok ? [`The seed data check failed: ${env.seedCheck.detail}`] : []),
    ...(env.incidents.length > 0 ? [`${env.incidents.length} incident(s) during the run; see get_environment.`] : []),
  ];
  return notes.length > 0 ? notes : ['Nothing unusual at start (details: get_environment).'];
}

/** The first message of a full session: the group's tests and errors, and the environment at a glance. */
export function buildGroupTask(input: GroupTaskInput): string {
  const { group } = input;
  const first = input.failures.get(group.testCaseIds[0]!)!;
  const tests = group.testCaseIds.map((id) => {
    const r = input.failures.get(id)!;
    const unstable = input.unstable?.get(id);
    return `- ${id}: ${input.testCases.get(id)?.title ?? '(no title)'} [${r.status}${r.error?.expectationId ? ` at ${r.error.expectationId}` : ''}${r.isolated ? '' : ', ran without a data restore'}]${unstable ? ` (unstable: ${unstable})` : ''}`;
  });
  return [
    `Diagnose these ${group.testCaseIds.length} failing test(s). They share the same error:`,
    ...tests,
    '',
    `Error of ${first.testCaseId} (${first.error?.category ?? 'unknown'}):`,
    errorText(first),
    '',
    'Environment:',
    ...environmentNotes(input.environment).map((n) => `- ${n}`),
    ...(input.otherFailures > 0 ? ['', `${input.otherFailures} other failing test(s) of this execution are diagnosed separately (list_failures shows all).`] : []),
    ...differenceBlock(group.testCaseIds.flatMap((id) => input.differences?.get(id) ?? [])),
    '',
    'Investigate, then call submit_diagnoses.',
  ].join('\n');
}

function differenceBlock(lines: readonly DifferenceLine[]): string[] {
  if (lines.length === 0) return [];
  return ['', 'Differences of these tests from the reference run (reference → this run):', ...formatDifferences(lines, MAX_TASK_DIFFERENCES)];
}

export interface DifferenceTaskInput {
  group: DifferenceGroup;
  testCases: ReadonlyMap<string, TestCase>;
  environment: EnvironmentSummary;
  /** Failing tests of the execution (diagnosed separately). */
  failingTests: number;
}

/** The first message for a group of tests that passed but differ from the reference run (SPEC §8.5). */
export function buildDifferenceTask(input: DifferenceTaskInput): string {
  const { group } = input;
  const tests = group.testCaseIds.map((id) => `- ${id}: ${input.testCases.get(id)?.title ?? '(no title)'} [passed]`);
  const more = group.allTests.length - group.testCaseIds.length;
  const head =
    group.kind === 'setup'
      ? [`No test failed because of this, but the comparison with the reference run found: ${group.message}.`, 'Example tests (diagnose these):']
      : [`These ${group.allTests.length} test(s) passed, but their responses or pages differ from the reference run in the same way (${group.key}).`, `Diagnose ${more > 0 ? `these ${group.testCaseIds.length} examples` : 'them'}:`];
  return [
    ...head,
    ...tests,
    ...(more > 0 ? [`(${more} more test(s) show the same differences.)`] : []),
    ...(group.lines.length > 0 ? ['', 'Differences (reference → this run):', ...formatDifferences(group.lines, MAX_TASK_DIFFERENCES)] : []),
    '',
    'Environment:',
    ...environmentNotes(input.environment).map((n) => `- ${n}`),
    ...(input.failingTests > 0 ? ['', `${input.failingTests} failing test(s) of this execution are diagnosed separately (list_failures shows them).`] : []),
    '',
    'Find the cause in the application source, then call submit_diagnoses.',
  ].join('\n');
}

/** The first message without tools: only the failing tests' titles and error messages (SPEC §11.6). */
export function buildNoToolsTask(input: Pick<GroupTaskInput, 'group' | 'failures' | 'testCases'>): string {
  const tests = input.group.testCaseIds.map((id) => {
    const r = input.failures.get(id)!;
    return `## ${id}: ${input.testCases.get(id)?.title ?? '(no title)'}\n${errorText(r)}`;
  });
  return [`Diagnose these ${input.group.testCaseIds.length} failing test(s):`, '', ...tests, '', 'Call submit_diagnoses.'].join('\n');
}
