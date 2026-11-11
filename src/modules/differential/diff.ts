import type { RecordedResponse, UnstableOrder, ValueShape, VariableSegment } from '../../shared/schemas.js';
import { ABSENT, fitsTail, mergeShapes, wholeTailShape } from './shapes.js';
import { diffHtml, diffPageText, isHtml, PAGE_METHODS } from './pages.js';

export { ABSENT };

/** One changed value: `path` with positions or item keys, `field` generalised (`items[*].price`). */
export interface FieldDiff {
  field: string;
  path: string;
  a: unknown;
  b: unknown;
}

/** Two responses of the same test, endpoint and occurrence; one side may be missing. */
export interface MatchedPair {
  testCaseId: string;
  endpoint: string;
  occurrence: number;
  a?: RecordedResponse;
  b?: RecordedResponse;
  /** Set when the two calls have the same method, path and query names but other query values: the request itself changed. */
  request?: { a: string; b: string };
}

const HEX_ID = /^[0-9a-f]{24}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER = /^\d+$/;

/** Milliseconds since 1970 that a test run can produce (2017 to 2049). */
const isRecentTime = (ms: number) => ms >= 1.5e12 && ms <= 2.5e12;
/** `uniq()` of the scripts' helpers: `<prefix>-<Date.now() in base 36>-<up to 6 random base-36 characters>`. */
const UNIQ_PART = /(?<![0-9a-z])([0-9a-z]{7,9})-[0-9a-z]{1,6}(?![0-9a-z])/g;
/** `Date.now()` written into a value by a script. */
const NOW_PART = /(?<!\d)\d{13}(?!\d)/g;
const ID_PART = /(?<![0-9a-f])(?:[0-9a-f]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-f])/gi;

/**
 * Text with the values a run generates replaced, so the same step matches across runs: the time and
 * random parts of `uniq()` by `<uniq>`, a `Date.now()` number by `<now>`, an id inside text by `<id>`.
 * Only these forms of the scripts' own helpers and of ids are replaced; anything else stays as it is.
 */
export function normaliseGenerated(text: string): string {
  return text
    .replace(UNIQ_PART, (m, time: string) => (isRecentTime(parseInt(time, 36)) ? '<uniq>' : m))
    .replace(NOW_PART, (m) => (isRecentTime(Number(m)) ? '<now>' : m))
    .replace(ID_PART, '<id>');
}

function normaliseSegment(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    /* keep it as is */
  }
  if (HEX_ID.test(decoded) || UUID.test(decoded) || NUMBER.test(decoded)) return ':id';
  return normaliseGenerated(decoded);
}

/**
 * The endpoint of a response: method plus the path with id-like parts as `:id` (24-hex ids, UUIDs,
 * numbers) and generated values as `<uniq>`, `<now>` or `<id>` (normaliseGenerated), so a resource a
 * test creates matches across runs although its id and name differ. Query values are normalised the same
 * way; parameter order is kept.
 */
export function endpointOf(method: string, path: string): string {
  const [pathname = '', query] = path.split('?', 2);
  const normPath = pathname.split('/').map(normaliseSegment).join('/');
  const normQuery = query
    ?.split('&')
    .map((pair) => {
      const [k, v] = pair.split('=', 2);
      return v === undefined ? k : `${k}=${normaliseSegment(v)}`;
    })
    .join('&');
  return `${method.toUpperCase()} ${normPath}${normQuery ? `?${normQuery}` : ''}`;
}

/** What a path part that varies between correct runs becomes in an endpoint (VariableSegment). */
export const VARIABLE_SEGMENT = ':var';

function splitEndpoint(endpoint: string): { method: string; segments: string[]; query: string } {
  const space = endpoint.indexOf(' ');
  const [pathname = '', query = ''] = endpoint.slice(space + 1).split('?', 2);
  return { method: endpoint.slice(0, space), segments: pathname.split('/'), query };
}

/**
 * The endpoint with every path part that a learned VariableSegment rule covers as `:var`: same method,
 * query and number of parts, the rule's other parts equal, the test one the rule was learned in, and the
 * part of the shape the correct runs showed (a random address of 6 characters stays one when the app
 * returns another one; `/settings` in its place does not fit a mixed-case shape).
 */
export function applyVariableSegments(endpoint: string, testCaseId: string, rules: readonly VariableSegment[]): string {
  let out = endpoint;
  for (const rule of rules) {
    if (!rule.tests.includes(testCaseId)) continue;
    const e = splitEndpoint(out);
    const t = splitEndpoint(rule.endpoint);
    if (e.method !== t.method || e.query !== t.query || e.segments.length !== t.segments.length) continue;
    if (!t.segments.every((seg, i) => i === rule.position || seg === e.segments[i])) continue;
    const seg = e.segments[rule.position]!;
    if (seg === VARIABLE_SEGMENT || !fitsTail(seg, rule.shape)) continue;
    e.segments[rule.position] = VARIABLE_SEGMENT;
    out = `${e.method} ${e.segments.join('/')}${e.query ? `?${e.query}` : ''}`;
  }
  return out;
}

/**
 * Path parts that vary between two runs of the same version (SPEC §7.6): a call seen in one run only and
 * a call seen in the other run only, in the same test, with the same method and query, whose paths differ
 * in exactly one part, and both parts differ from their first character on with a random-looking tail
 * shape (`/2H3EbB` and `/ubELTW`: an address the app made up at random). Merged by endpoint and position.
 */
export function learnVariableSegments(pairs: readonly MatchedPair[], into: VariableSegment[] = []): VariableSegment[] {
  const onlyA = pairs.filter((p) => p.a && !p.b);
  const onlyB = pairs.filter((p) => p.b && !p.a);
  const used = new Set<MatchedPair>();
  for (const x of onlyA) {
    const ex = splitEndpoint(x.endpoint);
    for (const y of onlyB) {
      if (used.has(y) || y.testCaseId !== x.testCaseId) continue;
      const ey = splitEndpoint(y.endpoint);
      if (ex.method !== ey.method || ex.query !== ey.query || ex.segments.length !== ey.segments.length) continue;
      const differ = ex.segments.map((seg, i) => (seg === ey.segments[i] ? -1 : i)).filter((i) => i >= 0);
      if (differ.length !== 1) continue;
      const position = differ[0]!;
      const shape = wholeTailShape(ex.segments[position]!, ey.segments[position]!);
      if (!shape) continue;
      used.add(y);
      const template = [...ex.segments];
      template[position] = '*';
      const endpoint = `${ex.method} ${template.join('/')}${ex.query ? `?${ex.query}` : ''}`;
      const known = into.find((r) => r.endpoint === endpoint && r.position === position);
      if (!known) into.push({ endpoint, position, tests: [x.testCaseId], shape });
      else {
        const merged: ValueShape = mergeShapes(known.shape, shape);
        if (merged.kind !== 'tail') continue;
        known.shape = merged;
        if (!known.tests.includes(x.testCaseId)) known.tests = [...known.tests, x.testCaseId].sort();
      }
      break;
    }
  }
  return into.sort((p, q) => p.endpoint.localeCompare(q.endpoint) || p.position - q.position);
}

const ID_VALUE = /^(?:[0-9a-f]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function collectIds(v: unknown, into: Set<string>): void {
  if (typeof v === 'string') {
    if (ID_VALUE.test(v)) into.add(v.toLowerCase());
  } else if (Array.isArray(v)) v.forEach((x) => collectIds(x, into));
  else if (v !== null && typeof v === 'object') Object.values(v).forEach((x) => collectIds(x, into));
}

/** Whole id values become their alias; other strings get normaliseGenerated. */
function normaliseValue(v: unknown, alias: ReadonlyMap<string, string>): unknown {
  if (typeof v === 'string') return ID_VALUE.test(v) ? (alias.get(v.toLowerCase()) ?? v) : normaliseGenerated(v);
  if (Array.isArray(v)) return v.map((x) => normaliseValue(x, alias));
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normaliseValue(x, alias)]));
  return v;
}

/**
 * Page calls with a 2xx status and no body: the browser cancelled them when the page moved on, so
 * whether one is seen depends on timing. They are left out of the comparison (api responses are kept).
 */
export function comparable(list: readonly RecordedResponse[]): RecordedResponse[] {
  return list.filter((r) => !(r.source === 'page' && r.bodyKind === 'none' && r.status >= 200 && r.status < 300));
}

/**
 * Prepares bodies for comparison. Every execution seeds afresh, so the same record has another id in each
 * one; ids that start with their creation time (24-hex object ids) keep their order, so ids are replaced
 * by their rank in sorted order: an id seen in two or more tests (a seeded record) by `<id:n>`, its rank
 * among those ids in the whole execution, so a record missing from one response shifts no other alias;
 * an id seen in one test only (a record that test made) by `<id:t.n>`, its rank among that test's own ids.
 * Limitation: a seeded record that a version shows in one test only becomes test-local there, and the
 * shared ranks after it shift. Other strings, and text bodies, get normaliseGenerated.
 */
export function normaliseBodies(list: readonly RecordedResponse[]): RecordedResponse[] {
  const testsOf = new Map<string, Set<string>>();
  const idsOf = new Map<string, Set<string>>();
  for (const r of list) {
    if (r.bodyKind !== 'json') continue;
    const ids = new Set<string>();
    collectIds(r.body, ids);
    const own = idsOf.get(r.testCaseId) ?? new Set<string>();
    idsOf.set(r.testCaseId, own);
    for (const id of ids) {
      own.add(id);
      testsOf.set(id, (testsOf.get(id) ?? new Set<string>()).add(r.testCaseId));
    }
  }
  const shared = [...testsOf].filter(([, tests]) => tests.size > 1).map(([id]) => id).sort();
  const sharedAlias = new Map(shared.map((id, i) => [id, `<id:${i + 1}>`]));
  const aliases = new Map(
    [...idsOf].map(([t, ids]) => {
      const local = [...ids].filter((id) => !sharedAlias.has(id)).sort();
      return [t, new Map([...sharedAlias, ...local.map((id, i): [string, string] => [id, `<id:t.${i + 1}>`])])];
    }),
  );
  return list.map((r) => {
    if (r.bodyKind === 'json') return { ...r, body: normaliseValue(r.body, aliases.get(r.testCaseId)!) };
    if (r.bodyKind === 'text' && typeof r.body === 'string') return { ...r, body: normaliseGenerated(r.body) };
    return r;
  });
}

/** How many ids appear in two or more tests: seeded records shared by the tests of one execution. */
export function sharedIdCount(list: readonly RecordedResponse[]): number {
  const testsOf = new Map<string, Set<string>>();
  for (const r of list) {
    if (r.bodyKind !== 'json') continue;
    const ids = new Set<string>();
    collectIds(r.body, ids);
    for (const id of ids) testsOf.set(id, (testsOf.get(id) ?? new Set<string>()).add(r.testCaseId));
  }
  return [...testsOf.values()].filter((t) => t.size > 1).length;
}

/**
 * When two endpoints have the same method, path and query parameter names but different query values,
 * the endpoint with each differing value as `*`; otherwise undefined.
 */
export function sameRequestOtherQuery(a: string, b: string): string | undefined {
  const [pa, qa] = a.split('?', 2) as [string, string | undefined];
  const [pb, qb] = b.split('?', 2) as [string, string | undefined];
  if (pa !== pb || qa === undefined || qb === undefined || qa === qb) return undefined;
  const xa = qa.split('&').map((p) => p.split('=', 2));
  const xb = qb.split('&').map((p) => p.split('=', 2));
  if (xa.length !== xb.length || xa.some(([k], i) => k !== xb[i]![0])) return undefined;
  return `${pa}?${xa.map(([k, v], i) => (v === xb[i]![1] ? (v === undefined ? k : `${k}=${v}`) : `${k}=*`)).join('&')}`;
}

/**
 * Pairs the responses of two executions by test, endpoint and occurrence (the n-th call of that endpoint
 * in the test), not by arrival order: browser calls made at the same time can arrive in either order.
 */
export function matchResponses(a: readonly RecordedResponse[], b: readonly RecordedResponse[], variableSegments: readonly VariableSegment[] = []): MatchedPair[] {
  const index = (list: readonly RecordedResponse[]) => {
    const map = new Map<string, { testCaseId: string; endpoint: string; occurrence: number; r: RecordedResponse }>();
    const seen = new Map<string, number>();
    for (const r of [...list].sort((x, y) => x.testCaseId.localeCompare(y.testCaseId) || x.seq - y.seq)) {
      const endpoint = variableSegments.length > 0 ? applyVariableSegments(endpointOf(r.method, r.path), r.testCaseId, variableSegments) : endpointOf(r.method, r.path);
      const base = `${r.testCaseId}\u0000${endpoint}`;
      const occurrence = (seen.get(base) ?? 0) + 1;
      seen.set(base, occurrence);
      map.set(`${base}\u0000${occurrence}`, { testCaseId: r.testCaseId, endpoint, occurrence, r });
    }
    return map;
  };
  const ia = index(normaliseBodies(comparable(a)));
  const ib = index(normaliseBodies(comparable(b)));
  const pairs: MatchedPair[] = [];
  type Entry = { testCaseId: string; endpoint: string; occurrence: number; r: RecordedResponse };
  const leftA: Entry[] = [];
  const leftB: Entry[] = [];
  for (const key of new Set([...ia.keys(), ...ib.keys()])) {
    const x = ia.get(key);
    const y = ib.get(key);
    if (x && y) pairs.push({ testCaseId: x.testCaseId, endpoint: x.endpoint, occurrence: x.occurrence, a: x.r, b: y.r });
    else if (x) leftA.push(x);
    else if (y) leftB.push(y);
  }
  // A call left over on each side, in the same test, with the same path and query names but other
  // query values: one changed request (e.g. a sort order the page asks for differently).
  const bySeq = (p: Entry, q: Entry) => p.r.seq - q.r.seq;
  leftA.sort(bySeq);
  leftB.sort(bySeq);
  const requestKey = new Map<string, number>();
  for (const x of leftA) {
    const i = leftB.findIndex((y) => y.testCaseId === x.testCaseId && sameRequestOtherQuery(x.endpoint, y.endpoint) !== undefined);
    if (i < 0) {
      pairs.push({ testCaseId: x.testCaseId, endpoint: x.endpoint, occurrence: x.occurrence, a: x.r });
      continue;
    }
    const [y] = leftB.splice(i, 1);
    const endpoint = sameRequestOtherQuery(x.endpoint, y!.endpoint)!;
    const k = `${x.testCaseId}\u0000${endpoint}`;
    const occurrence = (requestKey.get(k) ?? 0) + 1;
    requestKey.set(k, occurrence);
    const query = (e: string) => e.split('?', 2)[1] ?? '';
    pairs.push({ testCaseId: x.testCaseId, endpoint, occurrence, a: x.r, b: y!.r, request: { a: query(x.endpoint), b: query(y!.endpoint) } });
  }
  for (const y of leftB) pairs.push({ testCaseId: y.testCaseId, endpoint: y.endpoint, occurrence: y.occurrence, b: y.r });
  return pairs.sort((p, q) => p.testCaseId.localeCompare(q.testCaseId) || p.endpoint.localeCompare(q.endpoint) || p.occurrence - q.occurrence);
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPrimitive = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** Stable text for any JSON value (object keys sorted). */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'undefined';
}

const PREFERRED_KEYS = ['_id', 'id', 'uuid', 'key', 'code', 'email', 'name', 'title'];

const itemKey = (item: unknown, key: string) => (key === '(value)' || key === '(item)' ? canonical(item) : canonical((item as Record<string, unknown>)[key]));

/**
 * A key to match the items of two lists by, for any list: `(value)` for plain values unique on each side;
 * else the first item field (preferred names first, then any other) that every item has as a plain value,
 * unique within each list, with at least half of the shorter list's values found on the other side (so a
 * field that differs every run, such as a time, is not taken). Undefined when none fits: positions are
 * compared.
 */
export function listKey(a: readonly unknown[], b: readonly unknown[]): string | undefined {
  const all = [...a, ...b];
  if (all.length === 0) return undefined;
  const overlapOk = (va: string[], vb: string[]) => {
    const shorter = Math.min(va.length, vb.length);
    const common = va.filter((v) => vb.includes(v)).length;
    return shorter === 0 || common * 2 >= shorter;
  };
  const unique = (vs: string[]) => new Set(vs).size === vs.length;
  if (all.every(isPrimitive)) {
    const va = a.map(canonical);
    const vb = b.map(canonical);
    return unique(va) && unique(vb) && overlapOk(va, vb) ? '(value)' : undefined;
  }
  if (!all.every(isObject)) return undefined;
  const objects = all as Array<Record<string, unknown>>;
  const fields = new Set(objects.flatMap((o) => Object.keys(o)));
  const candidates = [...PREFERRED_KEYS.filter((k) => fields.has(k)), ...[...fields].filter((k) => !PREFERRED_KEYS.includes(k)).sort()];
  for (const field of candidates) {
    if (!objects.every((o) => field in o && isPrimitive(o[field]))) continue;
    const va = (a as Array<Record<string, unknown>>).map((o) => canonical(o[field]));
    const vb = (b as Array<Record<string, unknown>>).map((o) => canonical(o[field]));
    if (unique(va) && unique(vb) && overlapOk(va, vb)) return field;
  }
  return undefined;
}

/** True when the items both lists share (by key) come in a different order. */
function orderDiffers(a: readonly unknown[], b: readonly unknown[], key: string): boolean {
  const kb = new Set(b.map((x) => itemKey(x, key)));
  const ka = new Set(a.map((x) => itemKey(x, key)));
  const sa = a.map((x) => itemKey(x, key)).filter((k) => kb.has(k));
  const sb = b.map((x) => itemKey(x, key)).filter((k) => ka.has(k));
  return sa.some((k, i) => k !== sb[i]);
}

/**
 * When two lists hold the same items in a different order, the key that matches them (`listKey`, else
 * `(item)` when the items are equal as a whole). Undefined when the order is the same.
 */
export function orderChange(a: readonly unknown[], b: readonly unknown[]): string | undefined {
  if (a.length < 2 || b.length < 2) return undefined;
  const key = listKey(a, b);
  if (key) return orderDiffers(a, b, key) ? key : undefined;
  if (a.length !== b.length) return undefined;
  const ca = a.map(canonical);
  const cb = b.map(canonical);
  if (ca.every((c, i) => c === cb[i])) return undefined;
  return [...ca].sort().join('\u0000') === [...cb].sort().join('\u0000') ? '(item)' : undefined;
}

export interface DiffOptions {
  /** Lists to match by key instead of position: generalised array path → key. */
  keyedArrays?: (field: string) => string | undefined;
  /** Called for every list whose order changed (noise detection); the returned key is then used to match its items. */
  onOrderChange?: (field: string, key: string) => void;
}

const child = (path: string, field: string, k: string) => ({ path: path ? `${path}.${k}` : k, field: field ? `${field}.${k}` : k });

/** The differences between two JSON values, with array positions generalised in `field`. */
export function diffJson(a: unknown, b: unknown, options: DiffOptions = {}, path = '', field = '', out: FieldDiff[] = []): FieldDiff[] {
  const here = field || '(body)';
  if (isObject(a) && isObject(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const c = child(path, field, k);
      if (!(k in a) || !(k in b)) out.push({ field: c.field, path: c.path, a: k in a ? a[k] : ABSENT, b: k in b ? b[k] : ABSENT });
      else diffJson(a[k], b[k], options, c.path, c.field, out);
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const itemField = `${field}[*]`;
    // A list the noise runs saw in another order: matched by its key, its order not compared.
    const unstable = options.keyedArrays?.(here);
    if (unstable) return diffKeyed(a, b, unstable, path, itemField, options, out);
    if (options.onOrderChange) {
      const changed = orderChange(a, b);
      if (changed) {
        options.onOrderChange(here, changed);
        return diffKeyed(a, b, changed, path, itemField, options, out);
      }
    }
    // Every other list: items matched by key when one fits (a missing item is one difference), and a
    // change of order is one difference of its own.
    const key = listKey(a, b);
    if (key) {
      if (orderDiffers(a, b, key)) {
        const keysOf = (list: readonly unknown[]) => list.map((x) => (key === '(value)' ? x : (x as Record<string, unknown>)[key]));
        out.push({ field: `${itemField}(order)`, path: `${path || '(body)'}(order by ${key})`, a: keysOf(a), b: keysOf(b) });
      }
      return diffKeyed(a, b, key, path, itemField, options, out);
    }
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const p = `${path}[${i}]`;
      if (i >= a.length || i >= b.length) out.push({ field: itemField, path: p, a: i < a.length ? a[i] : ABSENT, b: i < b.length ? b[i] : ABSENT });
      else diffJson(a[i], b[i], options, p, itemField, out);
    }
    return out;
  }
  if (canonical(a) !== canonical(b)) out.push({ field: here, path: path || '(body)', a, b });
  return out;
}

/** Items matched by key; an item on one side only is reported whole. Positions do not matter. */
function diffKeyed(a: readonly unknown[], b: readonly unknown[], key: string, path: string, itemField: string, options: DiffOptions, out: FieldDiff[]): FieldDiff[] {
  const group = (list: readonly unknown[]) => {
    const m = new Map<string, unknown[]>();
    for (const item of list) {
      const k = itemKey(item, key);
      m.set(k, [...(m.get(k) ?? []), item]);
    }
    return m;
  };
  const ga = group(a);
  const gb = group(b);
  for (const k of [...new Set([...ga.keys(), ...gb.keys()])].sort()) {
    const xs = ga.get(k) ?? [];
    const ys = gb.get(k) ?? [];
    const label = key === '(item)' ? `${path}[(item)]` : key === '(value)' ? `${path}[=${k}]` : `${path}[${key}=${k}]`;
    for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
      if (i >= xs.length || i >= ys.length) out.push({ field: itemField, path: label, a: i < xs.length ? xs[i] : ABSENT, b: i < ys.length ? ys[i] : ABSENT });
      else if (key !== '(value)' && key !== '(item)') diffJson(xs[i], ys[i], options, label, itemField, out);
    }
  }
  return out;
}

/** Every difference between two matched responses: presence, status, body kind, then the body. */
export function diffPair(pair: MatchedPair, options: DiffOptions = {}): FieldDiff[] {
  const { a, b } = pair;
  if (!a || !b) return [{ field: '(response)', path: '(response)', a: a ? `${a.status}` : ABSENT, b: b ? `${b.status}` : ABSENT }];
  // A changed request: its answer differs as a consequence, so only the request is reported.
  if (pair.request) return [{ field: '(request)', path: '(request)', a: pair.request.a, b: pair.request.b }];
  const out: FieldDiff[] = [];
  if (a.status !== b.status) out.push({ field: '(status)', path: '(status)', a: a.status, b: b.status });
  if (a.bodyKind !== b.bodyKind) {
    out.push({ field: '(body)', path: '(body)', a: a.bodyKind === 'json' ? a.body : a.body ?? a.bodyKind, b: b.bodyKind === 'json' ? b.body : b.body ?? b.bodyKind });
    return out;
  }
  if (PAGE_METHODS.has(a.method) && a.bodyKind === 'text' && typeof a.body === 'string' && typeof b.body === 'string') return [...out, ...diffPageText(a.body, b.body)];
  if (a.bodyKind === 'json') return diffJson(a.body, b.body, options, '', '', out);
  // HTML pages and fragments element by element; other text as one value.
  if (a.bodyKind === 'text' && typeof a.body === 'string' && typeof b.body === 'string' && a.body !== b.body && isHtml(a.contentType, a.body) && isHtml(b.contentType, b.body)) {
    return [...out, ...diffHtml(a.body, b.body)];
  }
  if (a.bodyKind === 'text' && a.body !== b.body) out.push({ field: '(body)', path: '(body)', a: a.body, b: b.body });
  return out;
}

/** Fields about the whole response; as noise they hold only for the tests they were seen in. */
export const WHOLE_RESPONSE_FIELDS: ReadonlySet<string> = new Set(['(response)', '(status)', '(body)', '(request)']);

/** A field about the whole response, or a page line or HTML element present on one side only: as noise, it holds only for the tests it was seen in. */
export function isWholeField(field: string): boolean {
  return WHOLE_RESPONSE_FIELDS.has(field) || field.endsWith('(line)') || field.endsWith('(element)');
}

/** True when `field` is a noise field or lies inside one (`items[*]` covers `items[*].price`). */
export function coveredBy(field: string, noise: ReadonlySet<string>): boolean {
  if (noise.has(field)) return true;
  for (const n of noise) {
    if (field.startsWith(`${n}.`) || field.startsWith(`${n}[`)) return true;
  }
  return false;
}

export type { UnstableOrder };
