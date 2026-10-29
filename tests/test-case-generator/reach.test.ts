import { describe, expect, it } from 'vitest';
import { classifyUnreached, hasMeasurableCode, namedDisabledSetting, scriptSends } from '../../src/modules/test-case-generator/reach.js';
import type { Prd, TargetConfig } from '../../src/shared/schemas.js';

type Endpoint = Prd['apiEndpoints'][number];
const endpoint = (method: Endpoint['method'], path: string, lines: [number, number] = [1, 3]): Endpoint =>
  ({ method, path, authRequired: false, summary: 's', responses: [{ status: 200, description: 'ok' }], evidence: [{ file: 'server/r.js', lines }] }) as Endpoint;

describe('scriptSends: does a script send this endpoint\'s request', () => {
  const source = (text: string) => [text];
  it('matches the method and the whole path, with a parameter as any text and a template string', () => {
    expect(scriptSends(endpoint('POST', '/api/v2/links/{id}/protected'), source("await api.post(`/api/v2/links/${id}/protected`, { data })"))).toBe(true);
    expect(scriptSends(endpoint('GET', '/api/v2/links/'), source("await api.get('/api/v2/links', { headers })"))).toBe(true);
    expect(scriptSends(endpoint('GET', '/api/v2/links/'), source("await api.get('/api/v2/links?limit=5', { headers })"))).toBe(true);
    expect(scriptSends(endpoint('PATCH', '/api/x/:id'), source('await api.patch(`/api/x/${a.b}`, {})'))).toBe(true);
  });
  it('does not match another method, a longer path or a shorter one', () => {
    expect(scriptSends(endpoint('POST', '/api/v2/links'), source("await api.get('/api/v2/links')"))).toBe(false);
    expect(scriptSends(endpoint('GET', '/api/v2/links/{id}'), source("await api.get(`/api/v2/links/${id}/stats`)"))).toBe(false);
    expect(scriptSends(endpoint('GET', '/api/v2/links/{id}/stats'), source("await api.get('/api/v2/links')"))).toBe(false);
    expect(scriptSends(endpoint('GET', '/api/v2/users'), source("await api.get('/api/v2/users/admin')"))).toBe(false);
  });
  it('counts the login helpers as sending the login request, and nothing else', () => {
    const login = { method: 'POST', path: '/api/v2/auth/login' };
    const e = endpoint('POST', '/api/v2/auth/login');
    expect(scriptSends(e, source('const { headers } = await loginViaApi(fixtures.users.alice);'), login)).toBe(true);
    expect(scriptSends(e, source('await loggedInPage(page, fixtures.users.alice);'), login)).toBe(true);
    expect(scriptSends(e, source('const { headers } = await loginViaApi(fixtures.users.alice);'))).toBe(false); // no login settings
    expect(scriptSends(endpoint('POST', '/api/v2/auth/signup'), source('await loginViaApi(u)'), login)).toBe(false);
  });
});

describe('what the evidence holds', () => {
  const file = ["router.post('/login',", '  validate,', '  asyncHandler(auth.login));', '', 'router.get("/x", async (req, res) => {', '  res.send(1);', '});'];
  const read = async (f: string) => (f === 'server/r.js' ? file : null);
  it('measurable code is a function body; a route declaration alone is not', async () => {
    expect(await hasMeasurableCode(endpoint('POST', '/login', [1, 3]), read)).toBe(false);
    expect(await hasMeasurableCode(endpoint('GET', '/x', [5, 7]), read)).toBe(true);
    expect(await hasMeasurableCode(endpoint('GET', '/x', [1, 7]), read)).toBe(true);
  });
  it('names a disabled setting only as a whole word, in the evidence lines', async () => {
    const lines = ["router.post('/n',", '  gate([env.MAIL_ENABLED]),', '  go);', '', 'const x = env.MAIL_ENABLED_EXTRA;'];
    const r = async () => lines;
    expect(await namedDisabledSetting(endpoint('POST', '/n', [1, 3]), ['MAIL_ENABLED'], r)).toBe('MAIL_ENABLED');
    expect(await namedDisabledSetting(endpoint('POST', '/n', [4, 5]), ['MAIL_ENABLED'], r)).toBeUndefined();
    expect(await namedDisabledSetting(endpoint('POST', '/n', [1, 3]), [], r)).toBeUndefined();
  });
});

describe('classifyUnreached (the rules of 7b/8, on the cases of the recorded Kutt run)', () => {
  const lines = [
    "router.post('/login',", '  asyncHandler(auth.login));', // 1-2: route only
    '', "router.post('/report',", '  gate([env.MAIL_ENABLED]),', '  handler);', // 4-6: names the setting, no body
    '', "router.post('/apikey',", '  asyncHandler(auth.generateApiKey));', // 8-9 route only, no setting
    'async function generateApiKey(req, res) {', '  if (env.REDIS_ENABLED) await redis.del(key);', '  res.send(1);', '}', // 10-13
  ];
  const read = async () => lines;
  const login = endpoint('POST', '/api/v2/auth/login', [1, 2]);
  const report = endpoint('POST', '/api/v2/links/report', [4, 6]);
  const apikeyHandler = { ...endpoint('POST', '/api/v2/auth/apikey', [10, 13]) };
  const all = [login, report, apikeyHandler];
  const keys = ['MAIL_ENABLED', 'REDIS_ENABLED'];
  const auth = { login: { method: 'POST', path: '/api/v2/auth/login', body: {} }, tokenAt: 'token', header: 'Cookie', prefix: '' } as unknown as TargetConfig['auth'];
  const classify = (scriptSources: string[], reach = [false, false, false]) =>
    classifyUnreached(all, reach.map((reached) => ({ reached })), { disabledKeys: keys, read, scriptSources, login: auth });

  it('login: route-only evidence and the login helper in a passing script: counted by request', async () => {
    expect((await classify(['await loginViaApi(u)']))[0]).toEqual({ observed: true });
    expect((await classify(['// nothing']))[0]).toEqual({});
  });
  it('report: names the setting; gated only once a passing script has sent it', async () => {
    expect((await classify(['// nothing']))[1]).toEqual({});
    expect((await classify(["await api.post('/api/v2/links/report', {})"]))[1]).toEqual({ gatedBy: 'MAIL_ENABLED' });
  });
  it('apikey: the setting is an optional cache inside the handler; with no passing script that sends it, it is asked for, not gated', async () => {
    expect((await classify(['await loginViaApi(u)']))[2]).toEqual({});
    // Sent by a script that passed, and still unreached, it would be gated: the observation, not the mention, decides.
    expect((await classify(["await api.post('/api/v2/auth/apikey', {})"]))[2]).toEqual({ gatedBy: 'REDIS_ENABLED' });
  });
  it('leaves reached endpoints alone', async () => {
    expect(await classify(['await loginViaApi(u)', "await api.post('/api/v2/links/report', {})"], [true, true, true])).toEqual([{}, {}, {}]);
  });
});
