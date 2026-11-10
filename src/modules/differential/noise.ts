import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readResponsesFile } from '../execution-engine/responses.js';
import { NoiseFields, ResponseComparison, SCHEMA_VERSION } from '../../shared/schemas.js';
import type { RecordedResponse } from '../../shared/schemas.js';
import { coveredBy, diffPair, matchResponses, WHOLE_RESPONSE_FIELDS } from './diff.js';

const MAX_EXAMPLE_CHARS = 2000;

/** A value short enough for a person to read in a file (long strings and objects cut). */
function short(v: unknown): unknown {
  const text = typeof v === 'string' ? v : JSON.stringify(v);
  if (text === undefined || text.length <= MAX_EXAMPLE_CHARS) return v;
  return `${text.slice(0, MAX_EXAMPLE_CHARS)}… (${text.length} characters)`;
}

/**
 * The noise fields of two executions of the same version (SPEC §7.6): every field, per endpoint, whose
 * value differs, and every list whose items came back in another order (those lists are then matched by
 * key, so their fields are compared item by item and not marked as noise for the reordering alone).
 */
export function findNoise(a: readonly RecordedResponse[], b: readonly RecordedResponse[], meta: { run: string; sourceRunId: string; executions: [string, string]; now?: Date }): NoiseFields {
  const pairs = matchResponses(a, b);
  const fields = new Map<string, Map<string, { tests: Set<string>; count: number; example: { a: unknown; b: unknown } }>>();
  const reordered = new Map<string, Map<string, { key: string; tests: Set<string> }>>();
  let differences = 0;
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
    const byField = fields.get(pair.endpoint) ?? new Map();
    fields.set(pair.endpoint, byField);
    for (const d of diffs) {
      const entry = byField.get(d.field) ?? { tests: new Set<string>(), count: 0, example: { a: short(d.a), b: short(d.b) } };
      entry.tests.add(pair.testCaseId);
      entry.count += 1;
      byField.set(d.field, entry);
    }
  }
  const endpoints = [...new Set([...fields.keys(), ...reordered.keys()])]
    .sort()
    .map((endpoint) => ({
      endpoint,
      fields: [...(fields.get(endpoint) ?? new Map()).entries()]
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([field, e]) => ({ field, tests: [...e.tests].sort(), count: e.count, example: e.example })),
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
      responsesA: a.length,
      responsesB: b.length,
      matched: pairs.filter((p) => p.a && p.b).length,
      unmatched: pairs.filter((p) => !p.a || !p.b).length,
      differences,
      noiseFields: endpoints.reduce((n, e) => n + e.fields.length, 0),
      unstableOrderLists: endpoints.reduce((n, e) => n + e.unstableOrder.length, 0),
    },
    endpoints,
  });
}

/**
 * The differences between two executions that the noise file does not explain (SPEC §7.6), grouped by
 * test, endpoint and field. Lists the noise file names as unstable in order are matched by key.
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
        wholeFor: new Map(e.fields.filter((f) => WHOLE_RESPONSE_FIELDS.has(f.field)).map((f) => [f.field, new Set(f.tests)])),
        keyed: new Map(e.unstableOrder.map((u) => [u.array, u.key])),
      },
    ]),
  );
  const pairs = matchResponses(a, b);
  let differences = 0;
  let ignored = 0;
  const tests = new Map<string, ResponseComparison['tests'][number]['endpoints']>();
  for (const pair of pairs) {
    const known = noiseBy.get(pair.endpoint);
    const diffs = diffPair(pair, { keyedArrays: (f) => known?.keyed.get(f) });
    differences += diffs.length;
    const isNoise = (field: string) => {
      if (!known) return false;
      if (WHOLE_RESPONSE_FIELDS.has(field)) return known.wholeFor.get(field)?.has(pair.testCaseId) === true;
      return coveredBy(field, known.fields) || known.wholeFor.get('(body)')?.has(pair.testCaseId) === true;
    };
    const kept = diffs.filter((d) => !isNoise(d.field));
    ignored += diffs.length - kept.length;
    if (kept.length === 0) continue;
    const list = tests.get(pair.testCaseId) ?? [];
    tests.set(pair.testCaseId, list);
    list.push({ endpoint: pair.endpoint, occurrence: pair.occurrence, differences: kept.map((d) => ({ field: d.field, path: d.path, base: d.a, other: d.b })) });
  }
  const grouped = [...tests.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([testCaseId, endpoints]) => ({ testCaseId, endpoints }));
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
      remaining: differences - ignored,
      testsWithDifferences: grouped.length,
    },
    tests: grouped,
  });
}

const cell = (v: unknown, max = 160) => {
  const text = typeof v === 'string' ? JSON.stringify(v) : (JSON.stringify(v) ?? 'undefined');
  return (text.length > max ? `${text.slice(0, max)}…` : text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
};

/** The comparison as Markdown: one section per test, a table per endpoint. */
export function comparisonMarkdown(c: ResponseComparison): string {
  const s = c.summary;
  const lines = [
    `# Response comparison ${c.base} → ${c.other}`,
    '',
    `Run \`${c.run}\`; noise file: ${c.noiseFile ? `\`${c.noiseFile}\`` : 'none'}.`,
    '',
    `Matched responses ${s.matched}, unmatched ${s.unmatched}; differences ${s.differences}, ignored as noise ${s.ignoredAsNoise}, **remaining ${s.remaining}** in ${s.testsWithDifferences} tests.`,
  ];
  for (const t of c.tests) {
    lines.push('', `## ${t.testCaseId}`);
    for (const e of t.endpoints) {
      lines.push('', `### ${e.endpoint}${e.occurrence > 1 ? ` (call ${e.occurrence})` : ''}`, '', `| Field | Path | ${c.base} | ${c.other} |`, '|---|---|---|---|');
      for (const d of e.differences) lines.push(`| \`${d.field}\` | \`${d.path}\` | ${cell(d.base)} | ${cell(d.other)} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** The noise file as Markdown: per endpoint the noise fields and the lists matched by key. */
export function noiseMarkdown(n: NoiseFields): string {
  const s = n.summary;
  const lines = [
    `# Noise fields (${n.executions[0]} vs ${n.executions[1]})`,
    '',
    `Run \`${n.run}\` (suite \`${n.sourceRunId}\`). Responses ${s.responsesA} / ${s.responsesB}, matched ${s.matched}, unmatched ${s.unmatched}; ${s.differences} differences in ${s.noiseFields} noise fields; ${s.unstableOrderLists} lists with unstable order.`,
  ];
  for (const e of n.endpoints) {
    lines.push('', `## ${e.endpoint}`);
    if (e.fields.length > 0) {
      lines.push('', '| Field | Tests | Example A | Example B |', '|---|---|---|---|');
      for (const f of e.fields) lines.push(`| \`${f.field}\` | ${f.tests.join(', ')} | ${cell(f.example.a, 80)} | ${cell(f.example.b, 80)} |`);
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

/** Writes runs/<run>/noise-fields.json and noise-fields.md from two recorded executions. */
export async function writeNoiseFile(runDir: string, executions: [string, string]): Promise<{ file: string; noise: NoiseFields }> {
  const [a, b] = await Promise.all(executions.map((x) => responsesOf(runDir, x)));
  const noise = findNoise(a!, b!, { run: path.basename(runDir), sourceRunId: await sourceRunId(runDir), executions });
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
