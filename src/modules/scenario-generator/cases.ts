import type { ScenarioCase, TestCategory, VariationKind, VariationPoint } from '../../shared/schemas.js';
import { CREATED_USER, VISITOR } from './usage.js';

const CATEGORY: Record<VariationKind, TestCategory> = {
  role: 'auth',
  list: 'functional',
  'unused-option': 'functional',
  'state-after-action': 'functional',
  boundary: 'boundary',
};

const LABEL: Record<VariationKind, string> = {
  role: 'Role',
  list: 'List',
  'unused-option': 'Option',
  'state-after-action': 'After an action',
  boundary: 'Boundary',
};

/**
 * The light check of every scenario (SPEC §6.5): the action got an answer, whatever it says. The comparison of two
 * versions' recorded answers does the real checking, so a scenario whose answer is "wrong" on the correct version (a
 * wrong role let in) still passes and stays in the suite.
 */
export function lightExpectation(layer: 'api' | 'ui'): ScenarioCase['expected'] {
  return layer === 'api'
    ? [{ id: 'E1', description: 'The varied request got an HTTP response, whatever its status (check only that a status arrived)' }]
    : [{ id: 'E1', description: 'After the action the page shows its content: the body is visible (check nothing else)' }];
}

const shorten = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** A scenario test case built by code from its variation point. */
export function scenarioCase(point: VariationPoint, id: string): ScenarioCase {
  const target = point.endpoint ?? point.page ?? '';
  const who = point.user === VISITOR ? 'as a visitor' : `as ${point.user}`;
  const values = point.values.length > 0 ? ` Use these values: ${point.values.map((v) => JSON.stringify(v)).join(', ')}.` : '';
  const records = point.kind === 'list' && point.records ? [`Create at least ${point.records} records first (with values that differ in what the list sorts or filters by).`] : [];
  return {
    id,
    requirementIds: [point.requirementId],
    title: shorten(`${LABEL[point.kind]}: ${target} ${who}: ${point.description}`, 160),
    layer: point.layer,
    category: CATEGORY[point.kind],
    priority: 'medium',
    preconditions:
      point.user === VISITOR
        ? ['Not logged in for the varied action']
        : point.role === CREATED_USER
          ? [`The varied action is done by a new user the test registers first with uniq values (called ${point.user} here), logged in with loginViaApi`]
          : [`Logged in as ${point.user} for the varied action`],
    fixturesUsed: point.user === VISITOR || point.role === CREATED_USER ? [] : [point.user],
    steps: [...point.setup, ...records, `${point.action}${values}`],
    expected: lightExpectation(point.layer),
    scenario: { variationPointId: point.id, kind: point.kind },
  };
}
