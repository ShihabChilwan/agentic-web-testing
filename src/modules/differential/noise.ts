import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readResponsesFile } from '../execution-engine/responses.js';
import { NoiseFields, ResponseComparison, SCHEMA_VERSION } from '../../shared/schemas.js';
import type { RecordedResponse, ValueShape } from '../../shared/schemas.js';
import { canonical, comparable, coveredBy, diffPair, endpointOf, matchResponses, normaliseBodies, sharedIdCount, WHOLE_RESPONSE_FIELDS, type MatchedPair } from './diff.js';
import { describeShape, fitsShape, mergeShapes, observeShape } from './shapes.js';

const MAX_EXAMPLE_CHARS = 2000;

/** A value short enough for a person to read in a file (long strings and objects cut). */
function short(v: unknown): unknown {
  const text = typeof v === 'string' ? v : JSON.stringify(v);
  if (text === undefined || text.length <= MAX_EXAMPLE_CHARS) return v;
  return `${text.slice(0, MAX_EXAMPLE_CHARS)}… (${text.length} characters)`;
}

type NoiseEntry = { tests: Set<string>; count: number; example: { a: unknown; b: unknown }; shape?: ValueShape };

/** The values of a list item field (`items[*].slug`) in each innermost list of a body. */
export function listInstances(body: unknown, field: string): unknown[][] {
  const tokens: string[] = [...(field.match(/\[\*\]|[^.[\]]+/g) ?? [])];
  const last = tokens.lastIndexOf('[*]');
  if (last < 0 || last === tokens.length - 1) return [];
  const get = (v: unknown, toks: string[]): unknown[] => {
    if (toks.length === 0) return [v];
    const [t, ...rest] = toks;
    if (t === '[*]') return Array.isArray(v) ? v.flatMap((x) => get(x, rest)) : [];
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && t! in v) return get((v as Record<string, unknown>)[t!], rest);
    return [];
  };
  const lists = get(body, tokens.slice(0, last)).filter(Array.isArray) as unknown[][];
  const suffix = tokens.slice(last + 1);
  return lists.map((list) => list.flatMap((item) => get(item, suffix)).filter((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v)));
}

const hasDuplicate = (values: readonly unknown[]) => new Set(values.map((v) => canonical(v))).size !== values.length;

/**
 * The noise of two or more executions of the same version (SPEC §7.6), every pair compared: per endpoint,
 * every field whose value differed, with the shape its values had (`ValueShape`) and, for list item
 * fields, whether a list ever held a value twice; and every list whose items came back in another order
 * (those lists are matched by key, so their fields are compared item by item).
 */
export function findNoise(runs: ReadonlyArray<readonly RecordedResponse[]>, meta: { run: string; sourceRunId: string; executions: string[]; now?: Date }): NoiseFields {
  if (runs.length < 2 || runs.length !== meta.executions.length) throw new Error('findNoise needs two or more executions, one list of responses each');
  const fields = new Map<string, Map<string, NoiseEntry>>();
  const reordered = new Map<string, Map<string, { key: string; tests: Set<string> }>>();
  let differences = 0;
  let matched = 0;
  let unmatched = 0;
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const pairs = matchResponses(runs[i]!, runs[j]!);
      matched += pairs.filter((p) => p.a && p.b).length;
      unmatched += pairs.filter((p) => !p.a || !p.b).length;
      for (const pair of pairs) {
        // Every pair is checked for reordering on its own, so each test that shows it is listed.
        const diffs = diffPair(pair, {
          onOrderChange: (f, key) => {
            const byField = reordered.get(pair.endpoint) ?? new Map<string, { key: string; tests: Set<string> }>();
            reordered.set(pair.endpoint, byField);
            const entry = byField.get(f) ?? { key, tests: new Set<string>() };
            entry.tests.add(pair.testCaseId);
            byField.set(f, entry);
          },
        });
        differences += diffs.length;
        const byField = fields.get(pair.endpoint) ?? new Map<string, NoiseEntry>();
        fields.set(pair.endpoint, byField);
        for (const d of diffs) {
          const entry: NoiseEntry = byField.get(d.field) ?? { tests: new Set<string>(), count: 0, example: { a: short(d.a), b: short(d.b) } };
          entry.tests.add(pair.testCaseId);
          entry.count += 1;
          if (!WHOLE_RESPONSE_FIELDS.has(d.field)) {
            const seen = observeShape(d.a, d.b);
            entry.shape = entry.shape ? mergeShapes(entry.shape, seen) : seen;
          }
          byField.set(d.field, entry);
        }
      }
    }
  }
  // List item noise fields: did any list in any correct run hold a value twice?
  const normalised = runs.map((r) => normaliseBodies(comparable(r)));
  const uniqueOf = (endpoint: string, field: string): boolean | undefined => {
    let lists = 0;
    for (const run of normalised) {
      for (const r of run) {
        if (r.bodyKind !== 'json' || endpointOf(r.method, r.path) !== endpoint) continue;
        for (const values of listInstances(r.body, field)) {
          if (values.length < 2) continue;
          lists += 1;
          if (hasDuplicate(values)) return false;
        }
      }
    }
    return lists > 0 ? true : undefined;
  };
  const endpoints = [...new Set([...fields.keys(), ...reordered.keys()])]
    .sort()
    .map((endpoint) => ({
      endpoint,
      fields: [...(fields.get(endpoint) ?? new Map<string, NoiseEntry>()).entries()]
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([field, e]) => {
          // Times are not identifiers (two records can share a millisecond): no duplicate check for them.
          const unique = field.includes('[*]') && !WHOLE_RESPONSE_FIELDS.has(field) && e.shape?.kind !== 'time' ? uniqueOf(endpoint, field) : undefined;
          return { field, tests: [...e.tests].sort(), count: e.count, example: e.example, ...(e.shape ? { shape: e.shape } : {}), ...(unique !== undefined ? { unique } : {}) };
        }),
      unstableOrder: [...(reordered.get(endpoint) ?? new Map()).entries()]
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([array, e]) => ({ array, key: e.key, tests: [...e.tests].sort() })),
    }))
    .filter((e) => e.fields.length > 0 || e.unstableOrder.length > 0);
  return NoiseFields.parse({
    schemaVersion: SCHEMA_VERSION,
    createdAt: (meta.now ?? new Date()).toISOString(),
    run: meta.run,
    sourceRunId: meta.sourceRunId,
    executions: meta.executions,
    summary: {
      responses: runs.map((r) => r.length),
      matched,
      unmatched,
      differences,
      noiseFields: endpoints.reduce((n, e) => n + e.fields.length, 0),
      unstableOrderLists: endpoints.reduce((n, e) => n + e.unstableOrder.length, 0),
    },
    endpoints,
  });
}

const isAlias = (v: unknown): boolean => (typeof v === 'string' && v.startsWith('<id:')) || (Array.isArray(v) && v.length > 0 && v.every(isAlias));
/** Folded into a setup finding when at least this many strong differences only change id aliases and they are most of them. */
export const SETUP_FOLD_MIN = 50;

type Kept = { field: string; path: string; base: unknown; other: unknown; strength: 'strong' | 'weak'; reason: 'value' | 'shape' | 'duplicate' | 'request' };

/**
 * The differences between two executions that the noise file does not explain (SPEC §7.6), grouped by
 * test, endpoint and field. Lists the noise file names as unstable in order are matched by key. A noise
 * field's value outside its learned shape, and a duplicate in a list field the correct runs never
 * repeated, stay as strong differences. When most strong differences only change id aliases, they are
 * folded into one `setup-changed` finding.
 */
export function compareResponses(
  a: readonly RecordedResponse[],
  b: readonly RecordedResponse[],
  noise: NoiseFields | null,
  meta: { run: string; base: string; other: string; noiseFile: string | null; now?: Date },
): ResponseComparison {
  // A value field is noise for the whole endpoint; a whole-response field only for the tests it was seen in.
  const noiseBy = new Map(
    (noise?.endpoints ?? []).map((e) => [
      e.endpoint,
      {
        fields: new Set(e.fields.filter((f) => !WHOLE_RESPONSE_FIELDS.has(f.field)).map((f) => f.field)),
        entries: new Map(e.fields.map((f) => [f.field, f])),
        wholeFor: new Map(e.fields.filter((f) => WHOLE_RESPONSE_FIELDS.has(f.field)).map((f) => [f.field, new Set(f.tests)])),
        keyed: new Map(e.unstableOrder.map((u) => [u.array, u.key])),
      },
    ]),
  );
  const pairs = matchResponses(a, b);
  let differences = 0;
  let ignored = 0;
  const kept: Array<{ pair: MatchedPair; diffs: Kept[] }> = [];
  for (const pair of pairs) {
    const known = noiseBy.get(pair.endpoint);
    const diffs = diffPair(pair, { keyedArrays: (f) => known?.keyed.get(f) });
    differences += diffs.length;
    // Weak: a browser call seen in one run only (browser timing can cause it); everything else is strong.
    const present = pair.a ?? pair.b;
    const strengthOf = (field: string): 'strong' | 'weak' => (field === '(response)' && present?.source === 'page' ? 'weak' : 'strong');
    const out: Kept[] = [];
    for (const d of diffs) {
      const entry = known?.entries.get(d.field);
      let noisy = false;
      let reason: Kept['reason'] = d.field === '(request)' ? 'request' : 'value';
      if (known && WHOLE_RESPONSE_FIELDS.has(d.field)) noisy = known.wholeFor.get(d.field)?.has(pair.testCaseId) === true;
      else if (known) {
        noisy = coveredBy(d.field, known.fields) || known.wholeFor.get('(body)')?.has(pair.testCaseId) === true;
        // An exact noise field whose value leaves the shape the correct runs showed is a real difference.
        if (noisy && entry?.shape && !fitsShape(d.a, d.b, entry.shape)) {
          noisy = false;
          reason = 'shape';
        }
      }
      if (noisy) ignored += 1;
      else out.push({ field: d.field, path: d.path, base: d.a, other: d.b, strength: strengthOf(d.field), reason });
    }
    // Duplicates in a list field that the correct runs never repeated.
    if (known && pair.a?.bodyKind === 'json' && pair.b?.bodyKind === 'json' && !pair.request) {
      for (const f of known.entries.values()) {
        if (f.unique !== true) continue;
        const before = listInstances(pair.a.body, f.field).flatMap((vs) => (hasDuplicate(vs) ? vs : []));
        const dups = listInstances(pair.b.body, f.field).flatMap((vs) => vs.filter((v, i) => vs.findIndex((w) => canonical(w) === canonical(v)) !== i));
        if (dups.length > 0 && before.length === 0) out.push({ field: `${f.field}(duplicate)`, path: f.field, base: [], other: dups, strength: 'strong', reason: 'duplicate' });
      }
    }
    if (out.length > 0) kept.push({ pair, diffs: out });
  }
  // Most strong differences only change id aliases: the setup changed; one finding instead of thousands.
  const strongAll = kept.flatMap((k) => k.diffs.filter((d) => d.strength === 'strong'));
  const aliasOnly = strongAll.filter((d) => isAlias(d.base) && isAlias(d.other)).length;
  const findings: ResponseComparison['findings'] = [];
  if (aliasOnly >= SETUP_FOLD_MIN && aliasOnly * 2 > strongAll.length) {
    const [sa, sb] = [sharedIdCount(a), sharedIdCount(b)];
    findings.push({
      kind: 'setup-changed',
      count: aliasOnly,
      message:
        sb * 10 < sa
          ? `setup changed: database snapshot failed / re-seeded (seeded ids shared by several tests: ${sa} in ${meta.base}, ${sb} in ${meta.other}); ${aliasOnly} id-alias differences folded`
          : `setup changed: ${aliasOnly} of ${strongAll.length} strong differences only change id aliases (seeded ids shared by several tests: ${sa} in ${meta.base}, ${sb} in ${meta.other})`,
    });
    for (const k of kept) k.diffs = k.diffs.filter((d) => !(d.strength === 'strong' && isAlias(d.base) && isAlias(d.other)));
  }
  const tests = new Map<string, ResponseComparison['tests'][number]['endpoints']>();
  for (const { pair, diffs } of kept) {
    if (diffs.length === 0) continue;
    const list = tests.get(pair.testCaseId) ?? [];
    tests.set(pair.testCaseId, list);
    list.push({ endpoint: pair.endpoint, occurrence: pair.occurrence, differences: diffs });
  }
  const grouped = [...tests.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([testCaseId, endpoints]) => ({ testCaseId, endpoints }));
  const all = grouped.flatMap((t) => t.endpoints.flatMap((e) => e.differences));
  const strong = all.filter((d) => d.strength === 'strong').length + findings.length;
  const weak = all.filter((d) => d.strength === 'weak').length;
  return ResponseComparison.parse({
    schemaVersion: SCHEMA_VERSION,
    createdAt: (meta.now ?? new Date()).toISOString(),
    run: meta.run,
    base: meta.base,
    other: meta.other,
    noiseFile: meta.noiseFile,
    summary: {
      matched: pairs.filter((p) => p.a && p.b).length,
      unmatched: pairs.filter((p) => !p.a || !p.b).length,
      differences,
      ignoredAsNoise: ignored,
      remaining: strong + weak,
      strong,
      weak,
      testsWithDifferences: grouped.length,
    },
    findings,
    tests: grouped,
  });
}

const cell = (v: unknown, max = 160) => {
  const text = typeof v === 'string' ? JSON.stringify(v) : (JSON.stringify(v) ?? 'undefined');
  return (text.length > max ? `${text.slice(0, max)}…` : text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
};

/** The comparison as Markdown: strong differences first, then weak ones, each by test and endpoint. */
export function comparisonMarkdown(c: ResponseComparison): string {
  const s = c.summary;
  const lines = [
    `# Response comparison ${c.base} → ${c.other}`,
    '',
    `Run \`${c.run}\`; noise file: ${c.noiseFile ? `\`${c.noiseFile}\`` : 'none'}.`,
    '',
    `Matched responses ${s.matched}, unmatched ${s.unmatched}; differences ${s.differences}, ignored as noise ${s.ignoredAsNoise}, **remaining ${s.remaining}: strong ${s.strong}, weak ${s.weak}** in ${s.testsWithDifferences} tests.`,
    '',
    'Strong: a changed value, status code, list or request, a noise field outside its learned shape, a new duplicate, or an api response present in one run only. Weak: a browser call present in one run only (browser timing can cause it).',
  ];
  if (c.findings.length > 0) {
    lines.push('', '## Findings');
    for (const f of c.findings) lines.push('', `- **${f.message}** (${f.count} differences folded, counted as one)`);
  }
  for (const strength of ['strong', 'weak'] as const) {
    lines.push('', `## ${strength === 'strong' ? 'Strong' : 'Weak'} differences (${strength === 'strong' ? s.strong : s.weak})`);
    for (const t of c.tests) {
      const endpoints = t.endpoints.map((e) => ({ ...e, differences: e.differences.filter((d) => d.strength === strength) })).filter((e) => e.differences.length > 0);
      if (endpoints.length === 0) continue;
      lines.push('', `### ${t.testCaseId}`);
      for (const e of endpoints) {
        lines.push('', `#### ${e.endpoint}${e.occurrence > 1 ? ` (call ${e.occurrence})` : ''}`, '', `| Field | Path | Why | ${c.base} | ${c.other} |`, '|---|---|---|---|---|');
        for (const d of e.differences) lines.push(`| \`${d.field}\` | \`${d.path}\` | ${d.reason} | ${cell(d.base)} | ${cell(d.other)} |`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

/** The noise file as Markdown: per endpoint the noise fields and the lists matched by key. */
export function noiseMarkdown(n: NoiseFields): string {
  const s = n.summary;
  const lines = [
    `# Noise fields (${n.executions.join(', ')})`,
    '',
    `Run \`${n.run}\` (suite \`${n.sourceRunId}\`). Responses ${s.responses.join(' / ')}; over every pair of runs: matched ${s.matched}, unmatched ${s.unmatched}, ${s.differences} differences in ${s.noiseFields} noise fields; ${s.unstableOrderLists} lists with unstable order.`,
  ];
  for (const e of n.endpoints) {
    lines.push('', `## ${e.endpoint}`);
    if (e.fields.length > 0) {
      lines.push('', '| Field | Learned shape | Tests | Example A | Example B |', '|---|---|---|---|---|');
      for (const f of e.fields) {
        const shape = f.shape ? `${describeShape(f.shape)}${f.unique ? '; never repeated in a list' : ''}` : `only in ${f.tests.length === 1 ? 'this test' : 'these tests'}`;
        lines.push(`| \`${f.field}\` | ${shape} | ${f.tests.join(', ')} | ${cell(f.example.a, 80)} | ${cell(f.example.b, 80)} |`);
      }
    }
    for (const u of e.unstableOrder) lines.push('', `Unstable order: \`${u.array}\`, matched by \`${u.key}\` (${u.tests.join(', ')})`);
  }
  return `${lines.join('\n')}\n`;
}

const responsesOf = (runDir: string, execId: string) => readResponsesFile(path.join(runDir, 'executions', execId, 'responses.jsonl'));

async function sourceRunId(runDir: string): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(runDir, 'run.json'), 'utf8')) as { runId?: string };
  return manifest.runId ?? path.basename(runDir);
}

/** Writes runs/<run>/noise-fields.json and noise-fields.md from two or more recorded executions of the same version. */
export async function writeNoiseFile(runDir: string, executions: string[]): Promise<{ file: string; noise: NoiseFields }> {
  const runs = await Promise.all(executions.map((x) => responsesOf(runDir, x)));
  const noise = findNoise(runs, { run: path.basename(runDir), sourceRunId: await sourceRunId(runDir), executions });
  const file = path.join(runDir, 'noise-fields.json');
  await writeFile(file, `${JSON.stringify(noise, null, 2)}\n`, 'utf8');
  await writeFile(path.join(runDir, 'noise-fields.md'), noiseMarkdown(noise), 'utf8');
  return { file, noise };
}

/** Writes runs/<run>/differential/compare-<base>-<other>.json and .md. `noiseFile` null compares without a filter. */
export async function writeComparison(runDir: string, base: string, other: string, noiseFile: string | null) {
  const noise = noiseFile ? NoiseFields.parse(JSON.parse(await readFile(noiseFile, 'utf8'))) : null;
  const [a, b] = await Promise.all([responsesOf(runDir, base), responsesOf(runDir, other)]);
  const comparison = compareResponses(a, b, noise, { run: path.basename(runDir), base, other, noiseFile: noiseFile ? path.relative(runDir, noiseFile) || noiseFile : null });
  const dir = path.join(runDir, 'differential');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `compare-${base}-${other}.json`);
  await writeFile(file, `${JSON.stringify(comparison, null, 2)}\n`, 'utf8');
  await writeFile(file.replace(/\.json$/, '.md'), comparisonMarkdown(comparison), 'utf8');
  return { file, comparison };
}
