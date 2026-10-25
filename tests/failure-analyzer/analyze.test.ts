import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeLLMClient } from '../../src/llm/fake.js';
import type { ChatRequest, ChatResponse } from '../../src/llm/types.js';
import { analyzeExecution, unstableTests } from '../../src/modules/failure-analyzer/analyze.js';
import { buildSystemPrompt } from '../../src/modules/failure-analyzer/prompt.js';
import { readRunManifest } from '../../src/shared/run-manifest.js';
import { Diagnoses } from '../../src/shared/schemas.js';
import { llmConfig, makeFixture, PATCH_NAME } from './fixture.js';

let f: Awaited<ReturnType<typeof makeFixture>>;

beforeEach(async () => {
  f = await makeFixture();
});

afterEach(async () => {
  await rm(f.root, { recursive: true, force: true });
});

const taskOf = (req: ChatRequest) => {
  const first = req.messages[0];
  return first?.role === 'user' && first.content[0]?.type === 'text' ? first.content[0].text : '';
};

/** Answers per session (the group's first test id in the task); sessions run in parallel. */
function fakeByGroup(script: Record<string, ChatResponse[]>) {
  const requests: ChatRequest[] = [];
  const respond = (req: ChatRequest): ChatResponse => {
    requests.push(structuredClone(req));
    const key = /- (TC-\d+)|## (TC-\d+)/.exec(taskOf(req))?.slice(1).find(Boolean) ?? '?';
    const next = script[key]?.shift();
    if (!next) throw new Error(`no scripted response for ${key}`);
    return next;
  };
  return { llm: new FakeLLMClient(Array.from({ length: 40 }, () => respond)), requests };
}

const submit = (diagnoses: unknown[]) => FakeLLMClient.toolCall('submit_diagnoses', { diagnoses });
const appDefect = {
  testCaseIds: ['TC-001', 'TC-002'],
  classification: 'app_defect',
  confidence: 0.9,
  summary: 'Login accepts a wrong password.',
  rootCause: 'isMatch is compared with null, so the check never fires.',
  location: { file: 'server/routes/auth.js', lines: [6, 8] },
  evidence: [{ source: 'code', detail: 'auth.js:6 compares isMatch with null' }],
  violatedRequirementIds: ['REQ-002'],
  suggestedFix: { description: 'Use if (!isMatch).' },
};

const run = (llm: FakeLLMClient, extra: Parameters<typeof analyzeExecution>[0] = {}) =>
  analyzeExecution({ runId: f.runId, runsDir: f.runsDir, targetsDir: `${f.root}/targets`, projectRoot: f.root, llmConfig, createLlm: async () => llm, ...extra });

describe('analyzeExecution', () => {
  it('investigates each group in its own session, reads the patched tree, and writes diagnoses.json', async () => {
    const { llm, requests } = fakeByGroup({
      'TC-001': [
        FakeLLMClient.toolCall('get_failure', { testCaseId: 'TC-001' }),
        FakeLLMClient.toolCall('read_file', { path: 'server/routes/auth.js' }),
        // First submit: wrong line range; the reason comes back and the second one is accepted.
        submit([{ ...appDefect, location: { file: 'server/routes/auth.js', lines: [6, 80] } }]),
        submit([appDefect]),
      ],
      // This session never gets an accepted submit: its test becomes inconclusive.
      'TC-003': [submit([{ ...appDefect, testCaseIds: ['TC-009'] }]), submit([{ ...appDefect, testCaseIds: ['TC-009'] }]), submit([{ ...appDefect, testCaseIds: ['TC-009'] }])],
    });
    const result = await run(llm);
    const written = Diagnoses.parse(JSON.parse(await readFile(result.file, 'utf8')));
    expect(result.file).toBe(f.paths.diagnoses('x-04'));
    expect(written.mode).toBe('full');
    expect(written.diagnoses.map((d) => [d.id, d.classification, d.testCaseIds])).toEqual([
      ['DX-001', 'app_defect', ['TC-001', 'TC-002']],
      ['DX-002', 'inconclusive', ['TC-003']],
    ]);
    expect(written.diagnoses[0]).toMatchObject({ toolCalls: 2, location: { file: 'server/routes/auth.js', lines: [6, 8] } });
    expect(written.diagnoses[1]).toMatchObject({ confidence: 0, rootCause: expect.stringMatching(/^AgentSubmitError/) });
    expect(written.summary).toMatchObject({ groups: 2, sessions: 2, failedSessions: 1, calls: 7, toolCalls: 2 });

    // The session read the patched code, and the rejected range came back with its reason.
    const session = requests.filter((r) => taskOf(r).includes('- TC-001'));
    const toolResults = session.at(-1)!.messages.flatMap((m) => (m.role === 'user' ? m.content : [])).filter((b) => b.type === 'tool_result').map((b) => b.content);
    expect(toolResults.some((t) => t.includes('if (isMatch === null) {'))).toBe(true);
    expect(toolResults.some((t) => /go past the end of server\/routes\/auth.js \(12 lines\)/.test(t))).toBe(true);
    // Nothing sent to the model names the ref, commit or patch.
    const sent = JSON.stringify(requests);
    for (const word of ['golden', f.commit, f.commit.slice(0, 7), PATCH_NAME, 'dev-bugs', 'awt-src-']) expect(sent).not.toContain(word);

    const entry = (await readRunManifest(f.paths.runJson)).executions.find((e) => e.execId === 'x-04');
    expect(entry).toMatchObject({ analyzeStatus: 'done', executeStatus: 'done' });
    expect(requests[0]?.purpose).toBe('analyzer');
    expect(requests.some((r) => r.tools?.some((t) => t.name === 'read_file'))).toBe(true);
  });

  it('--no-tools offers only the submit tool, sends only titles and errors, and leaves run.json alone', async () => {
    const { llm, requests } = fakeByGroup({
      'TC-001': [submit([appDefect])],
      'TC-003': [submit([{ ...appDefect, testCaseIds: ['TC-003'], classification: 'environment_issue', location: null }])],
    });
    const result = await run(llm, { noTools: true });
    expect(result.file).toBe(f.paths.diagnosesNoTools('x-04'));
    expect(result.diagnoses.mode).toBe('no-tools');
    expect(result.diagnoses.diagnoses.map((d) => d.classification)).toEqual(['app_defect', 'environment_issue']);
    for (const r of requests) expect(r.tools?.map((t) => t.name)).toEqual(['submit_diagnoses']);
    const task = taskOf(requests.find((r) => taskOf(r).includes('## TC-001'))!);
    expect(task).toContain('Login with a wrong password is rejected');
    expect(task).toContain('Expected: 400');
    expect(task).not.toMatch(/Environment|health/i);
    expect((await readRunManifest(f.paths.runJson)).executions[0]?.analyzeStatus).toBe('pending');
  });

  it('tells the session when a failing test was unstable on the correct version, and only then', async () => {
    const attempt = (n: number, category?: string, error: string | null = null) => ({ attempt: n, stage: 'dry-run', error, ...(category ? { category } : {}), durationMs: 1 });
    const entry = (id: string, attemptLog: unknown[], extra: Record<string, unknown> = {}) => ({
      testCaseId: id, file: `scripts/${id}.spec.ts`, status: 'validated', validationOutcome: 'passed', attempts: attemptLog.length, attemptLog, failureCategory: null, ...extra,
    });
    await mkdir(path.dirname(f.paths.scriptsManifest), { recursive: true });
    await writeFile(f.paths.scriptsManifest, JSON.stringify({
      schemaVersion: '1.0', generationRef: 'golden',
      scripts: [entry('TC-001', [attempt(1)]), entry('TC-003', [attempt(1, 'timeout', 'Test timeout of 30000ms exceeded.'), attempt(2)], { unstable: true })],
    }));
    const { llm, requests } = fakeByGroup({
      'TC-001': [submit([appDefect])],
      'TC-003': [submit([{ ...appDefect, testCaseIds: ['TC-003'], classification: 'test_defect', location: null }])],
    });
    await run(llm);
    const withTools = requests.filter((r) => r.tools?.some((t) => t.name === 'read_file'));
    const task = (id: string) => taskOf(withTools.find((r) => taskOf(r).includes(`- ${id}`))!);
    expect(task('TC-003')).toContain('(unstable: on the correct version its script timed out before it passed)');
    expect(task('TC-001')).not.toContain('unstable');
    expect(buildSystemPrompt()).toContain('A test marked "unstable"');
    expect(await unstableTests(path.join(f.root, 'nothing.json'))).toEqual(new Map());
  });

  it('an execution without failures needs no model call', async () => {
    const results = JSON.parse(await readFile(f.paths.results('x-04'), 'utf8'));
    results.results = results.results.filter((r: { status: string }) => r.status === 'passed');
    await import('node:fs/promises').then((fs) => fs.writeFile(f.paths.results('x-04'), JSON.stringify(results)));
    const llm = new FakeLLMClient([]);
    const result = await run(llm);
    expect(result.diagnoses.diagnoses).toEqual([]);
    expect(llm.requests).toHaveLength(0);
  });

  it('refuses an execution that is not done', async () => {
    await expect(run(new FakeLLMClient([]), { execId: 'x-99' })).rejects.toThrow('No execution x-99 in run.json');
  });
});
