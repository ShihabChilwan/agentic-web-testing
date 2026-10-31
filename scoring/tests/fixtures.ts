import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Diagnoses, EvalMapping, ExecutionResults, Variants } from '../../src/shared/schemas.js';
import type { Classification } from '../../src/shared/schemas.js';

const HASH = 'a'.repeat(64);
const NOW = '2026-11-01T10:00:00.000Z';

export interface FakeDiagnosis {
  tests: string[];
  classification: Classification;
  confidence: number;
  location?: { file: string; lines: [number, number] };
  costUsd?: number;
}

export interface FakeVersion {
  /** Test id → status; every listed test ran. */
  tests: Record<string, 'passed' | 'failed' | 'errored'>;
  /** Undefined: never analysed. */
  diagnoses?: FakeDiagnosis[];
  durationMs?: number;
  /** The cloud task failed before it ran. */
  failedTask?: boolean;
}

export const code = (id: string, file: string, lines: [number, number]) => ({
  id,
  kind: 'code' as const,
  patch: `variants/${id}.patch`,
  layer: 'backend' as const,
  mutator: null,
  strykerMutantId: null,
  file,
  lines,
  original: 'a',
  mutated: 'b',
  expectedClassification: 'app_defect' as const,
});

export const env = (id: string) => ({ id, kind: 'environment' as const, skipSeed: false, description: 'x', expectedClassification: 'environment_issue' as const });

export function variantsFile(variants: Array<ReturnType<typeof code> | ReturnType<typeof env>>) {
  return Variants.parse({
    schemaVersion: '1.0',
    target: 'fake',
    goldenRef: 'golden',
    goldenCommit: 'abc1234',
    method: 'manual',
    seed: null,
    variants,
  });
}

/** Writes one imported-run folder: eval/mapping.json and executions/<x-NN>/{results,diagnoses}.json, all validated. */
export async function writeSuite(versions: Record<string, FakeVersion>, repeatId = 'eval-test-1'): Promise<{ dir: string; remove: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'awt-scoring-test-'));
  const mapping: unknown[] = [];
  let n = 0;
  for (const [version, v] of Object.entries(versions)) {
    if (v.failedTask) {
      mapping.push({ version, execId: null, outcome: 'failed', durationMs: 1000, peakMemoryBytes: null });
      continue;
    }
    const execId = `x-${String(++n).padStart(2, '0')}`;
    mapping.push({ version, execId, outcome: 'done', durationMs: v.durationMs ?? 60_000, peakMemoryBytes: null });
    const execDir = path.join(dir, 'executions', execId);
    await mkdir(execDir, { recursive: true });
    const results = Object.entries(v.tests).map(([testCaseId, status]) => ({ testCaseId, status, durationMs: 10, artifacts: {} }));
    const parsed = ExecutionResults.parse({
      schemaVersion: '1.0',
      execId,
      startedAt: NOW,
      finishedAt: NOW,
      environment: { healthChecks: [], seed: [] },
      summary: { total: results.length, passed: results.filter((r) => r.status === 'passed').length, failed: 0, errored: 0 },
      results,
    });
    await writeFile(path.join(execDir, 'results.json'), JSON.stringify(parsed));
    if (v.diagnoses) {
      const diagnoses = v.diagnoses.map((d, i) => ({
        id: `DX-${String(i + 1).padStart(3, '0')}`,
        testCaseIds: d.tests,
        classification: d.classification,
        confidence: d.confidence,
        summary: 's',
        rootCause: 'r',
        ...(d.location ? { location: d.location } : {}),
        evidence: [],
        violatedRequirementIds: [],
        toolCalls: 0,
        durationMs: 1000,
      }));
      const costUsd = v.diagnoses.reduce((a, d) => a + (d.costUsd ?? 0), 0);
      const doc = Diagnoses.parse({
        schemaVersion: '1.0',
        execId,
        mode: 'full',
        generatedAt: NOW,
        diagnoses,
        summary: { groups: diagnoses.length, sessions: diagnoses.length, failedSessions: 0, calls: 1, toolCalls: 0, costUsd, durationMs: 1000 * diagnoses.length },
      });
      await writeFile(path.join(execDir, 'diagnoses.json'), JSON.stringify(doc));
    }
  }
  await mkdir(path.join(dir, 'eval'), { recursive: true });
  await writeFile(
    path.join(dir, 'eval', 'mapping.json'),
    JSON.stringify(EvalMapping.parse({ schemaVersion: '1.0', repeatId, sourceRunId: 'fake-20261101-100000', imageTag: 'abc1234-deadbeef', suiteHash: HASH, importedAt: NOW, versions: mapping })),
  );
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
}
