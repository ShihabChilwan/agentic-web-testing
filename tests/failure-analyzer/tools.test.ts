import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepoTools } from '../../src/agent/tools/repo-tools.js';
import type { AgentTool } from '../../src/agent/types.js';
import { buildSourceTree, type SourceTree } from '../../src/modules/execution-engine/source-tree.js';
import { createAnalyzerTools, type AnalysisContext } from '../../src/modules/failure-analyzer/tools.js';
import { triage } from '../../src/modules/failure-analyzer/triage.js';
import { ExecutionResults, Prd, TestCases } from '../../src/shared/schemas.js';
import { makeFixture, PATCH_NAME } from './fixture.js';

// Leak protection (SPEC §8.4): the tools refuse everything outside this execution and the source tree,
// and nothing they return names the ref, the commit, the patch or another execution.

let f: Awaited<ReturnType<typeof makeFixture>>;
let tree: SourceTree;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tools: Map<string, AgentTool<any>>;

beforeAll(async () => {
  f = await makeFixture();
  tree = await buildSourceTree({ repoDir: f.repo, commit: f.commit, patchFile: path.join(f.root, 'targets', 'fake', 'dev-bugs', PATCH_NAME) });
  const results = ExecutionResults.parse(JSON.parse(await readFile(f.paths.results(f.execId), 'utf8')));
  const ctx: AnalysisContext = {
    execDir: f.execDir,
    scriptsDir: f.paths.scriptsDir,
    results,
    environment: triage(results).environment,
    testCases: new Map(TestCases.parse(JSON.parse(await readFile(f.paths.testCases, 'utf8'))).testCases.map((tc) => [tc.id, tc])),
    prd: Prd.parse(JSON.parse(await readFile(f.paths.prd, 'utf8'))),
  };
  tools = new Map([...createAnalyzerTools(ctx), ...createRepoTools({ root: tree.dir, forbiddenPaths: [] })].map((t) => [t.name, t]));
});

afterAll(async () => {
  await tree.remove();
  await rm(f.root, { recursive: true, force: true });
});

/** Runs a tool like the agent runtime does: input through the tool's schema, a thrown error becomes text. */
async function call(name: string, input: unknown): Promise<string> {
  const tool = tools.get(name)!;
  const parsed = tool.input.safeParse(input);
  if (!parsed.success) return `Error: invalid input: ${parsed.error.message}`;
  try {
    return await tool.run(parsed.data);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const FORBIDDEN = () => ['golden', f.commit, f.commit.slice(0, 7), PATCH_NAME, 'dev-001', 'dev-bugs', 'x-03', 'bug-001', 'awt-src-'];

describe('analyzer tools', () => {
  it('give the failure evidence of this execution', async () => {
    expect(await call('list_failures', {})).toBe(
      [
        'TC-001 [failed E1, assertion_failed] Error: E1',
        'TC-002 [failed E1, assertion_failed] Error: E1',
        'TC-003 [errored, runtime-error] Error: page.goto: net::ERR_CONNECTION_REFUSED at /profile',
      ].join('\n'),
    );
    const failure = await call('get_failure', { testCaseId: 'TC-001' });
    expect(failure).toContain('Expected: 400\nReceived: 200');
    expect(failure).toContain("test('TC-001'");
    expect(failure).toContain('Artifacts: network, lastResponse, serverLog');
    expect(await call('read_artifact', { testCaseId: 'TC-001', kind: 'serverLog' })).toBe('POST /api/auth/login 200\n');
    expect(await call('read_server_log', { name: 'backend', search: 'login' })).toBe('2: POST /api/auth/login 200\n3: POST /api/auth/login 200');
    expect(JSON.parse(await call('get_requirement', { id: 'REQ-002' }))).toMatchObject({ id: 'REQ-002', feature: { id: expect.any(String) } });
    // The repo tools read the patched version.
    expect(await call('read_file', { path: 'server/routes/auth.js', startLine: 6, endLine: 6 })).toContain('if (isMatch === null) {');
  });

  it('refuse other executions, run files, eval, ablation, targets and git metadata', async () => {
    const attempts: Array<[string, unknown]> = [
      ['get_failure', { testCaseId: 'TC-004' }], // passed: not a failure of this execution
      ['get_failure', { testCaseId: '../x-03' }],
      ['read_artifact', { testCaseId: 'TC-003', kind: 'network' }], // it has no network artifact
      ['read_artifact', { testCaseId: 'TC-001', kind: 'trace' }],
      ['read_artifact', { testCaseId: 'TC-001', kind: '../../../run.json' }],
      ['read_artifact', { testCaseId: '../../x-03/artifacts/TC-001', kind: 'network' }],
      ['read_server_log', { name: 'setup' }],
      ['read_server_log', { name: '../../../run.json' }],
      ['get_requirement', { id: '../run.json' }],
      ['read_file', { path: '.git/config' }],
      ['read_file', { path: '../../runs/' }],
      ['read_file', { path: '/etc/passwd' }],
      ['read_file', { path: path.join(f.paths.dir, 'run.json') }],
      ['list_files', { path: '..' }],
      ['search_code', { pattern: 'golden', glob: '../**' }],
    ];
    for (const [name, input] of attempts) {
      const out = await call(name, input);
      expect(out, `${name} ${JSON.stringify(input)}`).toMatch(/^Error/);
      for (const word of FORBIDDEN()) expect(out, `${name} ${JSON.stringify(input)}`).not.toContain(word);
    }
  });

  it('the tree has no .git, and no tool output names the ref, commit, patch, other executions or the tree folder', async () => {
    expect(await call('list_files', { path: '.', depth: 3 })).not.toMatch(/\.git\b/);
    const outputs = [
      await call('list_failures', {}),
      ...(await Promise.all(['TC-001', 'TC-002', 'TC-003'].map((id) => call('get_failure', { testCaseId: id })))),
      await call('get_environment', {}),
      await call('get_requirement', { id: 'REQ-002' }), // prd.json's sourceRef is "golden": never shown
      await call('read_server_log', { name: 'backend' }),
      await call('read_server_log', { name: 'frontend', search: '.' }),
      await call('read_artifact', { testCaseId: 'TC-001', kind: 'network' }),
      await call('read_artifact', { testCaseId: 'TC-001', kind: 'lastResponse' }),
      await call('read_artifact', { testCaseId: 'TC-003', kind: 'console' }),
      await call('list_files', { path: '.', depth: 3 }),
      await call('search_code', { pattern: '.' }),
    ];
    for (const out of outputs) for (const word of FORBIDDEN()) expect(out).not.toContain(word);
  });
});
