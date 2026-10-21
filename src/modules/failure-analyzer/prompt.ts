import type { TestCase, TestResult } from '../../shared/schemas.js';
import type { EnvironmentSummary, FailureGroup } from './triage.js';

const MAX_TASK_ERROR_CHARS = 1_500;

const CLASSIFICATIONS = `- app_defect: the application's behaviour contradicts a requirement. Give the location in the application source (file and lines) where the faulty code is.
- environment_issue: configuration or infrastructure: a service that is down or crashed, an unreachable database, a missing setting, missing seed data. Many unrelated tests failing for one shared reason often point here.
- test_defect: the test itself is wrong: a wrong expectation for what the requirement says, a locator that targets the wrong element, bad test data.
- inconclusive: the evidence does not support any of the above. Use it rather than guessing.`;

/** The system prompt for a full session. The same for every target app: nothing app-specific belongs here. */
export function buildSystemPrompt(): string {
  return `You are a senior engineer diagnosing failed automated tests of a web application (frontend and backend). You get a group of failing tests that share the same error. Find out why they fail and submit one or more diagnoses with submit_diagnoses.

## How to investigate
- Look at the failure first (get_failure): the test case, the script and the full error.
- Then gather evidence from more than one source before concluding: the artifacts of the failing test (read_artifact: network, console, dom, lastResponse, serverLog), the server logs (read_server_log), the environment (get_environment) and the application source (list_files, read_file, search_code).
- Trace the behaviour to the code that produces it: find the route, handler or component involved and read it. Do not guess file paths: confirm a file and its lines with read_file before naming them.
- Compare what the test expects with what the requirement says (get_requirement), to tell a wrong application from a wrong test.
- Check get_environment when several tests fail in the same way or a service may have been down.

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
    return `- ${id}: ${input.testCases.get(id)?.title ?? '(no title)'} [${r.status}${r.error?.expectationId ? ` at ${r.error.expectationId}` : ''}${r.isolated ? '' : ', ran without a data restore'}]`;
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
    '',
    'Investigate, then call submit_diagnoses.',
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
