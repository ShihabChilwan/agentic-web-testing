import { describe, expect, it } from 'vitest';
import { scenarioCase } from '../../src/modules/scenario-generator/cases.js';
import { appearsIn, checkProposed, rolePoints, roleUsers, selectPoints } from '../../src/modules/scenario-generator/points.js';
import { sameRequest, unstableScenarios, type CheckRun } from '../../src/modules/scenario-generator/stability.js';
import { asRanges, scriptCalls, suiteUsage, unrunLines, VISITOR, CREATED_USER } from '../../src/modules/scenario-generator/usage.js';
import { FIXTURES, PRD } from './fixture.js';
import type { ExecutionResults, RecordedResponse, VariationPoint } from '../../src/shared/schemas.js';

const SCRIPT = `const { headers } = await loginViaApi(fixtures.users.alice);
const res = await api.get('/api/items?sort=asc', { headers });
await api.post(\`/api/items\`, { data: { name: uniq('x') }, headers });
await api.delete(\`/api/items/\${id}\`, { headers });
await api.get('/api/health');
const other = await loginViaApi({ email, password });
await loggedInPage(page, fixtures.users.admin);
await page.goto('/items');`;

describe('what the suite already does', () => {
  it('reads requests and logins from a script: headers mean the api login, none means a visitor', () => {
    const calls = scriptCalls(SCRIPT, FIXTURES);
    expect(calls.map((c) => [c.kind, c.method, c.path, c.roles.sort()])).toEqual([
      ['api', 'GET', '/api/items?sort=asc', [CREATED_USER, 'member']],
      ['api', 'POST', '/api/items', [CREATED_USER, 'member']],
      ['api', 'DELETE', '/api/items/:x', [CREATED_USER, 'member']],
      ['api', 'GET', '/api/health', [VISITOR]],
      ['page', 'GET', '/items', ['admin']],
    ]);
  });

  it('maps them to PRD endpoints and pages, and adds recorded query values and statuses', () => {
    const recorded: RecordedResponse[] = [
      { testCaseId: 'TC-001', seq: 1, source: 'api', method: 'GET', path: '/api/items?sort=desc&page=2', status: 200, contentType: 'application/json', bodyKind: 'json', body: [] },
      { testCaseId: 'TC-001', seq: 2, source: 'page', method: 'GET', path: '/api/items', status: 200, contentType: 'application/json', bodyKind: 'json', body: [] },
    ];
    const usage = suiteUsage({ prd: PRD, config: { fixtures: FIXTURES }, scripts: new Map([['TC-001', SCRIPT]]), recordings: [recorded] });
    const items = usage.endpoints.get('GET /api/items')!;
    expect([...items.roles].sort()).toEqual(['admin', CREATED_USER, 'member']);
    expect([...items.query.get('sort')!].sort()).toEqual(['asc', 'desc']);
    expect([...items.query.get('page')!]).toEqual(['2']);
    expect([...items.statuses]).toEqual([200]);
    expect([...usage.endpoints.get('DELETE /api/items/:id')!.roles].sort()).toEqual([CREATED_USER, 'member']);
    expect([...usage.pages.get('/items')!]).toEqual(['admin']);
  });

  it('finds code lines in a range that did not run, only in files the measurement saw', async () => {
    const read = async (f: string) => (f === 'a.js' ? ['function a() {', '  if (x) {', '    return 1;', '  }', '  // note', '  return 2;', '}'] : null);
    const coverage = { schemaVersion: '1.0' as const, kind: 'node-v8' as const, generationCommit: 'abc1234', measuredAt: '2026-11-16T10:00:00Z', scripts: { run: 1, passed: 1 }, processes: 1, files: { 'a.js': { lines: [1, 2, 6] } }, endpoints: [] };
    expect(await unrunLines('a.js', [1, 7], coverage, read)).toEqual([3]);
    expect(await unrunLines('b.js', [1, 7], coverage, read)).toEqual([]);
    expect(await unrunLines('a.js', [1, 7], null, read)).toEqual([]);
    expect(asRanges([9, 3, 4, 5, 12, 13])).toBe('3-5, 9, 12-13');
  });
});

describe('variation points', () => {
  const usage = suiteUsage({ prd: PRD, config: { fixtures: FIXTURES }, scripts: new Map([['TC-001', SCRIPT]]), recordings: [] });

  it('one user per role, the first by name, and the visitor', () => {
    expect(roleUsers(FIXTURES)).toEqual([{ role: 'admin', user: 'users.admin' }, { role: 'member', user: 'users.alice' }, { role: VISITOR, user: VISITOR }]);
  });

  it('makes role points for login-required endpoints and pages, for roles the suite never used', () => {
    const points = rolePoints(PRD, usage, FIXTURES, '/api');
    const keys = points.map((p) => `${p.endpoint ?? p.page} ${p.role}`).sort();
    expect(keys).toEqual([
      '/items member', '/items visitor',
      'DELETE /api/items/:id admin', 'DELETE /api/items/:id visitor',
      'GET /api/admin/report admin', 'GET /api/admin/report member', 'GET /api/admin/report visitor',
      'GET /api/items admin', 'GET /api/items visitor',
      'POST /api/items admin', 'POST /api/items visitor',
    ]);
    const del = points.find((p) => p.endpoint === 'DELETE /api/items/:id' && p.role === 'admin')!;
    expect(del).toMatchObject({ origin: 'code', kind: 'role', user: 'users.admin', requirementId: 'REQ-002', featureId: 'F-01', citation: { file: 'server/items.js', lines: [22, 26] } });
    expect(del.setup[0]).toMatch(/parameters/);
    expect(points.find((p) => p.endpoint === 'GET /api/admin/report' && p.role === VISITOR)!.action).toBe('Send GET /api/admin/report as a visitor who is not logged in.');
  });

  it('checks proposed points against the code, the PRD, the fixtures and the suite', async () => {
    const code = ['router.get("/", (req, res) => {', '  const sort = req.query.sort;', "  if (sort === 'newest') return byDate();", "  if (sort === 'asc') return byName();", '});'];
    const ctx = { prd: PRD, featureRequirements: PRD.requirements.filter((r) => r.featureId === 'F-01'), fixtures: FIXTURES, usage, read: async (f: string) => (f === 'server/items.js' ? code : null) };
    const base = { layer: 'api' as const, endpoint: 'GET /api/items', description: 'Sort by the newest item first.', setup: [], action: 'Send GET /api/items?sort=newest', user: 'users.alice', citation: { file: 'server/items.js', lines: [1, 5] as [number, number] } };
    const good = await checkProposed([{ ...base, kind: 'unused-option', values: ['newest'] }], 'F-01', ctx);
    expect(good.problems).toEqual([]);
    expect(good.drafts[0]).toMatchObject({ role: 'member', origin: 'model', requirementId: 'REQ-001', featureId: 'F-01' });

    const bad = await checkProposed(
      [
        { ...base, kind: 'unused-option', values: ['oldest'] },
        { ...base, kind: 'unused-option', values: ['asc'] },
        { ...base, kind: 'list', values: [], records: 2 },
        { ...base, kind: 'boundary', values: [], user: 'users.nobody' },
        { ...base, kind: 'boundary', values: [], endpoint: 'GET /api/nowhere' },
        { ...base, kind: 'boundary', values: [], citation: { file: 'server/missing.js', lines: [1, 2] } },
        { ...base, kind: 'state-after-action', values: [] },
        { ...base, kind: 'boundary', values: [], layer: 'ui', page: '/nowhere', endpoint: undefined },
      ],
      'F-01',
      ctx,
    );
    expect(bad.problems).toEqual([
      expect.stringMatching(/^points\[0\]: the value "oldest" does not appear in the cited lines/),
      expect.stringMatching(/^points\[1\]: the suite already sends "asc" to GET \/api\/items/),
      expect.stringMatching(/^points\[2\]: a list point creates at least 3 records/),
      expect.stringMatching(/^points\[3\]: user must be a fixture user path/),
      expect.stringMatching(/^points\[4\]: an api point names one endpoint/),
      expect.stringMatching(/^points\[5\]: citation file server\/missing.js does not exist/),
      expect.stringMatching(/^points\[6\]: a state-after-action point does the earlier action in setup/),
      expect.stringMatching(/^points\[7\]: a ui point names the page it opens/),
    ]);
    expect(appearsIn('{"price":1}', "const sort = { price: 1 };")).toBe(true);
    expect(appearsIn('{"price":-1}', "const sort = { name: -1 };")).toBe(false);
    expect(appearsIn('---', 'anything')).toBe(false);
    const twice = await checkProposed([{ ...base, kind: 'boundary', values: [] }, { ...base, kind: 'boundary', values: [] }], 'F-01', ctx);
    expect(twice.problems).toEqual([expect.stringMatching(/points\[1\]: the same scenario/)]);
  });
});

const point = (id: string, featureId: string, kind: VariationPoint['kind'], target: string, extra: Partial<VariationPoint> = {}): VariationPoint => ({
  id, featureId, kind, layer: 'api', endpoint: target, description: `point ${id} about something`, values: [], setup: [], action: `Send ${target}`,
  user: 'users.alice', role: 'member', citation: { file: 'a.js', lines: [1, 2] }, origin: kind === 'role' ? 'code' : 'model', requirementId: 'REQ-001', unrunLines: false, ...extra,
});

describe('choosing the scenarios', () => {
  it('shares the cap across features and kinds, prefers code no test ran, caps each endpoint, and keeps a reserve', () => {
    const points = [
      point('VP-001', 'F-01', 'role', 'GET /a'),
      point('VP-002', 'F-01', 'role', 'GET /a', { user: 'visitor', role: 'visitor' }),
      point('VP-003', 'F-01', 'role', 'GET /a', { user: 'users.admin', role: 'admin' }),
      point('VP-004', 'F-01', 'list', 'GET /b'),
      point('VP-005', 'F-01', 'list', 'GET /c', { unrunLines: true }),
      point('VP-006', 'F-02', 'boundary', 'POST /d'),
      point('VP-007', 'F-02', 'role', 'POST /d', { user: 'visitor', role: 'visitor' }),
      point('VP-008', 'F-02', 'unused-option', 'GET /e', { values: ['x'] }),
      point('VP-009', 'F-02', 'unused-option', 'GET /e', { values: ['x'] }), // the same scenario as VP-008
    ];
    const first = selectPoints(points, ['F-01', 'F-02'], 4, 2);
    expect(first).toEqual(selectPoints(points, ['F-01', 'F-02'], 4, 2));
    // Round 0: F-01 starts with role, F-02 with list (none) → unused-option. Round 1: F-01 list (VP-005 first: unrun lines), F-02 state-after-action (none) → boundary.
    expect(first.selected).toEqual(['VP-001', 'VP-008', 'VP-005', 'VP-006']);
    // GET /a had two already: VP-003 is skipped for it.
    expect(first.reserve).toEqual(['VP-002', 'VP-007']);
    expect(selectPoints(points, ['F-01', 'F-02'], 40, 10).selected).toHaveLength(7);
  });

  it('builds a scenario case with a light check and the point in its steps', () => {
    const c = scenarioCase(point('VP-004', 'F-01', 'list', 'GET /api/items', { records: 3, setup: ['Create three items with different names'], values: ['name'] }), 'SC-001');
    expect(c).toMatchObject({ id: 'SC-001', layer: 'api', category: 'functional', fixturesUsed: ['users.alice'], scenario: { variationPointId: 'VP-004', kind: 'list' } });
    expect(c.steps).toEqual(['Create three items with different names', expect.stringMatching(/^Create at least 3 records first/), 'Send GET /api/items Use these values: "name".']);
    expect(c.expected).toEqual([{ id: 'E1', description: expect.stringMatching(/got an HTTP response, whatever its status/) }]);
  });
});

const results = (statuses: Record<string, 'passed' | 'failed'>): ExecutionResults =>
  ({ results: Object.entries(statuses).map(([testCaseId, status]) => ({ testCaseId, status })) }) as unknown as ExecutionResults;
const r = (testCaseId: string, path: string, status: number, source: 'api' | 'page' = 'api'): RecordedResponse => ({ testCaseId, seq: 1, source, method: 'GET', path, status, contentType: '', bodyKind: 'none', body: null });

describe('check runs on the correct version', () => {
  it('drops a scenario whose outcome, api responses or page call statuses differ between two runs', () => {
    const a: CheckRun = {
      results: results({ 'SC-001': 'passed', 'SC-002': 'passed', 'SC-003': 'passed', 'SC-004': 'passed', 'SC-005': 'passed' }),
      responses: [r('SC-001', '/api/items/65a1b2c3d4e5f60718293a4b', 200), r('SC-002', '/api/x', 200), r('SC-003', '/api/y', 200, 'page'), r('SC-005', '/l/AbC12x', 302)],
    };
    const b: CheckRun = {
      results: results({ 'SC-001': 'passed', 'SC-002': 'passed', 'SC-003': 'passed', 'SC-004': 'failed', 'SC-005': 'passed' }),
      responses: [r('SC-001', '/api/items/65a1b2c3d4e5f60718293a99', 200), r('SC-002', '/api/x', 500), r('SC-003', '/api/y', 404, 'page'), r('SC-005', '/l/Zz9qQw', 302)],
    };
    expect(unstableScenarios(['SC-001', 'SC-002', 'SC-003', 'SC-004', 'SC-005'], a, b).map((d) => [d.id, d.reason])).toEqual([
      ['SC-002', 'unstable-responses'],
      ['SC-003', 'unstable-responses'],
      ['SC-004', 'unstable-outcome'],
    ]);
    expect(sameRequest('GET /l/a1', 'GET /l/b2')).toBe(true);
    expect(sameRequest('GET /l/a1/x', 'GET /m/b2/x')).toBe(false);
  });
});
