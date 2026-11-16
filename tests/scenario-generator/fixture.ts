import { Prd } from '../../src/shared/schemas.js';

export const FIXTURES = {
  users: {
    admin: { email: 'admin@x.test', password: 'p', role: 'admin' },
    alice: { email: 'alice@x.test', password: 'p', role: 'member' },
    bob: { email: 'bob@x.test', password: 'p', role: 'member' },
  },
};

const ev = (file: string, a: number, b: number) => [{ file, lines: [a, b] as [number, number] }];
export const PRD = Prd.parse({
  schemaVersion: '1.0',
  target: 'fake',
  sourceRef: 'golden',
  generatedAt: '2026-11-16T10:00:00Z',
  features: [
    { id: 'F-01', name: 'Items', description: 'Listing and adding items.' },
    { id: 'F-02', name: 'Admin', description: 'Reports for admins.' },
  ],
  apiEndpoints: [
    { method: 'GET', path: '/api/items', authRequired: true, summary: 'List items, sorted', responses: [{ status: 200, description: 'ok' }], evidence: ev('server/items.js', 1, 12) },
    { method: 'POST', path: '/api/items', authRequired: true, summary: 'Add an item', responses: [{ status: 201, description: 'ok' }], evidence: ev('server/items.js', 14, 20) },
    { method: 'DELETE', path: '/api/items/:id', authRequired: true, summary: 'Delete an item', responses: [{ status: 200, description: 'ok' }], evidence: ev('server/items.js', 22, 26) },
    { method: 'GET', path: '/api/admin/report', authRequired: true, summary: 'Admin report', responses: [{ status: 200, description: 'ok' }], evidence: ev('server/admin.js', 1, 6) },
    { method: 'GET', path: '/api/health', authRequired: false, summary: 'Health', responses: [{ status: 200, description: 'ok' }], evidence: ev('server/admin.js', 8, 9) },
  ],
  uiRoutes: [
    { path: '/items', summary: 'Items page', authRequired: true, evidence: ev('client/Items.js', 1, 5) },
    { path: '/login', summary: 'Login', authRequired: false, evidence: ev('client/Items.js', 7, 8) },
  ],
  requirements: [
    { id: 'REQ-001', featureId: 'F-01', layer: 'api', statement: 'GET /api/items lists the items, sorted by the sort query value.', acceptanceCriteria: [{ text: 'sorted', evidence: ev('server/items.js', 1, 12) }], priority: 'high' },
    { id: 'REQ-002', featureId: 'F-01', layer: 'api', statement: 'POST /api/items adds an item; DELETE /api/items/:id removes it.', acceptanceCriteria: [{ text: 'added', evidence: ev('server/items.js', 14, 26) }], priority: 'high' },
    { id: 'REQ-003', featureId: 'F-01', layer: 'ui', statement: 'The page /items shows the items.', acceptanceCriteria: [{ text: 'shown', evidence: ev('client/Items.js', 1, 5) }], priority: 'medium' },
    { id: 'REQ-004', featureId: 'F-02', layer: 'api', statement: 'GET /api/admin/report is for admins only.', acceptanceCriteria: [{ text: 'admins', evidence: ev('server/admin.js', 1, 6) }], priority: 'high' },
  ],
  assumptions: [],
  openQuestions: [],
});

