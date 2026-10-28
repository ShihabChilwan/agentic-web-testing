import path from 'node:path';
import { isHidden, splitLines } from '../../agent/tools/repo-tools.js';
import type { RepoScope } from '../../agent/tools/repo-tools.js';
import { showFile } from '../../shared/git.js';
import type { Prd, PrdRequirement, TargetConfig, TargetFacts } from '../../shared/schemas.js';
import { hasFrontend, uiBaseUrl } from '../../shared/target-ui.js';
import type { Grounding } from './checks.js';

/** Characters of evidence code inserted into one call (about 10k tokens). */
export const EVIDENCE_CHAR_CAP = 40_000;
/** Characters of observed facts inserted into one call. */
export const FACTS_CHAR_CAP = 12_000;

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 } as const;

/** Reads a file's lines at the generation commit; null when it is missing or hidden. */
export type ReadLines = (file: string) => Promise<string[] | null>;

/** Reads with `git show <commit>:<path>` so the working tree is never touched; respects the repo tools' hidden paths. */
export function linesAtCommit(scope: RepoScope, commit: string): ReadLines {
  const cache = new Map<string, Promise<string[] | null>>();
  return (file) => {
    if (isHidden(file, scope)) return Promise.resolve(null);
    let lines = cache.get(file);
    if (!lines) {
      lines = showFile(scope.root, commit, file).then((text) => (text === null ? null : splitLines(text)));
      cache.set(file, lines);
    }
    return lines;
  };
}

export interface EvidenceBlock {
  file: string;
  start: number;
  end: number;
  /** The code lines, without line numbers. */
  lines: string[];
  /** Set for a whole file included because a cited file imports it. */
  importedBy?: string;
  /** Set for frontend code that calls an endpoint (e.g. "POST /api/items"), to show the request shape. */
  calls?: string;
  /** Set for markup that sends the request as a form: the encoding the app's own page uses (SPEC §6.2). */
  encoding?: 'form' | 'multipart';
}

export interface CodeExcerpts {
  blocks: EvidenceBlock[];
  /** `file:start-end` ranges left out because of the size cap or because the file could not be read. */
  omitted: string[];
}

const render = (b: EvidenceBlock) =>
  `### ${b.file} ${b.importedBy ? `(whole file, imported by ${b.importedBy})` : `lines ${b.start}-${b.end}`}\n${b.lines.map((l, i) => `${b.start + i}: ${l}`).join('\n')}`;

/** Extensions tried for an import without one, then index files; non-code imports (styles, images) are skipped. */
const CODE_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json'];
const NON_CODE_EXTENSIONS = new Set(
  ['.css', '.scss', '.sass', '.less', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.woff', '.woff2', '.ttf', '.eot', '.html', '.md'],
);
const IMPORT_PATTERNS = [
  /\brequire\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
  /\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
  /\b(?:import|export)\s[^'";]*?\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g,
  /\bimport\s*['"](\.{1,2}\/[^'"]+)['"]/g,
];

/** Relative module paths a file imports (`require`, `import ... from`, dynamic `import()`, `export ... from`). */
export function relativeImports(source: string): string[] {
  const found = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) for (const m of source.matchAll(pattern)) found.add(m[1]!);
  return [...found];
}

/** The repo file an import refers to, or null (outside the repo, not code, or not in the commit). */
export async function resolveImport(fromFile: string, spec: string, read: ReadLines): Promise<string | null> {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  if (base.startsWith('..')) return null;
  const ext = path.posix.extname(base).toLowerCase();
  if (NON_CODE_EXTENSIONS.has(ext)) return null;
  const candidates = CODE_EXTENSIONS.includes(ext)
    ? [base]
    : [...CODE_EXTENSIONS.map((e) => base + e), ...CODE_EXTENSIONS.map((e) => `${base}/index${e}`)];
  for (const candidate of candidates) if (await read(candidate)) return candidate;
  return null;
}

/**
 * The criteria's evidence for a set of requirements: ranges merged per file (overlapping or adjacent
 * ranges become one), added in order of the highest priority citing them until the size cap is reached.
 * Then, within the same cap, every file a cited file imports by a relative path (one level, whole file),
 * so shared code such as authentication middleware is visible too.
 */
export async function collectEvidence(
  requirements: PrdRequirement[],
  read: ReadLines,
  capChars: number = EVIDENCE_CHAR_CAP,
): Promise<CodeExcerpts> {
  const ranges = new Map<string, Array<{ start: number; end: number; rank: number }>>();
  for (const r of requirements) {
    for (const c of r.acceptanceCriteria) {
      for (const e of c.evidence) {
        const list = ranges.get(e.file) ?? [];
        list.push({ start: e.lines[0], end: e.lines[1], rank: PRIORITY_RANK[r.priority] });
        ranges.set(e.file, list);
      }
    }
  }

  const merged: Array<{ file: string; start: number; end: number; rank: number }> = [];
  for (const [file, list] of ranges) {
    list.sort((a, b) => a.start - b.start);
    let current: { file: string; start: number; end: number; rank: number } | undefined;
    for (const r of list) {
      if (current && r.start <= current.end + 1) {
        current.end = Math.max(current.end, r.end);
        current.rank = Math.min(current.rank, r.rank);
      } else {
        current = { file, ...r };
        merged.push(current);
      }
    }
  }
  merged.sort((a, b) => a.rank - b.rank || a.file.localeCompare(b.file) || a.start - b.start);

  const blocks: EvidenceBlock[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const m of merged) {
    const fileLines = await read(m.file);
    if (!fileLines) {
      omitted.push(`${m.file}:${m.start}-${m.end}`);
      continue;
    }
    const block: EvidenceBlock = { file: m.file, start: m.start, end: m.end, lines: fileLines.slice(m.start - 1, m.end) };
    const size = render(block).length;
    if (used + size > capChars) {
      omitted.push(`${m.file}:${m.start}-${m.end}`);
      continue;
    }
    used += size;
    blocks.push(block);
  }

  // One level of relative imports of the cited files, whole files, after all cited ranges.
  const cited = new Set(ranges.keys());
  const imported = new Map<string, string>();
  for (const file of [...cited].sort()) {
    const lines = await read(file);
    if (!lines) continue;
    for (const spec of relativeImports(lines.join('\n'))) {
      const target = await resolveImport(file, spec, read);
      if (target && !cited.has(target) && !imported.has(target)) imported.set(target, file);
    }
  }
  for (const [file, importedBy] of imported) {
    const lines = await read(file);
    if (!lines || lines.length === 0) continue;
    const block: EvidenceBlock = { file, start: 1, end: lines.length, lines, importedBy };
    const size = render(block).length;
    if (used + size > capChars) {
      omitted.push(`${file} (imported by ${importedBy})`);
      continue;
    }
    used += size;
    blocks.push(block);
  }

  blocks.sort((a, b) => Number(Boolean(a.importedBy)) - Number(Boolean(b.importedBy)) || a.file.localeCompare(b.file) || a.start - b.start);
  return { blocks, omitted };
}

/** Every string, number and boolean in the fixtures, as text. */
export function fixtureValues(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'object') return Object.values(value).flatMap(fixtureValues);
  return [String(value)];
}

/**
 * The code text an `expected[].value` may come from: the inserted evidence code (without line numbers),
 * fixture values, the API prefix and the base URLs. Requirement text is model-written and does not count.
 */
export function groundingText(evidence: CodeExcerpts, config: TargetConfig): string {
  return [
    ...evidence.blocks.flatMap((b) => b.lines),
    ...fixtureValues(config.fixtures),
    config.backend.apiPrefix,
    config.backend.baseUrl,
    uiBaseUrl(config),
  ].join('\n');
}

/** Every string in a fact body (including a text body). Numbers and booleans are not collected. */
function factStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(factStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(factStrings);
  return [];
}

/** All grounding sources for one session: code text, plus status codes and strings observed on golden. */
export function buildGrounding(evidence: CodeExcerpts, config: TargetConfig, facts: TargetFacts | null): Grounding {
  return {
    code: groundingText(evidence, config),
    factStatuses: [...new Set((facts?.facts ?? []).map((f) => f.status))],
    factStrings: (facts?.facts ?? []).flatMap((f) => factStrings(f.body)),
  };
}

/** The facts as text for the task, up to the cap; facts that do not fit are named. */
export function renderFacts(facts: TargetFacts, capChars: number = FACTS_CHAR_CAP): string {
  const lines: string[] = [];
  const left: string[] = [];
  let used = 0;
  for (const f of facts.facts) {
    const line = `- ${f.name}: ${f.request.method} ${f.request.path} (${f.request.as ? `logged in as ${f.request.as}` : 'no login'}) → status ${f.status}${f.truncated ? ', trimmed' : ''}\n  ${JSON.stringify(f.body)}`;
    if (used + line.length > capChars) {
      left.push(f.name);
      continue;
    }
    used += line.length;
    lines.push(line);
  }
  if (left.length > 0) lines.push(`[left out because of the size limit: ${left.join(', ')}]`);
  return lines.join('\n');
}

/** Characters of one endpoint's request shape in the index. */
const REQUEST_SHAPE_CHARS = 220;

/** The PRD's request shape of an endpoint (body, query, params) as one compact line, or null when it records none. */
export function requestShape(e: Prd['apiEndpoints'][number]): string | null {
  const request = e.request;
  if (!request) return null;
  const parts = (['body', 'query', 'params'] as const).flatMap((k) => (request[k] === undefined || request[k] === null ? [] : [`${k} ${JSON.stringify(request[k])}`]));
  if (parts.length === 0) return null;
  const text = parts.join('; ');
  return text.length > REQUEST_SHAPE_CHARS ? `${text.slice(0, REQUEST_SHAPE_CHARS - 1)}…` : text;
}

/** Every API endpoint of the PRD, one line each, with the request shape the handler reads, as setup steps may use them. */
export function renderEndpointIndex(endpoints: Prd['apiEndpoints']): string {
  return endpoints
    .map((e) => {
      const summary = e.summary.length > 80 ? `${e.summary.slice(0, 79)}…` : e.summary;
      const shape = requestShape(e);
      return `- ${e.method} ${e.path} (${e.authRequired ? 'login required' : 'public'}): ${summary}${shape ? `\n  sends: ${shape}` : ''}`;
    })
    .join('\n');
}

export interface FeatureTaskInput {
  feature: { id: string; name: string; description: string };
  requirements: PrdRequirement[];
  quota: number;
  evidence: CodeExcerpts;
  config: TargetConfig;
  /** facts.json of the target, when there is one. */
  facts?: TargetFacts | null;
  /** All API endpoints of the PRD (the endpoint index). */
  endpoints?: Prd['apiEndpoints'];
  /** Set for the gap round: these requirements got no test case and no decline the first time. */
  gapRound?: boolean;
  /** Gap round only: the problems of the failed first session's last submit. */
  previousProblems?: string[];
  /** The PRD's page routes; a ui test case names the page it opens by one of these paths. */
  pages?: Prd['uiRoutes'];
  /** Set for the page round: pages no test case opens yet, which these requirements name. */
  pageRound?: string[];
  /** The rendered snapshots of these requirements' pages (see pages.ts), or null. */
  pageSnapshots?: string | null;
  /** Set for the endpoint round (gaps stage): "METHOD /path" of endpoints no passing test reached, which these requirements describe. */
  endpointRound?: string[];
}

/** The user message for one feature session. */
export function buildFeatureTask(input: FeatureTaskInput): string {
  const { feature, requirements, quota, evidence, config } = input;
  const reqText = requirements
    .map((r) => {
      const criteria = r.acceptanceCriteria
        .map((c, i) => `   ${i + 1}. ${c.text} (evidence: ${c.evidence.map((e) => `${e.file}:${e.lines[0]}-${e.lines[1]}`).join(', ')})`)
        .join('\n');
      return `- ${r.id} [layer ${r.layer}, priority ${r.priority}]: ${r.statement}\n${criteria}`;
    })
    .join('\n');
  const disabled = Object.keys(config.backend.disabledServices);
  const parts = [
    input.endpointRound
      ? `Measured with code coverage, no test reaches these endpoints yet: ${input.endpointRound.join(', ')}. Write api test cases for the requirements below that call them (send the request in a step, e.g. "Send ${input.endpointRound[0]}", with real values for path parameters, creating the data first when none exists) and check what they return, or decline a requirement whose endpoint cannot be tested.`
      : input.pageRound
      ? `No test case opens these pages yet: ${input.pageRound.join(', ')}. Write ui test cases for the requirements below that open them (name the page by its path in a step, e.g. "Open ${input.pageRound[0]}") and check what the page shows, or decline a requirement whose page cannot be tested.`
      : input.gapRound
        ? `These requirements of feature ${feature.id} got no test case and no decline yet. Write test cases for them, or decline each one you cannot test.`
        : `Write test cases for feature ${feature.id}.`,
    `Feature ${feature.id}: ${feature.name}. ${feature.description}`,
    `## Requirements (write test cases only for these)\n${reqText}`,
    `## Limits\nAt most ${quota} test cases in this submission, and at most 4 per requirement.`,
    [
      '## Environment',
      `- Frontend base URL: ${uiBaseUrl(config)}${hasFrontend(config) ? '' : ' (the same server as the backend)'}`,
      `- Backend base URL: ${config.backend.baseUrl}`,
      `- API path prefix: ${config.backend.apiPrefix || '(none)'}`,
      `- Disabled third-party services (configuration keys): ${disabled.length > 0 ? disabled.join(', ') : 'email, payments, OAuth, external storage'}`,
      '- Fixture data that exists before every test. Use only these; refer to them by path in fixturesUsed (e.g. users.<name>):',
      '```json',
      JSON.stringify(config.fixtures, null, 2),
      '```',
    ].join('\n'),
    `## Code that implements these requirements, and the files it imports\n${evidence.blocks.map(render).join('\n\n') || '(none could be read)'}`,
  ];
  const pages = (input.pages ?? []).filter((p) => !p.path.includes('*')); // a catch-all cannot be opened
  if (pages.length > 0) {
    parts.push(
      `## Pages of the frontend\nA ui test case names the page it opens by its path from this list, in a step such as "Open /path" (with the real value for a parameter such as :id).\n${pages.map((p) => `- ${p.path}${p.authRequired ? ' (login required)' : ''}: ${p.summary.length > 80 ? `${p.summary.slice(0, 79)}…` : p.summary}`).join('\n')}`,
    );
  }
  if (input.pageSnapshots) parts.push(input.pageSnapshots);
  if (input.endpoints && input.endpoints.length > 0) {
    parts.push(
      `## Endpoints you may use in steps to set up data\nAny of these may be called to create or prepare data (a setup step). "sends" is the request shape the handler reads (a body field holding an object is written as a nested object, e.g. { "category": { … } }). Expected values still have to come from the code, fixtures or observed facts.\n${renderEndpointIndex(input.endpoints)}`,
    );
  }
  if (input.facts && input.facts.facts.length > 0) {
    parts.push(
      `## Facts observed on the running application (golden version, after the standard seed)\nThese requests were sent to the application before any test ran; the data they show exists at the start of every test. Status codes and text values shown here may be used as expected values.\n${renderFacts(input.facts)}`,
    );
  }
  if (input.previousProblems && input.previousProblems.length > 0) {
    const listed = input.previousProblems.slice(0, 20).map((p) => `- ${p}`);
    if (input.previousProblems.length > 20) listed.push(`- ... and ${input.previousProblems.length - 20} more`);
    parts.splice(
      1,
      0,
      `## An earlier attempt for these requirements was rejected\nDo not repeat these problems:\n${listed.join('\n')}`,
    );
  }
  if (evidence.omitted.length > 0) {
    parts.push(`[omitted because of the size limit or unreadable: ${evidence.omitted.join(', ')}]`);
  }
  return parts.join('\n\n');
}
