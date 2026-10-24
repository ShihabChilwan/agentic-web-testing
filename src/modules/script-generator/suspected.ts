import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Prd, ScriptManifest, TestCases, type SuspectedDefect } from '../../shared/schemas.js';

/** The value after "Expected…:" or "Received…:" in a Playwright message (first such line), or null. */
export function messageValue(message: string, which: 'Expected' | 'Received'): string | null {
  const match = new RegExp(`^\\s*${which}[^:\\n]*:[ \\t]*(.+)$`, 'm').exec(message);
  return match?.[1]?.trim() ?? null;
}

/**
 * Test cases whose script reached a locked expectation on the generation version and the app gave something
 * else (outcome assertion_failed, SPEC §6.2): either the test case or the app is wrong. They are not executed,
 * but reported as suspected defects of the current version (SPEC §6.4) instead of being dropped silently.
 */
export function suspectedDefects(manifest: ScriptManifest, testCases: TestCases, prd: Prd | null): SuspectedDefect[] {
  const cases = new Map(testCases.testCases.map((tc) => [tc.id, tc]));
  const statements = new Map((prd?.requirements ?? []).map((r) => [r.id, r.statement]));
  const out: SuspectedDefect[] = [];
  for (const entry of manifest.scripts) {
    if (entry.validationOutcome !== 'assertion_failed') continue;
    const tc = cases.get(entry.testCaseId);
    if (!tc) continue;
    const message = entry.attemptLog.at(-1)?.error ?? '';
    const expectationId = /^Error: (E\d+)\s*$/m.exec(message.split('\n')[0] ?? '')?.[1] ?? null;
    const expectation = tc.expected.find((e) => e.id === expectationId);
    out.push({
      testCaseId: tc.id,
      title: tc.title,
      requirements: tc.requirementIds.map((id) => ({ id, statement: statements.get(id) ?? null })),
      expectationId,
      expectation: expectation?.description ?? null,
      expected: expectation?.value === undefined ? messageValue(message, 'Expected') : JSON.stringify(expectation.value),
      received: messageValue(message, 'Received'),
      message: message.split('\n').slice(0, 12).join('\n'),
    });
  }
  return out;
}

/** The suspected defects of a run folder; empty before the scripts stage has written its manifest. */
export async function readSuspectedDefects(runDir: string): Promise<SuspectedDefect[]> {
  const json = (file: string) => readFile(file, 'utf8').then((t) => JSON.parse(t) as unknown, () => null);
  const manifest = ScriptManifest.safeParse(await json(path.join(runDir, 'scripts', 'manifest.json')));
  const cases = TestCases.safeParse(await json(path.join(runDir, 'testcases.json')));
  if (!manifest.success || !cases.success) return [];
  const prd = Prd.safeParse(await json(path.join(runDir, 'prd.json')));
  return suspectedDefects(manifest.data, cases.data, prd.success ? prd.data : null);
}

/** Lines for a person: one per suspected defect, under a heading that says what they mean. */
export function describeSuspectedDefects(list: readonly SuspectedDefect[]): string[] {
  if (list.length === 0) return [];
  return [
    `Suspected defects in the current version (${list.length}): the app contradicts these locked expectations; the test case or the app is wrong. They are not executed.`,
    ...list.map((d) => {
      const reqs = d.requirements.map((r) => r.id).join(', ');
      const what = d.expectation ? ` "${d.expectation}"` : '';
      return `  ${d.testCaseId} ${d.expectationId ?? '?'} (${reqs})${what}: expected ${d.expected ?? 'unknown'}, got ${d.received ?? 'unknown'}`;
    }),
  ];
}
