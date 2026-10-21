import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AgentTool } from '../../agent/types.js';
import { trimDom } from '../script-generator/dry-run.js';
import { RequirementId, ScriptTestId } from '../../shared/schemas.js';
import type { ExecutionResults, Prd, TestCase, TestResult } from '../../shared/schemas.js';
import type { EnvironmentSummary } from './triage.js';

export const MAX_ARTIFACT_CHARS = 20_000;
const MAX_ERROR_CHARS = 8_000;
const MAX_LOG_TAIL = 400;
const MAX_LOG_HITS = 200;

/** Everything the analyzer's tools may read: one execution and the run's PRD, test cases and scripts (SPEC §8.4). */
export interface AnalysisContext {
  /** runs/<runId>/executions/<execId>/ */
  execDir: string;
  /** The run's scripts/ folder. */
  scriptsDir: string;
  results: ExecutionResults;
  environment: EnvironmentSummary;
  testCases: ReadonlyMap<string, TestCase>;
  prd: Prd;
}

const ARTIFACT_KINDS = ['network', 'console', 'dom', 'lastResponse', 'serverLog'] as const;
type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** Logs and request lists matter most at their end; documents at their start. */
const KEEP_END: ReadonlySet<ArtifactKind> = new Set(['network', 'console', 'serverLog']);

const firstLine = (text: string) => text.split('\n').find((l) => l.trim() !== '')?.trim().slice(0, 200) ?? '';

function cut(text: string, max: number, fromEnd: boolean): string {
  if (text.length <= max) return text;
  return fromEnd
    ? `[${text.length - max} earlier characters left out]\n${text.slice(-max)}`
    : `${text.slice(0, max)}\n[${text.length - max} more characters left out]`;
}

/**
 * The analyzer's tools (SPEC §8.2). Every input is an id, an enum or a number, never a path: the tools
 * build their paths inside the execution folder and the run's scripts folder, so nothing else is reachable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createAnalyzerTools(ctx: AnalysisContext): AgentTool<any>[] {
  const failing = new Map<string, TestResult>(ctx.results.results.filter((r) => r.status !== 'passed').map((r) => [r.testCaseId, r]));
  const failure = (id: string) => {
    const result = failing.get(id);
    if (!result) throw new Error(`${id} is not a failing test of this execution; list_failures shows them`);
    return result;
  };
  const kindsOf = (r: TestResult) => ARTIFACT_KINDS.filter((k) => r.artifacts[k] !== undefined);

  const listFailures: AgentTool<Record<string, never>> = {
    name: 'list_failures',
    description: 'All failing tests of this execution: id, status (failed: a check failed; errored: the test could not finish), category and the first line of the error.',
    input: z.strictObject({}),
    run: async () =>
      [...failing.values()]
        .map((r) => `${r.testCaseId} [${r.status}${r.error?.expectationId ? ` ${r.error.expectationId}` : ''}, ${r.error?.category ?? 'unknown'}] ${firstLine(r.error?.message ?? '')}`)
        .join('\n') || 'No failing tests.',
  };

  const getFailure: AgentTool<{ testCaseId: string }> = {
    name: 'get_failure',
    description: 'One failing test: its test case (steps and expected results), the script source, the full error, whether its data was restored before it ran, and which artifacts exist.',
    input: z.strictObject({ testCaseId: ScriptTestId }),
    run: async ({ testCaseId }) => {
      const result = failure(testCaseId);
      const testCase = ctx.testCases.get(testCaseId);
      const script = await readFile(path.join(ctx.scriptsDir, `${testCaseId}.spec.ts`), 'utf8').catch(() => '(script not found)');
      return [
        `# ${testCaseId}: ${result.status}${result.error?.expectationId ? ` at ${result.error.expectationId}` : ''} (${result.error?.category ?? 'unknown'}), ${result.durationMs} ms`,
        `Isolated (data restored before it ran): ${result.isolated ? 'yes' : 'no'}`,
        `Artifacts: ${kindsOf(result).join(', ') || 'none'}`,
        '',
        '## Test case',
        testCase ? JSON.stringify(testCase, null, 2) : '(not in testcases.json)',
        '',
        '## Script',
        script,
        '',
        '## Error',
        cut(result.error?.message ?? '(no message)', MAX_ERROR_CHARS, false),
      ].join('\n');
    },
  };

  const getRequirement: AgentTool<{ id: string }> = {
    name: 'get_requirement',
    description: 'A requirement from the requirements document (statement, acceptance criteria with code references) and its feature.',
    input: z.strictObject({ id: RequirementId }),
    run: async ({ id }) => {
      const requirement = ctx.prd.requirements.find((r) => r.id === id);
      if (!requirement) return `Error: no requirement ${id}.`;
      const feature = ctx.prd.features.find((f) => f.id === requirement.featureId);
      return JSON.stringify({ ...requirement, feature: feature ? { id: feature.id, name: feature.name, description: feature.description } : null }, null, 2);
    },
  };

  const readArtifact: AgentTool<{ testCaseId: string; kind: ArtifactKind; maxBytes?: number }> = {
    name: 'read_artifact',
    description:
      'A text artifact of a failing test: network (requests and statuses), console (browser console), dom (page HTML at the failure, scripts and styles removed), lastResponse (the last API response), serverLog (backend log lines written during that test).',
    input: z.strictObject({
      testCaseId: ScriptTestId,
      kind: z.enum(ARTIFACT_KINDS),
      maxBytes: z.number().int().min(500).max(MAX_ARTIFACT_CHARS).optional(),
    }),
    run: async ({ testCaseId, kind, maxBytes }) => {
      const result = failure(testCaseId);
      const rel = result.artifacts[kind];
      if (!rel) return `Error: ${testCaseId} has no ${kind} artifact. It has: ${kindsOf(result).join(', ') || 'none'}.`;
      const raw = await readFile(path.join(ctx.execDir, 'artifacts', testCaseId, path.posix.basename(rel)), 'utf8');
      const text = kind === 'dom' ? trimDom(raw, Number.MAX_SAFE_INTEGER) : raw;
      return cut(text, maxBytes ?? MAX_ARTIFACT_CHARS, KEEP_END.has(kind)) || '(empty)';
    },
  };

  const getEnvironment: AgentTool<Record<string, never>> = {
    name: 'get_environment',
    description: 'How the app started: health checks, seed requests, the seed data check, incidents during the run (crashes, restarts, failed data restores) and tests that ran without a data restore.',
    input: z.strictObject({}),
    run: async () => JSON.stringify(ctx.environment, null, 2),
  };

  const readServerLog: AgentTool<{ name: 'backend' | 'frontend'; search?: string; tail?: number }> = {
    name: 'read_server_log',
    description: `The backend or frontend log of the whole execution: the last "tail" lines (default 100, at most ${MAX_LOG_TAIL}), or up to ${MAX_LOG_HITS} lines matching "search" (a regular expression, case-insensitive).`,
    input: z.strictObject({
      name: z.enum(['backend', 'frontend']),
      search: z.string().min(1).max(200).optional(),
      tail: z.number().int().min(1).max(MAX_LOG_TAIL).optional(),
    }),
    run: async ({ name, search, tail }) => {
      const text = await readFile(path.join(ctx.execDir, 'server', `${name}.log`), 'utf8').catch(() => null);
      if (text === null) return `Error: there is no ${name} log.`;
      const lines = text.split('\n');
      if (search) {
        let pattern: RegExp;
        try {
          pattern = new RegExp(search, 'i');
        } catch (err) {
          return `Error: invalid regular expression: ${err instanceof Error ? err.message : String(err)}`;
        }
        const hits = lines.flatMap((l, i) => (pattern.test(l) ? [`${i + 1}: ${l.slice(0, 500)}`] : []));
        const shown = hits.slice(0, MAX_LOG_HITS).join('\n');
        return hits.length === 0 ? 'No matching lines.' : `${shown}${hits.length > MAX_LOG_HITS ? `\n[${hits.length - MAX_LOG_HITS} more matches]` : ''}`;
      }
      const n = tail ?? 100;
      const start = Math.max(0, lines.length - n);
      return cut(lines.slice(start).map((l, i) => `${start + i + 1}: ${l}`).join('\n'), MAX_ARTIFACT_CHARS, true);
    },
  };

  return [listFailures, getFailure, getRequirement, readArtifact, getEnvironment, readServerLog];
}
