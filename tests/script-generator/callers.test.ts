import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callerBlocks, endpointsUsed, rankHit } from '../../src/modules/script-generator/callers.js';
import { linesAtCommit, renderEndpointIndex, requestShape } from '../../src/modules/test-case-generator/context.js';
import { buildScriptTask } from '../../src/modules/script-generator/prompt.js';
import type { TestCase } from '../../src/shared/schemas.js';
import { TargetConfig } from '../../src/shared/schemas.js';
import { example } from '../shared/schemas/helpers.js';

// The frontend of a fake app, shaped like a real one: a list page that links to the page route of the same name
// comes before the action that sends the request, and the request takes its body nested in a field.
const CATEGORY_ACTIONS = [
  "import axios from 'axios';",
  'export const goToEdit = id => history.push(`/dashboard/category/edit/${id}`);',
  'export const goToAdd = () => history.push(`/dashboard/category/add`);',
  'export const toggle = (id, isActive) => async () => {',
  '  await axios.put(',
  '    `${API_URL}/category/${id}/active`,',
  '    { category: { isActive } }',
  '  );',
  '};',
  'export const updateCategory = category => async () => {',
  '  const response = await axios.put(`${API_URL}/category/${category._id}`, {',
  '    category: { name: category.name, slug: category.slug }',
  '  });',
  '  return response.data.message;',
  '};',
].join('\n');

let repo: string;
let commit: string;
const tempDirs: string[] = [];
beforeAll(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'callers-'));
  tempDirs.push(repo);
  await mkdir(path.join(repo, 'client', 'app'), { recursive: true });
  await mkdir(path.join(repo, 'server'), { recursive: true });
  await writeFile(path.join(repo, 'client', 'app', 'actions.js'), CATEGORY_ACTIONS);
  await writeFile(path.join(repo, 'server', 'category.js'), "router.put('/:id', handler);\n");
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@x.test', ...a], { encoding: 'utf8' });
  git('init', '--quiet');
  git('add', '.');
  git('commit', '--quiet', '-m', 'golden');
  commit = git('rev-parse', 'HEAD').trim();
});
afterAll(async () => {
  for (const d of tempDirs) await rm(d, { recursive: true, force: true });
});

const endpoint = (method: 'GET' | 'PUT' | 'POST', p: string, request?: Record<string, unknown>) => ({
  method, path: p, authRequired: true, summary: 'x', responses: [{ status: 200, description: 'ok' }], evidence: [{ file: 'server/category.js', lines: [1, 1] as [number, number] }],
  ...(request ? { request } : {}),
});
const endpoints = [
  endpoint('PUT', '/api/category/:id', { body: { category: 'object with slug' } }),
  endpoint('PUT', '/api/category/:id/active', { body: { category: { isActive: 'boolean' } } }),
  endpoint('GET', '/api/category'),
];
const tc = (steps: string[]): TestCase => ({
  id: 'TC-001', requirementIds: ['REQ-001'], title: 'case', layer: 'api', category: 'functional', priority: 'high',
  preconditions: [], fixturesUsed: [], steps, expected: [{ id: 'E1', description: 'd', value: 200 }],
});

describe('which frontend lines show how a request is sent', () => {
  const line = (n: number) => CATEGORY_ACTIONS.split('\n')[n - 1]!;
  const rank = (e: ReturnType<typeof endpoint>, n: number) => rankHit(e, '/api', line(n), n > 1 ? line(n - 1) : '');

  it('ranks a call of the endpoint\'s method naming its whole path above a call of another path, and links and routes lowest', () => {
    expect(rank(endpoints[0]!, 11)).toBe(2);
    expect(rank(endpoints[0]!, 6)).toBe(1); // a put, but to .../active: the whole path does not end after the id
    expect(rank(endpoints[1]!, 6)).toBe(2); // the method name sits on the previous line
    expect(rank(endpoints[0]!, 2)).toBe(0); // a link to a page route
    expect(rank(endpoints[2]!, 11)).toBe(0); // another method
  });

  it('shows the call, not the page links that name the same path first', async () => {
    const scope = { root: repo, forbiddenPaths: [] };
    const blocks = await callerBlocks(tc(['Send PUT /api/category/<categoryId> with a new slug']), {
      endpoints, apiPrefix: '/api', frontendRoots: ['client/app'], scope, commit, read: linesAtCommit(scope, commit),
    });
    expect(blocks.map((b) => b.calls)).toEqual(['PUT /api/category/:id']);
    expect(blocks[0]!.lines.join('\n')).toContain('category: { name: category.name, slug: category.slug }');
  });

  it('reads a placeholder in angle brackets as a path parameter', () => {
    expect(endpointsUsed(tc(['Send PUT /api/category/<categoryId> with a new slug']), endpoints).map((e) => e.path)).toEqual(['/api/category/:id']);
  });
});

describe('request shapes in the task', () => {
  it('writes the PRD request shape of an endpoint under its line in the endpoint index, and nothing for an endpoint without one', () => {
    expect(requestShape(endpoints[0]!)).toBe('body {"category":"object with slug"}');
    expect(requestShape(endpoints[2]!)).toBeNull();
    expect(renderEndpointIndex(endpoints).split('\n')).toEqual([
      '- PUT /api/category/:id (login required): x',
      '  sends: body {"category":"object with slug"}',
      '- PUT /api/category/:id/active (login required): x',
      '  sends: body {"category":{"isActive":"boolean"}}',
      '- GET /api/category (login required): x',
    ]);
    const long = endpoint('POST', '/api/x', { body: { field: 'y'.repeat(400) } });
    expect(requestShape(long)!.length).toBeLessThanOrEqual(220);
  });

  it('puts the shapes into the script task with the instruction to build bodies in that shape', () => {
    const config = TargetConfig.parse(example('target.config.json'));
    const task = buildScriptTask({ testCase: tc(['Send PUT /api/category/<id>']), requirements: [], evidence: { blocks: [], omitted: [] }, config, facts: null, endpoints });
    expect(task).toContain('build request bodies exactly in that shape');
    expect(task).toContain('sends: body {"category":"object with slug"}');
  });
});

describe('the environment lines of the script task', () => {
  it('say the pages are served by the backend when the target has no separate frontend', () => {
    const base = TargetConfig.parse(example('target.config.json'));
    const { frontend: _f, ...rest } = base;
    const build = (config: TargetConfig) => buildScriptTask({ testCase: tc(['Send GET /api/category']), requirements: [], evidence: { blocks: [], omitted: [] }, config, facts: null, endpoints });
    expect(build(TargetConfig.parse(rest))).toContain(`- Frontend base URL: ${base.backend.baseUrl} (the same server as the backend)`);
    expect(build(base)).toContain(`- Frontend base URL: ${base.frontend!.baseUrl}\n`);
  });
});
