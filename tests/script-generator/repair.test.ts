import { describe, expect, it } from 'vitest';
import { suggestsInstability } from '../../src/modules/script-generator/classify.js';
import { scriptErrorHint } from '../../src/modules/script-generator/repair.js';
import type { TestCase } from '../../src/shared/schemas.js';

// Excerpts of real Playwright 1.64.0 failures of dry runs on the correct version (run mern-ecommerce-20261025-152610).

const tc = (expected: TestCase['expected']): TestCase => ({
  id: 'TC-001', requirementIds: ['REQ-001'], title: 't', layer: 'api', category: 'functional', priority: 'high',
  preconditions: [], fixturesUsed: [], steps: ['s'], expected,
});
const wrap = (id: string, matcher: string, expectedLine: string, receivedLine: string) =>
  `Error: ${id}\n\nexpect(received).${matcher}(expected) // Object.is equality\n\n${expectedLine}\n${receivedLine}`;

describe('scriptErrorHint: a locked value that looks read from the wrong thing', () => {
  it('a value of another kind than the locked one (a message compared with a status)', () => {
    const t = tc([{ id: 'E6', description: 'The delete returns 200 with the message', value: 'Merchant has been deleted successfully!' }]);
    const hint = scriptErrorHint({
      tc: t, expectationId: 'E6', body: "expect(delAdminRes.status(), 'E6').toBe(EXPECTED.E6.value);",
      result: { message: wrap('E6', 'toBe', 'Expected: "Merchant has been deleted successfully!"', 'Received: 200') },
    });
    expect(hint).toContain('is locked to the string "Merchant has been deleted successfully!", but the test compared it with the number 200');
  });

  it('two expectations lock different statuses of one response variable', () => {
    const t = tc([{ id: 'E1', description: 'Status 400', value: 400 }, { id: 'E3', description: 'The follow-up login succeeds, status', value: 200 }]);
    const body = "const res = await api.post('/x');\nexpect(res.status(), 'E1').toBe(EXPECTED.E1.value);\nexpect(res.status(), 'E3').toBe(EXPECTED.E3.value);";
    const hint = scriptErrorHint({ tc: t, expectationId: 'E3', body, result: { message: wrap('E3', 'toBe', 'Expected: 200', 'Received: 400') } });
    expect(hint).toContain('E3 ("The follow-up login succeeds, status") and E1 both check res.status() but are locked to 200 and 400');
    // a response variable that is declared twice is not one response
    expect(scriptErrorHint({ tc: t, expectationId: 'E3', body: `let res = 1;\nlet res2 = 2;\nvar res = 3;\n${body}`, result: { message: wrap('E3', 'toBe', 'Expected: 200', 'Received: 400') } })).not.toContain('both check');
  });

  it('a request rejected where success is expected, and accepted where rejection is expected', () => {
    const ok = tc([{ id: 'E1', description: 'The response status is 200', value: 200 }]);
    const lastResponse = JSON.stringify({ method: 'PUT', url: 'http://localhost:3000/api/category/6a', status: 400, body: '{"error":"Your request could not be processed. Please try again."}' });
    const rejected = scriptErrorHint({ tc: ok, expectationId: 'E1', body: "expect(putRes.status(), 'E1').toBe(EXPECTED.E1.value);", result: { message: wrap('E1', 'toBe', 'Expected: 200', 'Received: 400'), lastResponse } });
    expect(rejected).toContain('expects 200, but the app rejected the request with 400');
    const bad = tc([{ id: 'E1', description: 'The response status is 400', value: 400 }]);
    const accepted = scriptErrorHint({ tc: bad, expectationId: 'E1', body: "expect(res.status(), 'E1').toBe(EXPECTED.E1.value);", result: { message: wrap('E1', 'toBe', 'Expected: 400', 'Received: 200') } });
    expect(accepted).toContain('expects 400, but the app accepted the request with 200');
    // another status of the same class is a plain disagreement
    const same = scriptErrorHint({ tc: bad, expectationId: 'E1', body: "expect(res.status(), 'E1').toBe(EXPECTED.E1.value);", result: { message: wrap('E1', 'toBe', 'Expected: 400', 'Received: 401') } });
    expect(same).toBeNull();
    // a number that is not a status is not read as one
    const price = tc([{ id: 'E1', description: 'The price is shown', value: 237 }]);
    expect(scriptErrorHint({ tc: price, expectationId: 'E1', body: "expect(p, 'E1').toBe(EXPECTED.E1.value);", result: { message: wrap('E1', 'toBe', 'Expected: 237', 'Received: 400') } })).toBeNull();
  });

  it('an error message locked, but the last request was rejected with another answer', () => {
    const t = tc([{ id: 'E2', description: 'The response contains the error message', value: 'Slug is already in use.' }]);
    const lastResponse = JSON.stringify({ method: 'PUT', url: 'http://localhost:3000/api/category/6a', status: 400, body: '{"error":"Your request could not be processed. Please try again."}' });
    const message = wrap('E2', 'toBe', 'Expected: "Slug is already in use."', 'Received: "Your request could not be processed. Please try again."');
    expect(scriptErrorHint({ tc: t, expectationId: 'E2', body: "expect(b.error, 'E2').toBe(EXPECTED.E2.value);", result: { message, lastResponse } })).toContain('was rejected with 400 and another answer');
    // the last answer holds the message: a plain disagreement
    const same = JSON.stringify({ method: 'PUT', url: 'http://x/y', status: 400, body: '{"error":"Slug is already in use. (x)"}' });
    expect(scriptErrorHint({ tc: t, expectationId: 'E2', body: '', result: { message, lastResponse: same } })).toBeNull();
  });

  it('the expected text is inside what was received, or elsewhere on the page', () => {
    const t = tc([{ id: 'E2', description: 'The heading is shown', value: 'Account Security' }]);
    const diff = 'Error: E2\n\nexpect(locator).toHaveText(expected) failed\n\n- Expected  - 0\n+ Received  + 2\n\n  Array [\n+   "Account",\n    "Account Security",\n+   "Reset Password",\n  ]\n\nCall log:\n  - E2 locator resolved';
    expect(scriptErrorHint({ tc: t, expectationId: 'E2', body: '', result: { message: diff } })).toContain('is part of what the element holds');
    const missing = 'Error: E2\n\nexpect(locator).toHaveText(expected) failed\n\nLocator: locator(\'h3\')\nExpected: "Account Security"\nReceived: "Shop By Brand"\n\nCall log:\n  - x';
    expect(scriptErrorHint({ tc: t, expectationId: 'E2', body: '', result: { message: missing } })).toBeNull();
    expect(scriptErrorHint({ tc: t, expectationId: 'E2', body: '', result: { message: missing, pageSnapshot: '- main:\n  - heading "Account Security" [level=2]' } })).toContain('is on the page');
    // a short value such as "5" is not looked for on a page
    const five = tc([{ id: 'E3', description: 'Quantity', value: '5' }]);
    expect(scriptErrorHint({ tc: five, expectationId: 'E3', body: '', result: { message: 'Error: E3\n\nExpected substring: "5"\nReceived string:    ""', pageSnapshot: '- text: 5 items' } })).toBeNull();
  });

  it('a plain disagreement of the same kind gets no hint', () => {
    const t = tc([{ id: 'E3', description: 'Message says updated', value: 'Your Wishlist has been updated successfully!' }]);
    const lastResponse = JSON.stringify({ method: 'POST', url: 'http://x/api/wishlist', status: 200, body: '{"message":"Added to your Wishlist successfully!"}' });
    expect(scriptErrorHint({ tc: t, expectationId: 'E3', body: '', result: { message: wrap('E3', 'toBe', 'Expected: "Your Wishlist has been updated successfully!"', 'Received: "Added to your Wishlist successfully!"'), lastResponse } })).toBeNull();
  });
});

describe('suggestsInstability', () => {
  it('a timeout or a browser or network error in a dry run, not a script error', () => {
    expect(suggestsInstability({ stage: 'dry-run', category: 'timeout', error: 'Test timeout of 30000ms exceeded.' })).toBe(true);
    expect(suggestsInstability({ stage: 'dry-run', category: 'runtime-error', error: 'Error: page.goto: net::ERR_ABORTED at http://localhost:8080/dashboard/address' })).toBe(true);
    expect(suggestsInstability({ stage: 'dry-run', category: 'runtime-error', error: "TypeError: Cannot read properties of undefined (reading 'map')" })).toBe(false);
    expect(suggestsInstability({ stage: 'dry-run', category: 'locator', error: 'Error: E1\nelement(s) not found' })).toBe(false);
    expect(suggestsInstability({ stage: 'typecheck', category: 'timeout', error: null })).toBe(false);
  });
});
