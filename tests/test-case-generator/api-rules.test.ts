import { describe, expect, it } from 'vitest';
import { apiRuleProblems, checkSubmission, matchEndpoint, resourceOf, stepRequests } from '../../src/modules/test-case-generator/checks.js';
import { TestCases } from '../../src/shared/schemas.js';
import type { Prd } from '../../src/shared/schemas.js';
import { example } from '../shared/schemas/helpers.js';

const ep = (method: string, path: string): Prd['apiEndpoints'][number] => ({ method, path, authRequired: false, summary: 's', evidence: [] }) as never;
const endpoints = [
  ep('POST', '/api/auth/login'),
  ep('POST', '/api/auth/register'),
  ep('GET', '/api/user/me'),
  ep('GET', '/api/items'),
  ep('POST', '/api/items/add'),
  ep('GET', '/api/items/:id'),
  ep('PUT', '/api/items/:id'),
  ep('DELETE', '/api/items/delete/:id'),
  ep('POST', '/api/contact/add'), // no GET for this resource
];
const rules = { endpoints, apiPrefix: '/api', loginPath: '/api/auth/login' };
type Exp = { description: string; value?: string | number | boolean; readBack?: boolean };
const tc = (steps: string[], expected: Exp[], extra: Record<string, unknown> = {}) => ({
  requirementIds: ['REQ-001'],
  layer: 'api',
  category: 'functional',
  priority: 'high',
  preconditions: [],
  fixturesUsed: [],
  steps,
  expected,
  ...extra,
});
const problems = (cases: unknown[], declined: unknown[] = []) => apiRuleProblems({ testCases: cases, declined } as never, rules);

describe('step requests and endpoints', () => {
  it('finds the requests a step names, without query strings or trailing punctuation', () => {
    expect(stepRequests(['Log in via POST /api/auth/login', 'Send GET /api/items?page=2.', 'Send DELETE /api/items/delete/<itemId> with the token'])).toEqual([
      { step: 0, method: 'POST', path: '/api/auth/login' },
      { step: 1, method: 'GET', path: '/api/items' },
      { step: 2, method: 'DELETE', path: '/api/items/delete/<itemId>' },
    ]);
  });

  it('matches a step path to the most literal endpoint, parameters matching one segment', () => {
    expect(matchEndpoint('GET', '/api/items/<itemId>', endpoints)?.path).toBe('/api/items/:id');
    expect(matchEndpoint('GET', '/api/items/${id}', endpoints)?.path).toBe('/api/items/:id');
    expect(matchEndpoint('DELETE', '/api/items/delete/abc', endpoints)?.path).toBe('/api/items/delete/:id');
    expect(matchEndpoint('GET', '/api/items/a/b', endpoints)).toBeUndefined();
    expect(matchEndpoint('POST', '/api/items/:id', endpoints)).toBeUndefined();
    expect(resourceOf('/api/items/delete/7', '/api')).toBe('/api/items');
    expect(resourceOf('/items/7', '')).toBe('/items');
  });
});

describe('API rules', () => {
  it('accepts a write that is read back with an expectation on the read, and a success case that checks the body', () => {
    expect(
      problems([
        tc(['Log in as users.admin via POST /api/auth/login', 'Send POST /api/items/add with a unique name', 'Send GET /api/items/<id>'], [
          { description: 'Status 200', value: 200 },
          { description: 'The item has the new name', readBack: true },
        ]),
      ]),
    ).toEqual([]);
  });

  it('asks for a read after the last write, and for an expectation on it', () => {
    const [noRead] = problems([tc(['Send PUT /api/items/<id> with a new name'], [{ description: 'Status 200', value: 200 }, { description: 'The response has the new name' }])]);
    expect(noRead).toBe(
      'testCases[0]: its last write (PUT /api/items/<id>, step 1) is not followed by a read. Add a step that reads the data back with a GET request from the endpoint list, and an expectation with "readBack": true for what it returns: the new values after a create or update, the item gone after a delete, nothing changed after a rejected request',
    );
    const [noExpectation] = problems([tc(['Send DELETE /api/items/delete/<id>', 'Send GET /api/items/<id> to confirm it is gone'], [{ description: 'Status 200', value: 200 }, { description: 'A message' }])]);
    expect(noExpectation).toMatch(/is read back, but no expectation checks the read; add one with "readBack": true/);
  });

  it('counts logging in as a read only after a write that changes an account, and never treats the login itself as the write', () => {
    const loginAfter = (write: string) => tc([write, 'Log in via POST /api/auth/login'], [{ description: 'Status 200', value: 200 }, { description: 'Login reflects the change', readBack: true }]);
    // The login request's own resource is always an account resource: registration, password reset. (A GET in that
    // resource makes the rule apply at all; without one it would be skipped and prove nothing.)
    const withAuthRead = { ...rules, endpoints: [...endpoints, ep('GET', '/api/auth/google')] };
    const auth = (cases: unknown[]) => apiRuleProblems({ testCases: cases, declined: [] } as never, withAuthRead);
    expect(auth([loginAfter('Send POST /api/auth/register with a unique email')])).toEqual([]);
    expect(auth([tc(['Send POST /api/auth/register with a unique email'], [{ description: 'Status 200', value: 200 }, { description: 'A token' }])])).toHaveLength(1);
    // Creating a product and then logging in reads nothing back.
    const [product] = problems([loginAfter('Send POST /api/items/add with a unique name')]);
    expect(product).toBe(
      'testCases[0]: its last write (POST /api/items/add, step 1) is not followed by a read. Add a step that reads the data back with a GET request from the endpoint list, and an expectation with "readBack": true for what it returns: the new values after a create or update, the item gone after a delete, nothing changed after a rejected request',
    );
    // A profile resource counts only when the target config lists it.
    const profile = loginAfter('Send PUT /api/user/me with a new email');
    expect(problems([profile])).toHaveLength(1);
    expect(apiRuleProblems({ testCases: [profile], declined: [] } as never, { ...rules, accountResources: ['/api/user'] })).toEqual([]);
    const [suggestion] = auth([tc(['Send POST /api/auth/register'], [{ description: 'Status 200', value: 200 }, { description: 'A token' }])]);
    expect(suggestion).toContain('(or, since it changes an account, the login request)');
    expect(problems([tc(['Log in via POST /api/auth/login', 'Send GET /api/user/me'], [{ description: 'Status 200', value: 200 }, { description: 'The email is shown' }])])).toEqual([]);
  });

  it('skips the read-back rule when the PRD has no read endpoint for the resource, and for ui test cases', () => {
    expect(problems([tc(['Send POST /api/contact/add'], [{ description: 'Status 200', value: 200 }, { description: 'A thank-you message' }])])).toEqual([]);
    expect(problems([tc(['Send PUT /api/items/1'], [{ description: 'Saved' }], { layer: 'ui' })])).toEqual([]);
  });

  it('asks a success case to check more than the status; a rejection may check only its status', () => {
    expect(problems([tc(['Send GET /api/items'], [{ description: 'The response status is 200', value: 200 }])])).toEqual([
      'testCases[0]: it expects a success status but checks nothing else; add at least one expectation about the response body or the data read back (a field value, the created item, a message)',
    ]);
    expect(problems([tc(['Send GET /api/items'], [{ description: 'Status is OK', value: 200 }, { description: 'The response contains the seeded items' }])])).toEqual([]);
    expect(problems([tc(['Send GET /api/user/me without a token'], [{ description: 'Status 401', value: 401 }], { category: 'auth' })])).toEqual([]);
  });

  it('pairs a "not found" read with a case that reads an existing item, unless the requirement is declined in part', () => {
    const missing = tc(['Send DELETE /api/items/delete/<id>', 'Send GET /api/items/<id>'], [{ description: 'Status 200', value: 200 }, { description: 'Reading it gives 404', value: 404, readBack: true }]);
    expect(problems([missing])).toEqual([
      'testCases[0]: it reads GET /api/items/:id only for an item that does not exist (404). Add a test case that reads an existing one (create it first if the fixtures and facts have none) and checks the success status and its data; if that cannot work, say why in declined for the requirement',
    ]);
    const found = tc(['Send POST /api/items/add', 'Send GET /api/items/<id>'], [{ description: 'Status 200', value: 200 }, { description: 'The item is returned with its name', readBack: true }]);
    expect(problems([missing, found])).toEqual([]);
    expect(problems([missing], [{ requirementId: 'REQ-001', reasonKind: 'other', reason: 'existing items need a disabled service' }])).toEqual([]);
  });

  it('runs inside checkSubmission only when the API rules are given', () => {
    const sub = { testCases: [tc(['Send PUT /api/items/1'], [{ description: 'Status 200', value: 200 }])], declined: [] };
    const requirements = [{ id: 'REQ-001', featureId: 'F-01', layer: 'api', priority: 'high', statement: 's', acceptanceCriteria: [] }];
    const ctx = { requirements, fixtures: {}, grounding: { code: 'status(200)', factStatuses: [], factStrings: [] }, quota: 10 } as never;
    expect(checkSubmission(sub as never, ctx)).toEqual([]);
    expect(checkSubmission(sub as never, { ...(ctx as object), api: rules } as never)).toHaveLength(2);
  });
});

describe('readBack in testcases.json', () => {
  it('is optional: older files without it still read, and a case may mark a read-back expectation', () => {
    const file = example('testcases.json');
    expect(TestCases.safeParse(file).success).toBe(true);
    file.testCases[0].expected[0].readBack = true;
    expect(TestCases.parse(file).testCases[0]!.expected[0]!.readBack).toBe(true);
    file.testCases[0].expected[0].readBack = 'yes';
    expect(TestCases.safeParse(file).success).toBe(false);
  });
});

describe('journey length', () => {
  it('rejects an e2e journey longer than 8 steps', () => {
    const requirements = [{ id: 'REQ-001', featureId: 'F-01', layer: 'e2e', priority: 'high', statement: 's', acceptanceCriteria: [] }];
    const ctx = { requirements, fixtures: {}, grounding: { code: '', factStatuses: [], factStrings: [] }, quota: 10 } as never;
    const journey = (n: number) => tc(Array.from({ length: n }, (_, i) => `Step ${i + 1}`), [{ description: 'The order page shows the order' }], { layer: 'ui', category: 'e2e-journey' });
    expect(checkSubmission({ testCases: [journey(8)], declined: [] } as never, ctx)).toEqual([]);
    expect(checkSubmission({ testCases: [journey(9)], declined: [] } as never, ctx)).toEqual([
      'testCases[0]: an e2e journey has 9 steps (at most 8); split it into shorter journeys, or prepare data in fewer steps through the API, and check what each page shows after you move to it',
    ]);
  });
});
