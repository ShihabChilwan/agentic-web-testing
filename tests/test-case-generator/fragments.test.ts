import { describe, expect, it } from 'vitest';
import { buildSystemPrompt as prdSystemPrompt } from '../../src/modules/prd-generator/index.js';
import { buildSystemPrompt as scriptSystemPrompt } from '../../src/modules/script-generator/prompt.js';
import { describeCasesSummary, pageCoverage } from '../../src/modules/test-case-generator/generate.js';
import { PageCoverage, PrdUiRoute } from '../../src/shared/schemas.js';
import type { Prd, PrdRequirement, TestCase } from '../../src/shared/schemas.js';

const route = (path: string, kind?: 'page' | 'fragment') => ({ path, summary: 's', authRequired: false, evidence: [{ file: 'v.hbs', lines: [1, 2] as [number, number] }], ...(kind ? { kind } : {}) });
const requirement = (id: string, statement: string): PrdRequirement => ({ id, featureId: 'F-01', layer: 'ui', priority: 'medium', statement, acceptanceCriteria: [{ text: statement, evidence: [{ file: 'v.hbs', lines: [1, 2] }] }] });
const prd = (uiRoutes: Prd['uiRoutes']): Prd =>
  ({ schemaVersion: '1.0', target: 'x', sourceRef: 'golden', generatedAt: '2026-10-29T10:00:00Z', features: [], apiEndpoints: [], uiRoutes, requirements: [requirement('REQ-001', 'The /settings page shows the email.'), requirement('REQ-002', 'The /confirm-delete dialog asks for confirmation.')], assumptions: [], openQuestions: [] }) as Prd;
const uiCase = (step: string): TestCase =>
  ({ id: 'TC-001', requirementIds: ['REQ-001'], title: 't', layer: 'ui', category: 'functional', priority: 'low', preconditions: [], fixturesUsed: [], steps: [step], expected: [{ id: 'E1', description: 'd', value: 'x' }] }) as TestCase;

describe('page coverage with fragments', () => {
  const routes = [route('/settings'), route('/about'), route('/confirm-delete', 'fragment'), route('/edit/:id', 'fragment'), route('/files/*')];

  it('counts pages and fragments apart; a catch-all counts for neither', () => {
    const coverage = pageCoverage(prd(routes), [uiCase('Open /settings'), uiCase('Open /confirm-delete')]);
    expect(coverage).toEqual({
      total: 2,
      opened: 1,
      unopened: [{ path: '/about', reason: 'No ui or e2e requirement describes this page.' }],
      fragments: {
        total: 2,
        opened: 1,
        unopened: [{ path: '/edit/:id', reason: 'No ui or e2e requirement describes this page.' }],
      },
    });
    expect(PageCoverage.safeParse(coverage).success).toBe(true);
  });

  it('keeps the old shape for a PRD without fragments: no fragments key, every route is a page', () => {
    const coverage = pageCoverage(prd([route('/settings'), route('/about', 'page')]), [uiCase('Open /about')]);
    expect(coverage).toEqual({ total: 2, opened: 1, unopened: [{ path: '/settings', reason: 'The ui or e2e requirements that describe it got no test case that opens it.' }] });
    expect('fragments' in coverage).toBe(false);
  });

  it('says it on its own line in the summary a person reads', () => {
    const coverage = pageCoverage(prd(routes), [uiCase('Open /settings')]);
    const lines = describeCasesSummary({ testCases: { coverage: { requirementsTotal: 2, requirementsCovered: 1, uncovered: [], partial: [], pages: coverage }, testCases: [] }, summary: { casesByLayer: { api: 0, ui: 1 }, casesByCategory: {}, uncoveredByReasonKind: {}, sessions: 1, calls: 1, costUsd: null, rejected: { invalidInput: 0, checkFailed: 0 }, warnings: [] } } as never);
    expect(lines).toContain('pages opened by a ui test case: 1 of 2; not opened: /about');
    expect(lines).toContain('fragments (parts of pages) opened by a ui test case: 0 of 2; not opened: /confirm-delete, /edit/:id');
  });
});

describe('the route kind in the PRD', () => {
  it('is optional and limited to page or fragment, so older PRDs still parse', () => {
    expect(PrdUiRoute.safeParse(route('/a')).success).toBe(true);
    expect(PrdUiRoute.safeParse(route('/a', 'fragment')).success).toBe(true);
    expect(PrdUiRoute.safeParse({ ...route('/a'), kind: 'partial' }).success).toBe(false);
  });
});

describe('prompt changes of step 7c', () => {
  it('the PRD prompt defines a fragment', () => {
    expect(prdSystemPrompt()).toContain('kind "fragment"');
  });
  it('the script prompt tells to use loginViaApi for a user the test created, never a hand-built header', () => {
    const prompt = scriptSystemPrompt();
    expect(prompt).toContain('await loginViaApi({ email, password })');
    expect(prompt).toContain('Do not read a token from a login response and build the header or cookie by hand');
  });
});
