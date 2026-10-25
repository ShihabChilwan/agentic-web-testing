import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { snapshotForModel } from '../../src/modules/execution-engine/probe.js';
import { collectPageSnapshots, renderPageSnapshots, snapshotProblems, snapshotRequests, usersByRole } from '../../src/modules/test-case-generator/pages.js';
import { PageSnapshots, TargetConfig } from '../../src/shared/schemas.js';
import type { PageSnapshotEntry, Prd, PrdRequirement } from '../../src/shared/schemas.js';
import { example } from '../shared/schemas/helpers.js';

const config = TargetConfig.parse(example('target.config.json')); // users: admin (role admin), alice and bob (role member)
const ev = [{ file: 'client/app/Login.js', lines: [1, 3] as [number, number] }];
const req = (id: string, layer: string, text: string): PrdRequirement =>
  ({ id, featureId: 'F-01', layer, priority: 'medium', statement: text, acceptanceCriteria: [{ text: 'It works', evidence: ev }] }) as PrdRequirement;
const prd = (): Prd =>
  ({
    ...example('prd.json'),
    uiRoutes: [
      { path: '/login', summary: 'Login', authRequired: false, evidence: ev },
      { path: '/dashboard/orders', summary: 'Orders', authRequired: true, evidence: ev },
      { path: '/product/:slug', summary: 'Product', authRequired: false, evidence: ev },
      { path: '/about', summary: 'About', authRequired: false, evidence: ev },
      { path: '/*', summary: 'Not found', authRequired: false, evidence: ev },
    ],
    requirements: [
      req('REQ-001', 'ui', 'The /login page shows a heading.'),
      req('REQ-002', 'ui', 'The /dashboard/orders page lists orders.'),
      req('REQ-003', 'e2e', 'Opening /product/blue-shirt then /product/<slug> shows a product.'),
      req('REQ-004', 'api', 'GET /about returns 200.'), // an api requirement does not make /about a page to snapshot
    ],
  }) as Prd;

const entry = (path: string, user: string | null, aria: string, role: string | null = user ? 'member' : null): PageSnapshotEntry => ({
  path, route: path, user, role, finalPath: path, aria,
});

const tempDirs: string[] = [];
afterEach(async () => {
  for (const d of tempDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('which pages to snapshot', () => {
  it('takes pages ui/e2e requirements name, concrete paths only, a visitor or one user per role for login pages', () => {
    expect(usersByRole(config)).toEqual([{ user: 'users.admin', role: 'admin' }, { user: 'users.alice', role: 'member' }]);
    expect(snapshotRequests(prd(), config)).toEqual([
      { path: '/login', route: '/login', user: null, role: null },
      { path: '/dashboard/orders', route: '/dashboard/orders', user: 'users.admin', role: 'admin' },
      { path: '/dashboard/orders', route: '/dashboard/orders', user: 'users.alice', role: 'member' },
      { path: '/product/blue-shirt', route: '/product/:slug', user: null, role: null },
    ]);
  });
});

describe('snapshots.json', () => {
  it('takes only missing pages, reuses a complete file of the same commit, and starts over for another commit', async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), 'pages-'));
    tempDirs.push(runDir);
    const requests = snapshotRequests(prd(), config);
    const asked: string[][] = [];
    const take = async (missing: typeof requests) => {
      asked.push(missing.map((r) => `${r.path}|${r.user ?? ''}`));
      return missing.map((r) => (r.path === '/product/blue-shirt' ? null : { finalPath: r.path, aria: `- heading "${r.path}"` }));
    };
    const first = await collectPageSnapshots({ runDir, generationCommit: 'abc1234', requests, config, take });
    expect(first.taken).toBe(4);
    expect(first.snapshots.pages.map((p) => p.path)).toEqual(['/login', '/dashboard/orders', '/dashboard/orders']); // the product page could not be opened
    expect(PageSnapshots.parse(JSON.parse(await readFile(first.file, 'utf8'))).pages).toHaveLength(3);
    // Same commit: only the page that failed is asked for again.
    const second = await collectPageSnapshots({ runDir, generationCommit: 'abc1234', requests, config, take });
    expect(asked[1]).toEqual(['/product/blue-shirt|']);
    expect(second.snapshots.pages).toHaveLength(3);
    // Complete for what is asked: nothing is taken.
    await collectPageSnapshots({ runDir, generationCommit: 'abc1234', requests: requests.slice(0, 1), config, take });
    expect(asked).toHaveLength(2);
    // Another commit: everything again.
    await collectPageSnapshots({ runDir, generationCommit: 'def5678', requests, config, take });
    expect(asked[2]).toHaveLength(4);
  });
});

describe('what the test case writer sees', () => {
  it('shows the snapshots of its requirements\' pages without link URLs, labelled with who sees them', () => {
    const aria = '- link "Edit":\n  - /url: /dashboard/product/edit/6ade07a6ffd7f855b5d2fe85\n- heading "Orders" [level=1]';
    expect(snapshotForModel(aria)).toBe('- link "Edit":\n- heading "Orders" [level=1]');
    const text = renderPageSnapshots([entry('/dashboard/orders', 'users.admin', aria, 'admin'), entry('/login', null, '- heading "Sign in"')], [req('REQ-002', 'ui', 'The /dashboard/orders page lists orders.')])!;
    expect(text).toContain('### /dashboard/orders (logged in as users.admin (role admin))');
    expect(text).toContain('- heading "Orders" [level=1]');
    expect(text).not.toContain('/url:');
    expect(text).not.toContain('/login'); // not a page of this session's requirements
    expect(renderPageSnapshots([entry('/login', null, '- heading "Sign in"')], [req('REQ-002', 'ui', 'The /dashboard/orders page.')])).toBeNull();
  });
});

describe('expected text must be on the page', () => {
  const pages = [
    entry('/login', null, '- heading "Sign In" [level=2]\n- textbox "Please Enter Your Email"\n- link "Home":\n  - /url: /secret-slug-abc'),
    entry('/dashboard', 'users.alice', '- heading "Account Details"'),
    entry('/dashboard', 'users.admin', '- heading "Admin Panel"', 'admin'),
  ];
  const uiCase = (steps: string[], expected: Array<Record<string, unknown>>, fixturesUsed: string[] = []) =>
    ({ requirementIds: ['REQ-001'], layer: 'ui', category: 'functional', priority: 'high', preconditions: [], fixturesUsed, steps, expected });
  const check = (cases: unknown[]) => snapshotProblems({ testCases: cases, declined: [] } as never, pages);

  it('accepts text the page shows (case and spacing ignored), and does not check URL paths or numbers', () => {
    expect(check([uiCase(['Open /login'], [{ description: 'Heading', value: 'sign  in' }, { description: 'Email box', value: 'Please Enter Your Email' }, { description: 'URL', value: '/login' }, { description: 'Count', value: 3 }])])).toEqual([]);
  });

  it('rejects text the page does not show, naming the page and who sees it; link URLs never count as text', () => {
    expect(check([uiCase(['Open /login'], [{ description: 'Welcome', value: 'Welcome back!' }, { description: 'Slug', value: 'secret-slug-abc' }])])).toEqual([
      'testCases[0].expected[0].value "Welcome back!" is not on /login as a visitor sees it; expect text the page shows (see "The pages as they are now"), or set "afterAction": true if it appears only after a step acts on the page',
      'testCases[0].expected[1].value "secret-slug-abc" is not on /login as a visitor sees it; expect text the page shows (see "The pages as they are now"), or set "afterAction": true if it appears only after a step acts on the page',
    ]);
  });

  it('uses the view of the case\'s own fixture user', () => {
    expect(check([uiCase(['Log in', 'Open /dashboard'], [{ description: 'Heading', value: 'Admin Panel' }], ['users.admin'])])).toEqual([]);
    expect(check([uiCase(['Log in', 'Open /dashboard'], [{ description: 'Heading', value: 'Admin Panel' }], ['users.alice'])])[0]).toContain('is not on /dashboard as users.alice (role member) sees it');
  });

  it('accepts afterAction only when a step acts on the page after opening it', () => {
    expect(check([uiCase(['Open /login', 'Submit the empty form'], [{ description: 'Error', value: 'Please enter an email', afterAction: true }])])).toEqual([]);
    expect(check([uiCase(['Open /login'], [{ description: 'Error', value: 'Please enter an email', afterAction: true }])])).toEqual([
      'testCases[0].expected[0]: "afterAction" needs a step that acts on the page after opening it (fill, click, submit); this case only opens it',
    ]);
  });

  it('checks nothing where no snapshot of the page exists, and never api cases', () => {
    expect(check([uiCase(['Open /contact'], [{ description: 'Title', value: 'Contact us' }])])).toEqual([]);
    expect(check([{ ...uiCase(['Open /login'], [{ description: 'x', value: 'nowhere' }]), layer: 'api' }])).toEqual([]);
  });
});
