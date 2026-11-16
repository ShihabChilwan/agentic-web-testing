import { templateMatches } from '../../shared/route-paths.js';
import type { Prd, PrdRequirement, ProposedVariationPoint, VariationKind, VariationPoint } from '../../shared/schemas.js';
import { describesEndpoint, namesPage, relatesToEndpoint } from '../test-case-generator/generate.js';
import { matchEndpoint } from '../test-case-generator/checks.js';
import type { ReadLines } from '../test-case-generator/context.js';
import { endpointKey, fixtureRole, VISITOR, type SuiteUsage } from './usage.js';

/** Proposed points per discovery session. */
export const MAX_POINTS_PER_FEATURE = 8;
/** Lines a citation may span. */
export const MAX_CITATION_LINES = 80;
/** Records a list scenario creates first, at least. */
export const MIN_LIST_RECORDS = 3;

type Endpoint = Prd['apiEndpoints'][number];
export type DraftPoint = Omit<VariationPoint, 'id' | 'unrunLines'>;

/** One fixture user per role, the first by name ("users.admin" for admin), and the visitor. */
export function roleUsers(fixtures: unknown): Array<{ role: string; user: string }> {
  const users = (fixtures && typeof fixtures === 'object' ? (fixtures as Record<string, unknown>).users : undefined) ?? {};
  const byRole = new Map<string, string>();
  for (const name of Object.keys(users as Record<string, unknown>).sort()) {
    const role = fixtureRole(fixtures, `users.${name}`);
    if (role && !byRole.has(role)) byRole.set(role, `users.${name}`);
  }
  return [...[...byRole.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([role, user]) => ({ role, user })), { role: VISITOR, user: VISITOR }];
}

/** The requirement a scenario on this endpoint is linked to: one that describes it or its resource, else none. */
export function requirementForEndpoint(endpoint: Endpoint, prd: Prd, apiPrefix: string): PrdRequirement | undefined {
  return (
    prd.requirements.find((r) => describesEndpoint(r, endpoint, prd.apiEndpoints)) ??
    prd.requirements.find((r) => relatesToEndpoint(r, endpoint, prd.apiEndpoints, apiPrefix, prd.requirements))
  );
}

const clip = (lines: readonly [number, number]): [number, number] => [lines[0], Math.min(lines[1], lines[0] + MAX_CITATION_LINES - 1)];

/**
 * Role points, made by code (SPEC §6.5): every endpoint that needs a login, and every page that needs one (without
 * parameters), as each role of the fixture users and as a visitor, where the suite never sent or opened it as that role.
 * The point cites the endpoint's or page's own evidence and is linked to a requirement describing it (skipped without one).
 */
export function rolePoints(prd: Prd, usage: SuiteUsage, fixtures: unknown, apiPrefix: string): DraftPoint[] {
  const users = roleUsers(fixtures);
  const out: DraftPoint[] = [];
  for (const endpoint of prd.apiEndpoints) {
    if (!endpoint.authRequired) continue;
    const requirement = requirementForEndpoint(endpoint, prd, apiPrefix);
    if (!requirement) continue;
    const seen = usage.endpoints.get(endpointKey(endpoint))?.roles ?? new Set<string>();
    const hasParams = /\/[:{<$]/.test(endpoint.path);
    for (const { role, user } of users) {
      if (seen.has(role)) continue;
      const who = user === VISITOR ? 'a visitor who is not logged in' : `${user} (role ${role})`;
      out.push({
        kind: 'role',
        layer: 'api',
        endpoint: endpointKey(endpoint),
        description: `The suite never sends ${endpointKey(endpoint)} as ${role === VISITOR ? 'a visitor' : `a user with role ${role}`}; send it as ${who} and keep the answer.`,
        values: [],
        setup: hasParams ? ['The path has parameters: first get an id of a record that exists (create one through the API as a user who may, or read it from a list endpoint).'] : [],
        action: `Send ${endpointKey(endpoint)} as ${who}${['POST', 'PUT', 'PATCH'].includes(endpoint.method) ? ' with a body in the shape the endpoint reads' : ''}.`,
        user,
        citation: { file: endpoint.evidence[0]!.file, lines: clip(endpoint.evidence[0]!.lines) },
        featureId: requirement.featureId,
        origin: 'code',
        role,
        requirementId: requirement.id,
      });
    }
  }
  for (const route of prd.uiRoutes) {
    if (!route.authRequired || route.kind === 'fragment' || /[*:{<$]/.test(route.path)) continue;
    const requirement = prd.requirements.find((r) => namesPage(r, route.path));
    if (!requirement) continue;
    const seen = usage.pages.get(route.path) ?? new Set<string>();
    for (const { role, user } of users) {
      if (seen.has(role)) continue;
      const who = user === VISITOR ? 'a visitor who is not logged in' : `${user} (role ${role})`;
      out.push({
        kind: 'role',
        layer: 'ui',
        page: route.path,
        description: `The suite never opens ${route.path} as ${role === VISITOR ? 'a visitor' : `a user with role ${role}`}; open it as ${who} and let the page settle.`,
        values: [],
        setup: [],
        action: `Open ${route.path} as ${who} and wait until the page has loaded.`,
        user,
        citation: { file: route.evidence[0]!.file, lines: clip(route.evidence[0]!.lines) },
        featureId: requirement.featureId,
        origin: 'code',
        role,
        requirementId: requirement.id,
      });
    }
  }
  return out;
}

/** The key two points share when they are the same scenario. */
export const pointKey = (p: Pick<VariationPoint, 'kind' | 'endpoint' | 'page' | 'values' | 'user'>): string =>
  JSON.stringify([p.kind, p.endpoint ?? null, p.page ?? null, [...p.values].map(String).sort(), p.user]);

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
const tokens = (s: string) => s.match(/[A-Za-z0-9_]+/g) ?? [];

/**
 * Whether a value appears in cited code: as written (whitespace collapsed), or every word and number of it appears
 * there (a JSON sort value {"price":1} against code that builds { price: 1 }).
 */
export function appearsIn(value: string | number | boolean, cited: string): boolean {
  const text = collapse(String(value));
  if (cited.includes(text)) return true;
  const words = new Set(tokens(cited));
  const own = tokens(text);
  return own.length > 0 && own.every((t) => words.has(t));
}

export interface CheckContext {
  prd: Prd;
  featureRequirements: PrdRequirement[];
  fixtures: unknown;
  usage: SuiteUsage;
  read: ReadLines;
}

/** The PRD endpoint a point names ("METHOD /path", the PRD's path or a concrete one). */
export function pointEndpoint(endpoint: string | undefined, prd: Prd): Endpoint | undefined {
  const m = /^(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(\/\S*)$/.exec(endpoint?.trim() ?? '');
  if (!m) return undefined;
  return prd.apiEndpoints.find((e) => e.method === m[1] && e.path === m[2]!.split('?')[0]) ?? matchEndpoint(m[1]!, m[2]!.split('?')[0]!, prd.apiEndpoints);
}

/**
 * Code checks on one session's submitted points (SPEC §6.5); returns problems for the model, empty when all pass. Also
 * returns the drafts with their feature, role and requirement filled in.
 */
export async function checkProposed(points: readonly ProposedVariationPoint[], featureId: string, ctx: CheckContext): Promise<{ problems: string[]; drafts: DraftPoint[] }> {
  const problems: string[] = [];
  const drafts: DraftPoint[] = [];
  const keys = new Set<string>();
  const routes = ctx.prd.uiRoutes.map((r) => r.path);
  for (const [i, p] of points.entries()) {
    const at = `points[${i}]`;
    const before = problems.length;
    const lines = await ctx.read(p.citation.file);
    if (!lines) problems.push(`${at}: citation file ${p.citation.file} does not exist (cite application code you read)`);
    else if (p.citation.lines[1] > lines.length) problems.push(`${at}: citation lines ${p.citation.lines.join('-')} are past the end of ${p.citation.file} (${lines.length} lines)`);
    if (p.citation.lines[1] - p.citation.lines[0] + 1 > MAX_CITATION_LINES) problems.push(`${at}: cite at most ${MAX_CITATION_LINES} lines`);
    const endpoint = pointEndpoint(p.endpoint, ctx.prd);
    if (p.layer === 'api' && !endpoint) problems.push(`${at}: an api point names one endpoint of the list as "METHOD /path"; "${p.endpoint ?? ''}" is not one`);
    if (p.layer === 'ui' && (!p.page || !routes.some((r) => templateMatches(r, p.page!)))) problems.push(`${at}: a ui point names the page it opens with a path that fits a page route; "${p.page ?? ''}" does not`);
    const role = p.user === VISITOR ? VISITOR : fixtureRole(ctx.fixtures, p.user);
    if (!role) problems.push(`${at}: user must be a fixture user path such as "users.<name>" or "visitor"; "${p.user}" is neither`);
    if (p.kind === 'list' && ((p.records ?? 0) < MIN_LIST_RECORDS || p.setup.length === 0)) problems.push(`${at}: a list point creates at least ${MIN_LIST_RECORDS} records first: set records and describe them in setup`);
    if (p.kind === 'state-after-action' && p.setup.length === 0) problems.push(`${at}: a state-after-action point does the earlier action in setup`);
    if (p.kind === 'unused-option') {
      if (p.values.length === 0) problems.push(`${at}: an unused-option point lists the values to use`);
      const cited = lines ? collapse(lines.slice(p.citation.lines[0] - 1, p.citation.lines[1]).join(' ')) : '';
      for (const v of p.values) {
        if (lines && !appearsIn(v, cited)) problems.push(`${at}: the value ${JSON.stringify(v)} does not appear in the cited lines ${p.citation.file}:${p.citation.lines.join('-')}`);
      }
      const used = endpoint ? ctx.usage.endpoints.get(endpointKey(endpoint))?.query : undefined;
      const sent = new Set([...(used?.values() ?? [])].flatMap((s) => [...s]));
      const already = p.values.filter((v) => sent.has(String(v)));
      if (already.length > 0) problems.push(`${at}: the suite already sends ${already.map((v) => JSON.stringify(v)).join(', ')} to ${endpointKey(endpoint!)}; propose a value it never sent`);
    }
    if (problems.length > before) continue;
    const draft: DraftPoint = {
      ...p,
      ...(endpoint ? { endpoint: endpointKey(endpoint) } : {}),
      featureId,
      origin: 'model',
      role: role!,
      requirementId: requirementFor(p, endpoint, ctx.featureRequirements, ctx.prd).id,
    };
    const key = pointKey(draft);
    if (keys.has(key)) {
      problems.push(`${at}: the same scenario as an earlier point; drop one`);
      continue;
    }
    keys.add(key);
    drafts.push(draft);
  }
  return { problems, drafts };
}

function requirementFor(p: ProposedVariationPoint, endpoint: Endpoint | undefined, featureRequirements: PrdRequirement[], prd: Prd): PrdRequirement {
  return (
    (endpoint && featureRequirements.find((r) => describesEndpoint(r, endpoint, prd.apiEndpoints))) ||
    (p.page && featureRequirements.find((r) => prd.uiRoutes.some((route) => templateMatches(route.path, p.page!) && namesPage(r, route.path)))) ||
    featureRequirements[0]!
  );
}

/** The order kinds are taken in when the scenarios are chosen. */
export const KIND_ORDER: readonly VariationKind[] = ['role', 'list', 'unused-option', 'state-after-action', 'boundary'];
/** Scenarios per endpoint or page at most, so one busy endpoint does not take the cap. */
export const MAX_PER_TARGET = 2;

/**
 * Chooses the scenarios (SPEC §6.5), deterministic: duplicates dropped; within each (feature, kind) bucket, points whose
 * cited code no test ran come first, then model points, then by id. Then rounds over the kinds (role, list,
 * unused-option, state-after-action, boundary): in each round every kind that still has points gives one, taken from
 * the next feature in turn (each kind keeps its own place in the feature order), so no kind takes more than its share
 * of the cap while another kind has points left, and every feature gets a turn; at most MAX_PER_TARGET per endpoint or
 * page. The first `cap` are selected, the next `reserve` kept for refills.
 */
export function selectPoints(points: readonly VariationPoint[], featureOrder: readonly string[], cap: number, reserve: number): { selected: string[]; reserve: string[] } {
  const seen = new Set<string>();
  const unique = points.filter((p) => {
    const key = pointKey(p);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const features = [...featureOrder, ...[...new Set(unique.map((p) => p.featureId))].filter((f) => !featureOrder.includes(f)).sort()];
  const buckets = new Map<string, VariationPoint[]>();
  for (const p of unique) {
    const key = `${p.featureId}|${p.kind}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(p);
  }
  for (const list of buckets.values()) {
    list.sort((a, b) => Number(b.unrunLines) - Number(a.unrunLines) || Number(a.origin === 'code') - Number(b.origin === 'code') || a.id.localeCompare(b.id));
  }
  const order: VariationPoint[] = [];
  const perTarget = new Map<string, number>();
  const nextFeature = new Map<VariationKind, number>(KIND_ORDER.map((k) => [k, 0]));
  const want = cap + reserve;
  /** The next point of a kind: from the next feature in turn that has one within the per-target cap. */
  const take = (kind: VariationKind): VariationPoint | undefined => {
    for (let step = 0; step < features.length; step++) {
      const fi = (nextFeature.get(kind)! + step) % features.length;
      const list = buckets.get(`${features[fi]}|${kind}`);
      while (list && list.length > 0) {
        const candidate = list.shift()!;
        const target = candidate.endpoint ?? candidate.page ?? '';
        if ((perTarget.get(target) ?? 0) >= MAX_PER_TARGET) continue;
        perTarget.set(target, (perTarget.get(target) ?? 0) + 1);
        nextFeature.set(kind, fi + 1);
        return candidate;
      }
    }
    return undefined;
  };
  while (order.length < want) {
    let took = false;
    for (const kind of KIND_ORDER) {
      if (order.length >= want) break;
      const next = take(kind);
      if (next) {
        order.push(next);
        took = true;
      }
    }
    if (!took) break;
  }
  return { selected: order.slice(0, cap).map((p) => p.id), reserve: order.slice(cap, want).map((p) => p.id) };
}
