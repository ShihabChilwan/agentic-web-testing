import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeLLMClient } from '../../src/llm/fake.js';
import type { ChatRequest, ChatResponse } from '../../src/llm/types.js';
import type { DryRunResult } from '../../src/modules/script-generator/dry-run.js';
import { generateScripts } from '../../src/modules/script-generator/index.js';
import { MAX_REVIEWS, needsReview, receivedValue, reviewProblems, reviseTestCase } from '../../src/modules/script-generator/review.js';
import type { SubmitReview } from '../../src/modules/script-generator/review.js';
import { linesAtCommit } from '../../src/modules/test-case-generator/context.js';
import { parseLLMConfig } from '../../src/shared/config.js';
import { PROJECT_ROOT } from '../../src/shared/paths.js';
import { createRun, llmSettings, readRunManifest } from '../../src/shared/run-manifest.js';
import { ScriptManifest, TestCases } from '../../src/shared/schemas.js';
import type { ScriptManifestEntry, ScriptReview, TestCase } from '../../src/shared/schemas.js';
import { example } from '../shared/schemas/helpers.js';

// A fake app's code, so citations can be checked against a real commit.
const ITEMS_JS = [
  "router.post('/add', async (req, res) => {", // 1
  "  res.status(200).json({ success: true, message: 'Added to your list!' });", // 2
  '});', // 3
].join('\n');

let root: string;
let repo: string;
let commit: string;

beforeAll(async () => {
  await mkdir(path.join(PROJECT_ROOT, 'runs'), { recursive: true });
  root = await mkdtemp(path.join(PROJECT_ROOT, 'runs', '.review-test-'));
  repo = path.join(root, 'targets', 'fake', 'repo');
  await mkdir(path.join(repo, 'server'), { recursive: true });
  await writeFile(path.join(repo, 'server', 'items.js'), ITEMS_JS);
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@x.test', ...a], { encoding: 'utf8' });
  git('init', '--quiet');
  git('add', '.');
  git('commit', '--quiet', '-m', 'golden');
  commit = git('rev-parse', 'HEAD').trim();
  const config = structuredClone(example('target.config.json'));
  config.name = 'fake';
  config.repoPath = 'targets/fake/repo';
  delete config.facts;
  await writeFile(path.join(root, 'targets', 'fake', 'target.config.json'), JSON.stringify(config));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const tc = (id: string, expected: TestCase['expected']): TestCase => ({
  id, requirementIds: ['REQ-001'], title: `case ${id}`, layer: 'api', category: 'functional', priority: 'high',
  preconditions: [], fixturesUsed: [], steps: ['Send POST /api/items/add'], expected,
});

describe('review checks (code, no model)', () => {
  const t = tc('TC-001', [{ id: 'E1', description: 'Status 200', value: 200 }, { id: 'E2', description: 'The message says updated', value: 'Updated!' }]);
  const check = (sub: SubmitReview, received: string | number | boolean | null = 'Added to your list!', expectationId = 'E2') =>
    reviewProblems(sub, { tc: t, expectationId, received, read: linesAtCommit({ root: repo, forbiddenPaths: [] }, commit), scope: { root: repo, forbiddenPaths: [] } });
  const blame = (value: string | number, lines: [number, number] = [2, 2], file = 'server/items.js'): SubmitReview => ({
    verdict: 'test_case_wrong', explanation: 'The handler answers with this message on purpose.', citation: { file, lines }, change: { kind: 'value', value },
  });

  it('reads what Playwright printed as a value', () => {
    expect(receivedValue('"Added to your list!"')).toBe('Added to your list!');
    expect(receivedValue('24')).toBe(24);
    expect(receivedValue('true')).toBe(true);
    expect(receivedValue('Array [ … ]')).toBeNull();
    expect(receivedValue(null)).toBeNull();
  });

  it('accepts a text value the correct version gave that appears in the cited lines', async () => {
    expect(await check(blame('Added to your list!'))).toEqual([]);
    expect(await check(blame('Added to your list'), 'The page: Added to your list! Close')).toEqual([]); // a part of a larger received text
  });

  it('rejects a citation that cannot be read, a text not in the cited lines, and a value the version did not give', async () => {
    expect(await check(blame('Added to your list!', [1, 1]))).toEqual([
      'change.value: "Added to your list!" does not appear in the cited lines server/items.js:1-1; cite the code that contains this text',
    ]);
    expect((await check(blame('Added to your list!', [2, 9])))[0]).toMatch(/^citation: lines 2-9 go past the end of server\/items.js \(3 lines\)/);
    expect((await check(blame('Added to your list!', [2, 2], 'server/nothing.js')))[0]).toMatch(/^citation: server\/nothing.js cannot be read/);
    expect((await check(blame('Saved!')))[0]).toMatch(/^change.value: "Saved!" is not what the correct version showed/);
    expect((await check({ verdict: 'test_case_wrong', explanation: 'x' }))).toEqual([
      'citation: test_case_wrong needs the application code (file and lines) that produces the received value on purpose',
      'change: test_case_wrong needs the change to E2: kind "value" with the new value, or kind "remove"',
    ]);
  });

  it('a number must be exactly the received one; a value needs a single received value; removal keeps one expectation', async () => {
    expect(await check(blame(24), 24, 'E1')).toEqual([]);
    expect((await check(blame(25), 24, 'E1'))[0]).toMatch(/^change.value: the correct version gave 24; a number must be exactly that/);
    expect((await check(blame('Added to your list!'), null))[0]).toMatch(/is not a single value/);
    const remove: SubmitReview = { verdict: 'test_case_wrong', explanation: 'The field defaults to 1, so its error never shows.', citation: { file: 'server/items.js', lines: [1, 3] }, change: { kind: 'remove' } };
    expect(await check(remove)).toEqual([]);
    const single = tc('TC-002', [{ id: 'E1', description: 'd', value: 'x' }]);
    expect((await reviewProblems(remove, { tc: single, expectationId: 'E1', received: 'y', read: linesAtCommit({ root: repo, forbiddenPaths: [] }, commit), scope: { root: repo, forbiddenPaths: [] } }))[0]).toMatch(/is the only expectation/);
  });

  it('keep needs nothing; script_wrong needs an explanation the script writer can use', async () => {
    expect(await check({ verdict: 'keep', explanation: 'unclear' })).toEqual([]);
    expect((await check({ verdict: 'script_wrong', explanation: 'wrong' }))[0]).toMatch(/^explanation: for script_wrong/);
  });

  it('revises only the failing expectation and records the revision', () => {
    const now = new Date('2026-10-28T12:00:00Z');
    const revised = reviseTestCase(t, { ...blame('Added to your list!'), change: { kind: 'value', value: 'Added to your list!', description: 'The message says added' } }, 'E2', now);
    expect(revised.expected).toEqual([t.expected[0], { id: 'E2', description: 'The message says added', value: 'Added to your list!' }]);
    expect(revised.revision).toEqual({
      expectationId: 'E2', change: 'value', from: { description: 'The message says updated', value: 'Updated!' }, to: { description: 'The message says added', value: 'Added to your list!' },
      citation: { file: 'server/items.js', lines: [2, 2] }, explanation: 'The handler answers with this message on purpose.', revisedAt: now.toISOString(),
    });
    const removed = reviseTestCase(t, { verdict: 'test_case_wrong', explanation: 'e', citation: { file: 'server/items.js', lines: [1, 3] }, change: { kind: 'remove' } }, 'E2', now);
    expect(removed.expected.map((e) => e.id)).toEqual(['E1']);
    expect(removed.revision).toMatchObject({ change: 'remove', to: null });
    TestCases.shape.testCases.element.parse(removed);
  });
});

describe('another review when a script fails on another expectation', () => {
  const failing = (id: string, extra: Partial<ScriptManifestEntry> = {}): ScriptManifestEntry => ({
    testCaseId: 'TC-001', file: 'scripts/TC-001.spec.ts', status: 'validated', validationOutcome: 'assertion_failed', attempts: 1, failureCategory: null,
    attemptLog: [{ attempt: 1, stage: 'dry-run', error: `Error: ${id}\n\nExpected: 1\nReceived: 2`, durationMs: 1 }], ...extra,
  });
  const review = (verdict: ScriptReview['verdict'], expectationId?: string): ScriptReview => ({ verdict, explanation: 'x', reviewedAt: '2026-10-28T12:00:00.000Z', ...(expectationId ? { expectationId } : {}) });
  const t = tc('TC-001', [{ id: 'E1', description: 'a', value: 1 }, { id: 'E2', description: 'b', value: 1 }]);

  it('reviews a script with no review, again only on an expectation not yet reviewed, and at most MAX_REVIEWS times', () => {
    expect(needsReview(failing('E1'), t)).toBe(true);
    expect(needsReview(failing('E1', { review: review('test_case_wrong', 'E1') }), t)).toBe(false);
    expect(needsReview(failing('E2', { review: review('test_case_wrong', 'E1') }), t)).toBe(true);
    expect(needsReview(failing('E2', { review: review('keep', 'E2'), earlierReviews: [review('test_case_wrong', 'E1')] }), t)).toBe(false);
    const full = { review: review('keep', 'E2'), earlierReviews: [review('script_wrong', 'E3'), review('test_case_wrong', 'E4')] };
    expect(MAX_REVIEWS).toBe(3);
    expect(needsReview(failing('E1', full), t)).toBe(false);
    expect(needsReview({ ...failing('E1'), validationOutcome: 'passed' }, t)).toBe(false);
  });

  it('an older review without its expectation counts by the case\'s revision, or as having seen the current failure', () => {
    const revised = { ...t, revision: { expectationId: 'E1', change: 'remove' as const, from: { description: 'a', value: 1 }, to: null, citation: { file: 'server/items.js', lines: [1, 3] as [number, number] }, explanation: 'x', revisedAt: '2026-10-28T12:00:00.000Z' } };
    expect(needsReview(failing('E2', { review: review('test_case_wrong') }), revised)).toBe(true);
    expect(needsReview(failing('E2', { review: review('failed') }), t)).toBe(false);
  });
});

describe('reviews in the scripts stage (fake model and dry runs)', () => {
  it('revises a blamed test case and writes its script again, rewrites a blamed script with the reason, and keeps the rest', { timeout: 180_000 }, async () => {
    const runsDir = await mkdtemp(path.join(root, 'runs-'));
    const { runId, paths } = await createRun({ target: 'fake', generationRef: 'golden', generationCommit: commit, llm: llmSettings(parseLLMConfig({ LLM_BASE_URL: 'http://m/v1' })), runsDir });
    const prd = structuredClone(example('prd.json'));
    prd.target = 'fake';
    prd.requirements = [{ ...prd.requirements[0], id: 'REQ-001' }];
    await writeFile(paths.prd, JSON.stringify(prd));
    const cases = [
      tc('TC-001', [{ id: 'E1', description: 'The message says updated', value: 'Updated!' }]),
      tc('TC-002', [{ id: 'E1', description: 'The response holds the item count', value: 3 }]),
      tc('TC-003', [{ id: 'E1', description: 'The item count', value: 5 }]),
      tc('TC-004', [{ id: 'E1', description: 'The message says updated', value: 'Updated!' }, { id: 'E2', description: 'The item count', value: 7 }]),
    ];
    await writeFile(paths.testCases, JSON.stringify({ schemaVersion: '1.0', generatedAt: '2026-10-28T10:00:00Z', testCases: cases, coverage: { requirementsTotal: 1, requirementsCovered: 1, uncovered: [] } }));

    const body = (subject: string) => `const res = await api.post('/api/items/add');\nconst b = await bodyOf(res);\nexpect(${subject}, 'E1').toBe(EXPECTED.E1.value);`;
    const reviewTasks: Record<string, string> = {};
    const scriptTasks: Record<string, string[]> = {};
    const reviews: Record<string, ChatResponse[]> = {
      'TC-001': [
        // First: a text the cited line does not hold (rejected), then the received message with the right citation.
        FakeLLMClient.toolCall('submit_review', { verdict: 'test_case_wrong', explanation: 'The handler sends this message on purpose.', citation: { file: 'server/items.js', lines: [1, 1] }, change: { kind: 'value', value: 'Added to your list!' } }),
        FakeLLMClient.toolCall('submit_review', { verdict: 'test_case_wrong', explanation: 'The handler sends this message on purpose.', citation: { file: 'server/items.js', lines: [2, 2] }, change: { kind: 'value', value: 'Added to your list!' } }),
      ],
      'TC-002': [FakeLLMClient.toolCall('submit_review', { verdict: 'script_wrong', explanation: 'The script compared the length of the message; the count is in b.count.' })],
      'TC-003': [FakeLLMClient.toolCall('submit_review', { verdict: 'keep', explanation: 'The handler may be wrong.' })],
      // Revised on E1, then failing on E2: a second review, which keeps it.
      'TC-004': [
        FakeLLMClient.toolCall('submit_review', { verdict: 'test_case_wrong', explanation: 'The handler sends this message on purpose.', citation: { file: 'server/items.js', lines: [2, 2] }, change: { kind: 'value', value: 'Added to your list!' } }),
        FakeLLMClient.toolCall('submit_review', { verdict: 'keep', explanation: 'The count may be wrong.' }),
      ],
    };
    const respond = (req: ChatRequest): ChatResponse => {
      const first = req.messages[0];
      const task = first?.role === 'user' && first.content[0]?.type === 'text' ? first.content[0].text : '';
      const reviewed = /^Review (TC-\d+)/.exec(task)?.[1];
      if (reviewed) {
        reviewTasks[reviewed] = task;
        return reviews[reviewed]!.shift()!;
      }
      const id = /test for (TC-\d+)/.exec(task)![1]!;
      (scriptTasks[id] ??= []).push(task);
      if (id === 'TC-004') return FakeLLMClient.toolCall('submit_script', { body: `${body('b.message')}\nexpect(b.count, 'E2').toBe(EXPECTED.E2.value);` });
      // TC-002 after its review: the count.
      return FakeLLMClient.toolCall('submit_script', { body: body(id === 'TC-002' && task.includes('A reviewer looked') ? 'b.count' : 'b.message.length') });
    };
    // The correct version: message "Added to your list!", count 3, and "b.message.length" never matches.
    const runDryRun = async (_r: string, file: string): Promise<DryRunResult> => {
      const text = await readFile(file, 'utf8');
      const fails = (expected: string, received: string): DryRunResult => ({ status: 'failed', message: `Error: E1\n\nexpect(received).toBe(expected) // Object.is equality\n\nExpected: ${expected}\nReceived: ${received}`, durationMs: 1 });
      if (text.includes('TC-001: ')) return text.includes("value: 'Added to your list!'") ? { status: 'passed', message: '', durationMs: 1 } : fails('"Updated!"', '"Added to your list!"');
      if (text.includes('TC-002: ')) return text.includes('b.count') ? { status: 'passed', message: '', durationMs: 1 } : fails('3', '19');
      if (text.includes('TC-004: ')) {
        return text.includes("value: 'Added to your list!'")
          ? { status: 'failed', message: 'Error: E2\n\nexpect(received).toBe(expected) // Object.is equality\n\nExpected: 7\nReceived: 3', durationMs: 1 }
          : fails('"Updated!"', '"Added to your list!"');
      }
      return fails('5', '3');
    };
    const result = await generateScripts({
      runId, runsDir, targetsDir: path.join(root, 'targets'), projectRoot: root, llmConfig: parseLLMConfig({ LLM_BASE_URL: 'http://m/v1' }),
      createLlm: async () => new FakeLLMClient(Array.from({ length: 40 }, () => respond)),
      startApp: async () => ({ stop: async () => {}, restore: async () => ({ durationMs: 1 }) }),
      runDryRun,
    });

    const byId = Object.fromEntries(result.manifest.scripts.map((s) => [s.testCaseId, s]));
    // TC-001: the expectation was revised from the received message, with the citation; its new script passes.
    expect(byId['TC-001']).toMatchObject({ validationOutcome: 'passed', review: { verdict: 'test_case_wrong', citation: { file: 'server/items.js', lines: [2, 2] } } });
    const written = TestCases.parse(JSON.parse(await readFile(paths.testCases, 'utf8')));
    const revised = written.testCases.find((c) => c.id === 'TC-001')!;
    expect(revised.expected[0]).toEqual({ id: 'E1', description: 'The message says updated', value: 'Added to your list!' });
    expect(revised.revision).toMatchObject({ expectationId: 'E1', change: 'value', from: { value: 'Updated!' }, to: { value: 'Added to your list!' } });
    expect(written.testCases.find((c) => c.id === 'TC-003')!.revision).toBeUndefined();
    // TC-002: the expectation stays; the script was written again with the reviewer's finding, and passes.
    expect(byId['TC-002']).toMatchObject({ validationOutcome: 'passed', review: { verdict: 'script_wrong' } });
    expect(written.testCases.find((c) => c.id === 'TC-002')!.expected[0]!.value).toBe(3);
    expect(scriptTasks['TC-002']!.at(-1)).toContain('The script compared the length of the message; the count is in b.count.');
    // TC-003: kept as a suspected defect, with the review's reason.
    expect(byId['TC-003']).toMatchObject({ validationOutcome: 'assertion_failed', review: { verdict: 'keep' } });
    expect(result.suspectedDefects.map((d) => [d.testCaseId, d.review?.verdict])).toEqual([['TC-003', 'keep'], ['TC-004', 'keep']]);
    // TC-004: revised on E1, then a second review on E2; both are kept, and the revision too.
    expect(byId['TC-004']?.review).toMatchObject({ verdict: 'keep', expectationId: 'E2' });
    expect(byId['TC-004']?.earlierReviews).toEqual([expect.objectContaining({ verdict: 'test_case_wrong', expectationId: 'E1' })]);
    // The review saw the failure and the script.
    expect(reviewTasks['TC-002']).toContain('the correct version gave 19');
    expect(reviewTasks['TC-002']).toContain("expect(b.message.length, 'E1')");

    expect(result.summary.reviewed).toEqual({ cases: 4, keep: 2, testCaseWrong: 1, scriptWrong: 1, failed: 0, passedAfter: 2 });
    ScriptManifest.parse(JSON.parse(await readFile(paths.scriptsManifest, 'utf8')));
    expect((await readRunManifest(paths.runJson)).stages.scripts?.scripts?.reviewed).toEqual(result.summary.reviewed);

    // A resumed stage reviews nothing again.
    let calls = 0;
    await generateScripts({
      runId, runsDir, targetsDir: path.join(root, 'targets'), projectRoot: root, llmConfig: parseLLMConfig({ LLM_BASE_URL: 'http://m/v1' }),
      createLlm: async () => new FakeLLMClient(Array.from({ length: 5 }, () => () => (calls++, respond({ messages: [] } as unknown as ChatRequest)))),
      startApp: async () => ({ stop: async () => {}, restore: async () => ({ durationMs: 1 }) }),
      runDryRun,
      redo: [],
    });
    expect(calls).toBe(0);
  });
});
