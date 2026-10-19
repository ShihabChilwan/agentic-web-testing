import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunBudget } from '../../src/llm/budget.js';
import { appendCallLog, readCallLog } from '../../src/llm/call-log.js';
import { LLMBudgetExceededError } from '../../src/llm/errors.js';
import type { LLMCallLogLine } from '../../src/shared/schemas.js';

const line = (inputTokens: number, outputTokens: number, costUsd: number | null): LLMCallLogLine => ({
  ts: '2026-10-24T10:00:00Z',
  purpose: 'prd',
  provider: 'openai-compatible',
  model: 'm',
  reasoningEffort: 'medium',
  inputTokens,
  outputTokens,
  latencyMs: 10,
  ok: true,
  attempts: 1,
  costUsd,
});

describe('RunBudget', () => {
  it('rebuilds totals from call log lines', () => {
    const budget = RunBudget.fromCallLog({ maxTokens: 1000, maxCostUsd: 1 }, [line(100, 20, null), line(300, 80, 0.25)]);
    expect(budget.tokens).toBe(500);
    expect(budget.costUsd).toBe(0.25);
  });

  it('throws once the token cap is reached', () => {
    const budget = new RunBudget({ maxTokens: 1000, maxCostUsd: 1 });
    budget.add(999, null);
    expect(() => budget.check()).not.toThrow();
    budget.add(1, null);
    expect(() => budget.check()).toThrow(LLMBudgetExceededError);
  });

  it('throws once the cost cap is reached; unpriced calls never count towards it', () => {
    const budget = new RunBudget({ maxTokens: 1_000_000, maxCostUsd: 2 });
    budget.add(100, null);
    expect(() => budget.check()).not.toThrow();
    budget.add(100, 2);
    expect(() => budget.check()).toThrow(/cost cap/);
  });
});

describe('call log', () => {
  it('appends valid lines and reads them back, skipping a cut-off line', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'calllog-')), 'run', 'llm-calls.jsonl');
    await appendCallLog(file, line(1, 2, null));
    await appendCallLog(file, line(3, 4, 0.5));
    await writeFile(file, '{"ts":"2026-10-24T1', { flag: 'a' });
    const { lines, skipped } = await readCallLog(file);
    expect(lines.map((l) => l.inputTokens)).toEqual([1, 3]);
    expect(skipped).toBe(1);
  });

  it('treats a missing file as an empty log', async () => {
    expect(await readCallLog(path.join(tmpdir(), 'does-not-exist', 'llm-calls.jsonl'))).toEqual({ lines: [], skipped: 0 });
  });

  it('refuses to write an invalid line', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'calllog-')), 'llm-calls.jsonl');
    await expect(appendCallLog(file, { ...line(1, 2, null), attempts: 0 })).rejects.toThrow();
  });
});
