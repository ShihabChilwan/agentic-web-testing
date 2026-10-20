import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { PathRejectedError, resolveInRepo, splitLines } from '../../agent/tools/repo-tools.js';
import type { RepoScope } from '../../agent/tools/repo-tools.js';
import type { AgentTool, SubmitSpec } from '../../agent/types.js';
import { PrdApiEndpoint, PrdFeature, PrdRequirement, PrdUiRoute } from '../../shared/schemas.js';
import type { Evidence, Prd } from '../../shared/schemas.js';
import { MAX_BATCH_ITEMS } from './prompt.js';

type Feature = z.infer<typeof PrdFeature>;
type Endpoint = z.infer<typeof PrdApiEndpoint>;
type UiRoute = z.infer<typeof PrdUiRoute>;
type Requirement = z.infer<typeof PrdRequirement>;

/** At most this many problems are listed back to the model; the rest are counted. */
const MAX_LISTED_PROBLEMS = 40;
/** Longest evidence range allowed for an acceptance criterion. */
export const MAX_CRITERION_EVIDENCE_LINES = 100;

export const featureId = (n: number) => `F-${String(n).padStart(2, '0')}`;
export const requirementId = (n: number) => `REQ-${String(n).padStart(3, '0')}`;

export function listProblems(problems: string[]): string[] {
  if (problems.length <= MAX_LISTED_PROBLEMS) return problems;
  return [...problems.slice(0, MAX_LISTED_PROBLEMS), `... and ${problems.length - MAX_LISTED_PROBLEMS} more`];
}

class BatchRejectedError extends Error {
  constructor(readonly problems: string[]) {
    super(
      `Batch rejected; nothing from it was stored. Fix these problems and send the whole batch again:\n${listProblems(problems)
        .map((p) => `- ${p}`)
        .join('\n')}`,
    );
  }
}

/** Checks that evidence points at real files and real line ranges, using the same path rules as the repo tools. */
export class EvidenceChecker {
  private readonly lineCounts = new Map<string, number | string>();

  constructor(private readonly scope: RepoScope) {}

  /** Line count of a file, or the reason it cannot be used as evidence. */
  private async lines(file: string): Promise<number | string> {
    const cached = this.lineCounts.get(file);
    if (cached !== undefined) return cached;
    let result: number | string;
    try {
      const { abs } = await resolveInRepo(this.scope, file);
      if (!(await stat(abs)).isFile()) result = `${file} is a directory, not a file`;
      else {
        const text = await readFile(abs, 'utf8');
        result = text.includes('\u0000') ? `${file} is a binary file` : splitLines(text).length;
      }
    } catch (err) {
      if (!(err instanceof PathRejectedError)) throw err;
      result = /does not exist/.test(err.message) ? `${file} does not exist` : err.message;
    }
    this.lineCounts.set(file, result);
    return result;
  }

  /** File exists and is in scope, range ends within the file and, with `maxLines`, spans at most that many lines. */
  async check(evidence: Evidence[], label: string, { maxLines }: { maxLines?: number } = {}): Promise<string[]> {
    const problems: string[] = [];
    for (const [i, e] of evidence.entries()) {
      const where = `${label}.evidence[${i}]`;
      const lines = await this.lines(e.file);
      if (typeof lines === 'string') problems.push(`${where}: ${lines}`);
      else if (e.lines[1] > lines) {
        problems.push(`${where}: range [${e.lines[0]}, ${e.lines[1]}] ends past the last line of ${e.file} (${lines})`);
      }
      const span = e.lines[1] - e.lines[0] + 1;
      if (maxLines !== undefined && span > maxLines) {
        problems.push(
          `${where}: range [${e.lines[0]}, ${e.lines[1]}] spans ${span} lines (at most ${maxLines}); narrow it to the handler or component that shows the behaviour`,
        );
      }
    }
    return problems;
  }
}

/** Whether an endpoint path is under the API prefix ("" means no prefix). */
function underPrefix(endpointPath: string, prefix: string): boolean {
  if (!prefix) return true;
  const p = prefix.replace(/\/$/, '');
  return endpointPath === p || endpointPath.startsWith(`${p}/`);
}

/** True when a repo-relative file is inside one of the folders. */
export function isUnder(file: string, roots: readonly string[]): boolean {
  const f = path.posix.normalize(file);
  return roots.some((root) => {
    const r = path.posix.normalize(root).replace(/\/$/, '');
    return r === '.' || f === r || f.startsWith(`${r}/`);
  });
}

export interface DraftOptions {
  scope: RepoScope;
  /** backend.apiPrefix; "" means no prefix. */
  apiPrefix: string;
  /** frontend.sourceRoots (or [frontend.cwd]): where page and component source lives. */
  frontendRoots: string[];
}

/**
 * The PRD being built: the agent adds checked batches with the add_* tools and
 * finishes with submit_prd. A batch is stored whole or not at all.
 */
export class PrdDraft {
  readonly features: Feature[] = [];
  readonly apiEndpoints: Endpoint[] = [];
  readonly uiRoutes: UiRoute[] = [];
  readonly requirements: Requirement[] = [];
  private readonly evidence: EvidenceChecker;
  private readonly apiPrefix: string;
  private readonly frontendRoots: string[];

  constructor(options: DraftOptions) {
    this.evidence = new EvidenceChecker(options.scope);
    this.apiPrefix = options.apiPrefix;
    this.frontendRoots = options.frontendRoots;
  }

  private reject(problems: string[]): never {
    throw new BatchRejectedError(problems);
  }

  async addFeatures(items: Feature[]): Promise<string> {
    const problems: string[] = [];
    items.forEach((f, i) => {
      const expected = featureId(this.features.length + i + 1);
      if (f.id !== expected) problems.push(`features[${i}].id: expected ${expected}, got ${f.id}`);
    });
    if (problems.length > 0) this.reject(problems);
    this.features.push(...items);
    return `Stored ${items.length} feature(s): ${items[0]!.id} to ${items.at(-1)!.id}. Next feature id: ${featureId(this.features.length + 1)}.`;
  }

  async addApiEndpoints(items: Endpoint[]): Promise<string> {
    const problems: string[] = [];
    const seen = new Set(this.apiEndpoints.map((e) => `${e.method} ${e.path}`));
    for (const [i, e] of items.entries()) {
      const label = `apiEndpoints[${i}]`;
      if (!underPrefix(e.path, this.apiPrefix)) problems.push(`${label}.path: ${e.path} does not start with ${this.apiPrefix}`);
      const key = `${e.method} ${e.path}`;
      if (seen.has(key)) problems.push(`${label}: ${key} is listed twice`);
      seen.add(key);
      problems.push(...(await this.evidence.check(e.evidence, label)));
    }
    if (problems.length > 0) this.reject(problems);
    this.apiEndpoints.push(...items);
    return `Stored ${items.length} API endpoint(s); ${this.apiEndpoints.length} in total.`;
  }

  async addUiRoutes(items: UiRoute[]): Promise<string> {
    const problems: string[] = [];
    const seen = new Set(this.uiRoutes.map((r) => r.path));
    for (const [i, r] of items.entries()) {
      const label = `uiRoutes[${i}]`;
      if (seen.has(r.path)) problems.push(`${label}: ${r.path} is listed twice`);
      seen.add(r.path);
      problems.push(...(await this.evidence.check(r.evidence, label)));
    }
    if (problems.length > 0) this.reject(problems);
    this.uiRoutes.push(...items);
    return `Stored ${items.length} UI route(s); ${this.uiRoutes.length} in total.`;
  }

  async addRequirements(items: Requirement[]): Promise<string> {
    const problems: string[] = [];
    const features = new Set(this.features.map((f) => f.id));
    for (const [i, r] of items.entries()) {
      const label = `requirements[${i}]`;
      const expected = requirementId(this.requirements.length + i + 1);
      if (r.id !== expected) problems.push(`${label}.id: expected ${expected}, got ${r.id}`);
      if (!features.has(r.featureId)) problems.push(`${label}.featureId: ${r.featureId} is not a feature; add it with add_features first`);
      for (const [j, c] of r.acceptanceCriteria.entries()) {
        problems.push(
          ...(await this.evidence.check(c.evidence, `${label}.acceptanceCriteria[${j}]`, { maxLines: MAX_CRITERION_EVIDENCE_LINES })),
        );
      }
      const citesFrontend = r.acceptanceCriteria.some((c) => c.evidence.some((e) => isUnder(e.file, this.frontendRoots)));
      if (r.layer !== 'api' && !citesFrontend) {
        problems.push(
          `${label}: ${r.layer === 'e2e' ? 'an e2e' : 'a ui'} requirement needs at least one criterion whose evidence is in the frontend source (${this.frontendRoots.join(', ')}); read the page component and cite the code that shows this, not only route definitions or server code`,
        );
      }
    }
    if (problems.length > 0) this.reject(problems);
    this.requirements.push(...items);
    return `Stored ${items.length} requirement(s): ${items[0]!.id} to ${items.at(-1)!.id}. Next requirement id: ${requirementId(this.requirements.length + 1)}.`;
  }

  /** Problems that stop the document from being finished. */
  completeness(): string[] {
    const problems: string[] = [];
    if (this.features.length === 0) problems.push('No features recorded yet; use add_features.');
    if (this.requirements.length === 0) problems.push('No requirements recorded yet; use add_requirements.');
    return problems;
  }

  toPrd(header: Pick<Prd, 'target' | 'sourceRef' | 'generatedAt'>, final: SubmitInput): Prd {
    return {
      schemaVersion: '1.0',
      ...header,
      features: this.features,
      apiEndpoints: this.apiEndpoints,
      uiRoutes: this.uiRoutes,
      requirements: this.requirements,
      assumptions: final.assumptions,
      openQuestions: final.openQuestions,
    };
  }
}

const batch = <T extends z.ZodType>(item: T) => z.array(item).min(1).max(MAX_BATCH_ITEMS);

export const SubmitInput = z.object({
  assumptions: z.array(z.string().min(1)).describe('Inferred but unconfirmed facts, and untestable behaviour'),
  openQuestions: z.array(z.string().min(1)).describe('Where intended behaviour is unclear or code and names disagree'),
});
export type SubmitInput = z.infer<typeof SubmitInput>;

export const RECORDING_TOOLS: readonly string[] = ['add_features', 'add_api_endpoints', 'add_ui_routes', 'add_requirements'];

/** The four add_* tools. They write into the draft and do not count toward the tool budget. */
export function createDraftTools(draft: PrdDraft) {
  const tools = [
    {
      name: 'add_features',
      description: 'Record features (main areas of functionality). Ids continue from the last stored one.',
      input: z.object({ features: batch(PrdFeature) }),
      run: (i: { features: Feature[] }) => draft.addFeatures(i.features),
    },
    {
      name: 'add_api_endpoints',
      description: 'Record API endpoints with method, full path, auth, request shape, responses and evidence.',
      input: z.object({ endpoints: batch(PrdApiEndpoint) }),
      run: (i: { endpoints: Endpoint[] }) => draft.addApiEndpoints(i.endpoints),
    },
    {
      name: 'add_ui_routes',
      description: 'Record frontend page routes with a summary, auth and evidence.',
      input: z.object({ routes: batch(PrdUiRoute) }),
      run: (i: { routes: UiRoute[] }) => draft.addUiRoutes(i.routes),
    },
    {
      name: 'add_requirements',
      description: 'Record requirements. Each links to an already recorded feature; ids continue from the last stored one.',
      input: z.object({ requirements: batch(PrdRequirement) }),
      run: (i: { requirements: Requirement[] }) => draft.addRequirements(i.requirements),
    },
  ];
  return tools.map((t) => ({ ...t, countsTowardBudget: false })) as AgentTool<unknown>[];
}

export function createSubmit(draft: PrdDraft): SubmitSpec<SubmitInput> {
  return {
    name: 'submit_prd',
    description: 'Finish the document: give the assumptions and open questions. Everything else must already be recorded with the add_* tools.',
    schema: SubmitInput,
    validate: () => listProblems(draft.completeness()),
  };
}
