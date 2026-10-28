import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../../src/shared/paths.js';

// The pipeline in src/ (code, prompts and their examples, the script helpers) must stay general: nothing may name a
// target app's entities, routes, files, fixtures or seed data. Every term comes from the targets themselves (their
// target.config.json and facts.json) plus a hand-made list of each target's domain words.

/** Domain words of each target that its config and facts do not spell out (entities, features, its stack). */
const DOMAIN_WORDS: Record<string, string[]> = {
  'mern-ecommerce': [
    'wishlist', 'merchant', 'merchants', 'product', 'products', 'category', 'categories', 'brand', 'brands', 'review', 'reviews',
    'cart', 'carts', 'order', 'orders', 'address', 'addresses', 'newsletter', 'contact', 'support', 'mern', 'ecommerce',
    'passport', 'mongoose', 'mongodb', 'mongo', 'slug', 'sku', 'mailchimp', 'mailgun',
  ],
  // Not 'htmx' or 'handlebars': technologies that adapters are meant to recognise are not the app's own words.
  kutt: ['kutt', 'shortener', 'shortened', 'short link', 'short links', 'customurl'],
};

/**
 * Words of a target's domain that are also ordinary English or general engineering words, used in src/ in that general
 * sense. Each needs a reason; anything not listed here is a hit.
 */
const GENERIC: Record<string, string> = {
  order: 'ordinary English ("in order", "manifest order"), never an order entity',
  category: 'the test case field "category" (functional, boundary, …) and failure categories of the pipeline itself',
  review: 'the pipeline\'s own review of suspected defects (S3) and "review it by hand"',
  reviews: 'plural of the pipeline\'s own review',
  address: 'a network address (server.address()) and "email address" in a generic prompt example',
  support: 'the verb ("the evidence does not support")',
  Test: 'a fixture last name that is also the ordinary word "test", which the pipeline uses everywhere',
  member: 'the generic role name in examples of fixture users',
  user: 'the ordinary word, the pipeline\'s own vocabulary (a fixture user, the user of the app), and a generic role name',
  Unauthorized: 'the HTTP 401 reason phrase, which any backend may send as a plain-text body',
  admin: 'the generic role name in examples of fixture users',
};

const TEXT_FILES = /\.(ts|js|cjs|mjs|json|md|txt|html|css)$/;

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : TEXT_FILES.test(name) ? [full] : [];
  });
}

/** String leaves of a JSON value. */
const strings = (value: unknown): string[] =>
  typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The terms that must not appear in src/ for one target, each with where it comes from. */
function targetTerms(target: string): Array<{ term: string; from: string }> {
  const dir = path.join(PROJECT_ROOT, 'targets', target);
  const config = JSON.parse(readFileSync(path.join(dir, 'target.config.json'), 'utf8'));
  const facts = existsSync(path.join(dir, 'facts.json')) ? JSON.parse(readFileSync(path.join(dir, 'facts.json'), 'utf8')) : { facts: [] };
  const terms: Array<{ term: string; from: string }> = [];
  const add = (from: string, values: string[]) => values.filter(Boolean).forEach((term) => terms.push({ term, from }));
  add('domain words', DOMAIN_WORDS[target] ?? []);
  add('target name', [target]);
  // API paths and their resources ("/api/product/item/x" also gives "/api/product").
  const apiPaths = [...strings(facts.facts.map((f: { request: { path: string } }) => f.request.path)), config.seedCheck?.path, config.auth?.login?.path, ...(config.accountResources ?? [])]
    .filter((p): p is string => typeof p === 'string' && p.startsWith('/'))
    .map((p) => p.split('?')[0]!);
  const prefix = (config.backend.apiPrefix as string) || '';
  add('API paths in config and facts', [...new Set([...apiPaths, ...apiPaths.map((p) => p.split('/').slice(0, prefix ? 3 : 2).join('/'))])]);
  add('base and health URLs', [config.backend.baseUrl, config.frontend?.baseUrl, config.backend.healthCheckUrl, config.frontend?.healthCheckUrl]); // a one-process app has no frontend
  add('service env values', Object.values({ ...config.backend.env, ...config.frontend?.env }).filter((v): v is string => typeof v === 'string' && v.length >= 6));
  // Helper scripts the commands run, with their folder where they have one ("utils/seed.js", not our own "seed.js").
  add('helper files', strings(config.lifecycle).flatMap((c) => [...c.matchAll(/(?:\{\{targetDir\}\}\/)?([\w./-]+\.(?:cjs|js|mjs))\b/g)].map((m) => m[1]!)));
  const { role: _roles, ...fixtureData } = Object.fromEntries(Object.entries(config.fixtures.users).flatMap(([name, u]) => [[name, u]]));
  void _roles;
  add('fixture users', [...Object.keys(config.fixtures.users), ...strings(fixtureData).filter((v) => !['admin', 'member'].includes(v))]);
  add('login form', strings(config.auth?.uiLogin ?? {}).filter((v) => v.length >= 12));
  add('seed data in facts', strings(facts.facts.map((f: { body: unknown }) => f.body)).filter((v) => v.length >= 8 && !/^https?:\/\//.test(v)));
  return terms;
}

/** Every place in src/ a target's term appears (words by word boundary, case-insensitive; paths and phrases as text). */
function hits(target: string): string[] {
  const out: string[] = [];
  const sources = filesUnder(path.join(PROJECT_ROOT, 'src')).map((file) => ({ file: path.relative(PROJECT_ROOT, file), lines: readFileSync(file, 'utf8').split('\n') }));
  for (const { term, from } of targetTerms(target)) {
    if (GENERIC[term] !== undefined) continue;
    const pattern = /^\w+$/.test(term) ? new RegExp(`\\b${escape(term)}\\b`, 'i') : new RegExp(escape(term));
    for (const { file, lines } of sources) {
      lines.forEach((line, i) => {
        if (pattern.test(line)) out.push(`${file}:${i + 1}: "${term}" (${from})`);
      });
    }
  }
  return [...new Set(out)];
}

const targets = readdirSync(path.join(PROJECT_ROOT, 'targets')).filter((name) => existsSync(path.join(PROJECT_ROOT, 'targets', name, 'target.config.json')));

describe('src/ names nothing of a target app', () => {
  it('knows which targets to check', () => {
    expect(targets).toContain('mern-ecommerce');
    for (const t of targets) expect(DOMAIN_WORDS[t], `add the domain words of ${t} to DOMAIN_WORDS`).toBeDefined();
  });

  for (const target of targets) {
    it(`${target}: no entity, route, file, fixture or seed data of it in src/`, () => {
      expect(hits(target)).toEqual([]);
    });
  }

  it('finds a term the way it would appear (the check works)', () => {
    const terms = targetTerms('mern-ecommerce').map((t) => t.term);
    expect(terms).toEqual(expect.arrayContaining(['wishlist', '/api/product', 'alice@example.test', 'db-snapshot.js', 'utils/seed.js', 'http://localhost:3000']));
    expect(terms).not.toContain('seed.js'); // the pipeline's own seed module is not the app's
    expect(terms.some((t) => t.length >= 8 && /Steel Gloves/.test(t))).toBe(true); // a seeded product name from facts.json
  });
});
