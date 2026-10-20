import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BUDGET_EXHAUSTED_MESSAGE,
  NUDGE_MESSAGE,
  OUT_OF_SPACE_MESSAGE,
  outputLimit,
  runAgent,
  TOOL_OUTPUT_LIMIT,
  wrapUpMessage,
} from '../../src/agent/runtime.js';
import { TRIMMED_PLACEHOLDER } from '../../src/agent/context-guard.js';
import { AgentBudgetError, AgentSubmitError } from '../../src/agent/types.js';
import type { AgentTool, RunAgentOptions } from '../../src/agent/types.js';
import { FakeLLMClient } from '../../src/llm/fake.js';
import type { Message, ProviderRequest, ToolResultBlock } from '../../src/llm/types.js';

const Output = z.object({ answer: z.string().min(1) });
type Output = z.infer<typeof Output>;

const echo: AgentTool<{ text: string }> = {
  name: 'echo',
  description: 'Echoes text',
  input: z.object({ text: z.string() }),
  run: async ({ text }) => `echo: ${text}`,
};

function options(overrides: Partial<RunAgentOptions<Output>> = {}): RunAgentOptions<Output> {
  return {
    purpose: 'test',
    system: 'You are a test agent.',
    task: 'Find the answer.',
    tools: [echo],
    submit: { name: 'submit_answer', description: 'Submit the answer', schema: Output },
    budget: { maxToolCalls: 5 },
    ...overrides,
  };
}

const deps = (llm: FakeLLMClient, extra: { transcriptDir?: string; contextTokens?: number } = {}) => ({
  llm,
  contextTokens: extra.contextTokens ?? 131_072,
  ...(extra.transcriptDir ? { transcriptDir: extra.transcriptDir } : {}),
});

const submit = (input: unknown) => FakeLLMClient.toolCall('submit_answer', input);
const callEcho = (text: string) => FakeLLMClient.toolCall('echo', { text });

/** Tool results the model saw in its last request. */
function lastToolResults(req: ProviderRequest | undefined): ToolResultBlock[] {
  const last = req?.messages.at(-1);
  return last?.role === 'user' ? last.content.filter((b): b is ToolResultBlock => b.type === 'tool_result') : [];
}
function lastUserText(req: ProviderRequest | undefined): string[] {
  const last = req?.messages.at(-1);
  return last?.role === 'user' ? last.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])) : [];
}

describe('runAgent: tools and submit', () => {
  it('runs tools, returns their output, and ends on a valid submit', async () => {
    const llm = new FakeLLMClient([callEcho('hi'), submit({ answer: '42' })]);
    const result = await runAgent(options(), deps(llm));
    expect(result.output).toEqual({ answer: '42' });
    expect(result.toolCalls).toBe(1);
    expect(result.turns).toBe(2);
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 40 });
    expect(lastToolResults(llm.requests[1])).toEqual([{ type: 'tool_result', toolCallId: 'call-1', content: 'echo: hi' }]);
  });

  it('offers the tools plus the submit tool, as JSON Schema', async () => {
    const llm = new FakeLLMClient([submit({ answer: 'x' })]);
    await runAgent(options(), deps(llm));
    const tools = llm.requests[0]?.tools ?? [];
    expect(tools.map((t) => t.name)).toEqual(['echo', 'submit_answer']);
    expect(tools[1]?.inputSchema).toMatchObject({ type: 'object', properties: { answer: { type: 'string' } } });
    expect(tools[1]?.inputSchema).not.toHaveProperty('$schema');
  });

  it('works with no tools: only the submit tool is offered', async () => {
    const llm = new FakeLLMClient([submit({ answer: 'x' })]);
    const result = await runAgent(options({ tools: [] }), deps(llm));
    expect(llm.requests[0]?.tools?.map((t) => t.name)).toEqual(['submit_answer']);
    expect(result.toolCalls).toBe(0);
  });

  it('keeps the reasoning on assistant messages in the history', async () => {
    const llm = new FakeLLMClient([FakeLLMClient.toolCall('echo', { text: 'a' }, { reasoning: 'I will echo.' }), submit({ answer: 'x' })]);
    await runAgent(options(), deps(llm));
    const assistant = llm.requests[1]?.messages.find((m): m is Extract<Message, { role: 'assistant' }> => m.role === 'assistant');
    expect(assistant?.reasoning).toBe('I will echo.');
  });

  it('truncates tool output at 20,000 characters with a note', async () => {
    const big: AgentTool<Record<string, never>> = { name: 'big', description: 'big', input: z.object({}), run: async () => 'x'.repeat(25_000) };
    const llm = new FakeLLMClient([FakeLLMClient.toolCall('big', {}), submit({ answer: 'x' })]);
    await runAgent(options({ tools: [big] }), deps(llm));
    const content = lastToolResults(llm.requests[1])[0]?.content ?? '';
    expect(content.startsWith('x'.repeat(TOOL_OUTPUT_LIMIT))).toBe(true);
    expect(content).toContain('[output truncated: showing 20000 of 25000 characters]');
  });

  it('returns errors as text: a throwing tool, bad input, an unknown tool', async () => {
    const failing: AgentTool<Record<string, never>> = {
      name: 'failing',
      description: 'fails',
      input: z.object({}),
      run: async () => {
        throw new Error('disk on fire');
      },
    };
    const llm = new FakeLLMClient([
      FakeLLMClient.toolCalls([
        { name: 'failing', input: {} },
        { name: 'echo', input: { text: 5 } },
        { name: 'nope', input: {} },
      ]),
      submit({ answer: 'x' }),
    ]);
    const result = await runAgent(options({ tools: [echo, failing] }), deps(llm));
    const results = lastToolResults(llm.requests[1]);
    expect(results.map((r) => r.isError)).toEqual([true, true, true]);
    expect(results[0]?.content).toBe('Error: disk on fire');
    expect(results[1]?.content).toMatch(/Invalid input for echo:\n- text:/);
    expect(results[2]?.content).toBe('Unknown tool "nope".');
    expect(result.toolCalls).toBe(3);
  });
});

describe('runAgent: submit attempts', () => {
  it('sends schema and validate errors back and accepts a later valid submit', async () => {
    const validate = (o: Output) => (o.answer === 'wrong' ? ['answer is wrong'] : []);
    const llm = new FakeLLMClient([submit({ answer: '' }), submit({ answer: 'wrong' }), submit({ answer: 'right' })]);
    const result = await runAgent(options({ submit: { ...options().submit, validate } }), deps(llm));
    expect(result.output.answer).toBe('right');
    const first = lastToolResults(llm.requests[1])[0];
    expect(first?.isError).toBe(true);
    expect(first?.content).toMatch(/2 attempt\(s\) left[\s\S]*- answer:/);
    expect(lastToolResults(llm.requests[2])[0]?.content).toMatch(/1 attempt\(s\) left[\s\S]*- answer is wrong/);
  });

  it('throws AgentSubmitError after 3 rejected submits across the session', async () => {
    const llm = new FakeLLMClient([submit({}), callEcho('a'), submit({}), callEcho('b'), submit({ answer: '' }), submit({ answer: 'never reached' })]);
    const err = await runAgent(options(), deps(llm)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentSubmitError);
    expect((err as AgentSubmitError).errors[0]).toMatch(/answer/);
    expect(llm.remaining).toBe(1);
  });

  it('does not count submits as tool calls', async () => {
    const llm = new FakeLLMClient([submit({}), submit({ answer: 'ok' })]);
    const result = await runAgent(options({ budget: { maxToolCalls: 0 } }), deps(llm));
    expect(result.toolCalls).toBe(0);
  });
});

describe('runAgent: budget', () => {
  it('after maxToolCalls, sends the budget message and offers only the submit tool', async () => {
    const llm = new FakeLLMClient([callEcho('1'), callEcho('2'), submit({ answer: 'done' })]);
    const result = await runAgent(options({ budget: { maxToolCalls: 2 } }), deps(llm));
    expect(result.output.answer).toBe('done');
    const final = llm.requests[2];
    expect(final?.tools?.map((t) => t.name)).toEqual(['submit_answer']);
    expect(lastUserText(final)).toEqual([BUDGET_EXHAUSTED_MESSAGE]);
    // The budget message follows the last tool results in the same user turn.
    expect(lastToolResults(final)).toHaveLength(1);
  });

  it('throws AgentBudgetError when the final turn has no submit', async () => {
    const llm = new FakeLLMClient([callEcho('1'), FakeLLMClient.text('I give up')]);
    await expect(runAgent(options({ budget: { maxToolCalls: 1 } }), deps(llm))).rejects.toThrow(AgentBudgetError);
  });

  it('throws AgentBudgetError when the final turn calls another tool, without running it', async () => {
    let runs = 0;
    const counted: AgentTool<{ text: string }> = { ...echo, run: async () => `run ${++runs}` };
    const llm = new FakeLLMClient([callEcho('1'), callEcho('2')]);
    await expect(runAgent(options({ tools: [counted], budget: { maxToolCalls: 1 } }), deps(llm))).rejects.toThrow(AgentBudgetError);
    expect(runs).toBe(1);
  });

  it('lets a rejected final submit retry while attempts remain', async () => {
    const llm = new FakeLLMClient([callEcho('1'), submit({}), submit({ answer: 'fixed' })]);
    const result = await runAgent(options({ budget: { maxToolCalls: 1 } }), deps(llm));
    expect(result.output.answer).toBe('fixed');
    expect(llm.requests[2]?.tools?.map((t) => t.name)).toEqual(['submit_answer']);
  });

  it('refuses tool calls beyond maxToolCalls within one response', async () => {
    const llm = new FakeLLMClient([
      FakeLLMClient.toolCalls([
        { name: 'echo', input: { text: '1' } },
        { name: 'echo', input: { text: '2' } },
        { name: 'echo', input: { text: '3' } },
      ]),
      submit({ answer: 'x' }),
    ]);
    const result = await runAgent(options({ budget: { maxToolCalls: 2 } }), deps(llm));
    expect(result.toolCalls).toBe(2);
    expect(lastToolResults(llm.requests[1]).map((r) => r.isError ?? false)).toEqual([false, false, true]);
  });

  it('uses maxTurns = maxToolCalls + 10 by default', async () => {
    const llm = new FakeLLMClient([...Array.from({ length: 11 }, () => FakeLLMClient.text('thinking...')), submit({ answer: 'x' })]);
    await runAgent(options({ budget: { maxToolCalls: 1 } }), deps(llm));
    expect(llm.requests[10]?.tools).toHaveLength(2);
    expect(llm.requests[11]?.tools?.map((t) => t.name)).toEqual(['submit_answer']);
  });
});

describe('runAgent: nudges and context', () => {
  it('nudges after a text-only reply, counting it as a turn', async () => {
    const llm = new FakeLLMClient([FakeLLMClient.text('Let me think.'), submit({ answer: 'x' })]);
    const result = await runAgent(options(), deps(llm));
    expect(lastUserText(llm.requests[1])).toEqual([NUDGE_MESSAGE]);
    expect(result.turns).toBe(2);
  });

  it('treats a reply cut off by the output limit without a tool call as a failed turn', async () => {
    const cutOff = FakeLLMClient.text('', { stopReason: 'max_tokens', content: [], reasoning: 'r'.repeat(500) });
    const llm = new FakeLLMClient([cutOff, submit({ answer: 'x' })]);
    const transcriptDir = await mkdtemp(path.join(tmpdir(), 'agent-cutoff-'));
    const result = await runAgent(options(), deps(llm, { transcriptDir }));
    expect(lastUserText(llm.requests[1])).toEqual([OUT_OF_SPACE_MESSAGE]);
    expect(result.turns).toBe(2);
    expect(result.toolCalls).toBe(0);
    const [file] = await readdir(transcriptDir);
    const events = (await readFile(path.join(transcriptDir, file!), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(events.find((e) => e.type === 'nudge')).toMatchObject({ text: OUT_OF_SPACE_MESSAGE, stopReason: 'max_tokens' });
  });

  it('keeps the normal nudge when a cut-off reply still called a tool', async () => {
    const llm = new FakeLLMClient([
      FakeLLMClient.toolCall('echo', { text: 'hi' }, { stopReason: 'max_tokens' }),
      submit({ answer: 'x' }),
    ]);
    const result = await runAgent(options(), deps(llm));
    expect(lastToolResults(llm.requests[1])).toHaveLength(1);
    expect(lastUserText(llm.requests[1])).not.toContain(OUT_OF_SPACE_MESSAGE);
    expect(result.toolCalls).toBe(1);
  });

  it('trims old tool results before a call when the context fills up', async () => {
    const big: AgentTool<{ text: string }> = { ...echo, run: async () => 'y'.repeat(3_000) };
    const steps = Array.from({ length: 8 }, (_, i) =>
      FakeLLMClient.toolCall('echo', { text: String(i) }, { usage: { inputTokens: 750 * (i + 1), outputTokens: 10 } }),
    );
    const llm = new FakeLLMClient([...steps, submit({ answer: 'x' })]);
    await runAgent(options({ tools: [big], budget: { maxToolCalls: 10 } }), deps(llm, { contextTokens: 6_000 }));
    const finalResults = (llm.requests.at(-1)?.messages ?? []).flatMap((m) =>
      m.role === 'user' ? m.content.filter((b): b is ToolResultBlock => b.type === 'tool_result') : [],
    );
    expect(finalResults.some((r) => r.content === TRIMMED_PLACEHOLDER)).toBe(true);
    expect(finalResults.slice(-4).every((r) => r.content.length === 3_000)).toBe(true);
    expect(llm.requests[0]?.messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Find the answer.' }] });
  });
});

describe('outputLimit', () => {
  it('shrinks the output limit so input plus output stays inside 95% of the context', () => {
    expect(outputLimit(32_768, 131_072, 10_000)).toBe(32_768);
    expect(outputLimit(32_768, 131_072, 100_000)).toBe(24_518);
    expect(outputLimit(32_768, 131_072, 130_000)).toBe(1_024);
  });

  it('is applied to each call', async () => {
    const llm = new FakeLLMClient([submit({ answer: 'x' })]);
    await runAgent(options(), { llm, contextTokens: 8_000 });
    expect(llm.requests[0]?.maxTokens).toBeLessThan(7_600);
  });
});

describe('runAgent: transcript', () => {
  async function readTranscript(dir: string, file: string) {
    return (await readFile(path.join(dir, file), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it('writes every event to transcripts/<purpose>-<n>.jsonl, including reasoning', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'transcripts-'));
    const llm = new FakeLLMClient([FakeLLMClient.toolCall('echo', { text: 'a' }, { reasoning: 'thinking hard' }), submit({}), submit({ answer: 'x' })]);
    const result = await runAgent(options(), deps(llm, { transcriptDir: dir }));
    expect(result.transcriptFile).toBe(path.join(dir, 'test-1.jsonl'));
    const events = await readTranscript(dir, 'test-1.jsonl');
    expect(events.map((e) => e.type)).toEqual(['start', 'response', 'tool_result', 'response', 'submit', 'response', 'submit', 'end']);
    expect(events[1]?.reasoning).toBe('thinking hard');
    expect(events.at(-1)).toMatchObject({ ok: true, toolCalls: 1, turns: 3 });
  });

  it('numbers concurrent sessions of the same purpose without clashing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'transcripts-'));
    await Promise.all(
      Array.from({ length: 3 }, () => runAgent(options(), deps(new FakeLLMClient([submit({ answer: 'x' })]), { transcriptDir: dir }))),
    );
    expect((await readdir(dir)).sort()).toEqual(['test-1.jsonl', 'test-2.jsonl', 'test-3.jsonl']);
  });

  it('records the error when a session fails', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'transcripts-'));
    const llm = new FakeLLMClient([callEcho('1'), FakeLLMClient.text('no')]);
    await expect(runAgent(options({ budget: { maxToolCalls: 1 } }), deps(llm, { transcriptDir: dir }))).rejects.toThrow();
    const events = await readTranscript(dir, 'test-1.jsonl');
    expect(events.map((e) => e.type)).toContain('budget_exhausted');
    expect(events.at(-1)).toMatchObject({ type: 'end', ok: false, error: expect.stringContaining('AgentBudgetError') });
  });
});

describe('runAgent: setup errors', () => {
  it('rejects a tool named like the submit tool, and a non-object submit schema', async () => {
    const clash = { ...echo, name: 'submit_answer' };
    await expect(runAgent(options({ tools: [clash] }), deps(new FakeLLMClient()))).rejects.toThrow(/clashes/);
    const arraySubmit = { name: 'submit_answer', description: 'd', schema: z.array(z.string()) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(runAgent({ ...options(), submit: arraySubmit } as any, deps(new FakeLLMClient()))).rejects.toThrow(/object/);
  });
});

describe('runAgent: structured reasoning details', () => {
  it('keeps reasoning details on the assistant message, sends them back, and writes them to the transcript', async () => {
    const details = [{ type: 'reasoning.text', text: 'Use echo first.', format: 'openai-responses-v1', index: 0 }];
    const llm = new FakeLLMClient([
      FakeLLMClient.toolCall('echo', { text: 'hi' }, { reasoning: 'Use echo first.', reasoningDetails: details }),
      submit({ answer: '42' }),
    ]);
    const transcriptDir = await mkdtemp(path.join(tmpdir(), 'agent-details-'));
    await runAgent(options(), deps(llm, { transcriptDir }));
    const assistant = llm.requests[1]?.messages.find((m): m is Extract<Message, { role: 'assistant' }> => m.role === 'assistant');
    expect(assistant?.reasoningDetails).toEqual(details);
    expect(assistant?.reasoning).toBe('Use echo first.');
    const [file] = await readdir(transcriptDir);
    const events = (await readFile(path.join(transcriptDir, file!), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(events.find((e) => e.type === 'response')?.reasoningDetails).toEqual(details);
  });
});

describe('runAgent: tools that do not count toward the budget', () => {
  const recorded: string[] = [];
  const record: AgentTool<{ text: string }> = {
    name: 'record',
    description: 'Records a finding',
    input: z.object({ text: z.string() }),
    countsTowardBudget: false,
    run: async ({ text }) => {
      recorded.push(text);
      return `recorded ${text}`;
    },
  };
  const callRecord = (text: string) => FakeLLMClient.toolCall('record', { text });

  it('does not count them against maxToolCalls', async () => {
    recorded.length = 0;
    const llm = new FakeLLMClient([callEcho('a'), callRecord('x'), callRecord('y'), callEcho('b'), submit({ answer: '1' })]);
    const result = await runAgent(options({ tools: [echo, record], budget: { maxToolCalls: 2 } }), deps(llm));
    expect(result).toMatchObject({ toolCalls: 2, uncountedToolCalls: 2, turns: 5 });
    expect(recorded).toEqual(['x', 'y']);
  });

  it('after the exploring budget, offers only the uncounted tools and submit, and refuses counted tools', async () => {
    recorded.length = 0;
    const llm = new FakeLLMClient([callEcho('a'), callEcho('too late'), callRecord('z'), submit({ answer: '1' })]);
    const transcriptDir = await mkdtemp(path.join(tmpdir(), 'agent-wrapup-'));
    const result = await runAgent(options({ tools: [echo, record], budget: { maxToolCalls: 1 } }), deps(llm, { transcriptDir }));
    expect(llm.requests[0]?.tools?.map((t) => t.name)).toEqual(['echo', 'record', 'submit_answer']);
    expect(llm.requests[1]?.tools?.map((t) => t.name)).toEqual(['record', 'submit_answer']);
    expect(lastUserText(llm.requests[1])).toEqual([wrapUpMessage(['record'], 'submit_answer')]);
    expect(lastToolResults(llm.requests[2])[0]).toMatchObject({ isError: true, content: expect.stringContaining('budget exhausted') });
    expect(recorded).toEqual(['z']);
    expect(result).toMatchObject({ output: { answer: '1' }, toolCalls: 1, uncountedToolCalls: 1 });
    const [file] = await readdir(transcriptDir);
    const events = (await readFile(path.join(transcriptDir, file!), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(events.filter((e) => e.type === 'budget_exhausted').map((e) => e.phase)).toEqual(['wrapUp']);
  });

  it('ends the wrap-up phase with a submit-only final turn at maxTurns', async () => {
    const llm = new FakeLLMClient([callEcho('a'), callRecord('1'), callRecord('2'), submit({ answer: 'done' })]);
    const result = await runAgent(
      options({ tools: [echo, record], budget: { maxToolCalls: 1, maxTurns: 3 } }),
      deps(llm),
    );
    expect(llm.requests[3]?.tools?.map((t) => t.name)).toEqual(['submit_answer']);
    expect(lastUserText(llm.requests[3])).toContain(BUDGET_EXHAUSTED_MESSAGE);
    expect(result.output).toEqual({ answer: 'done' });
  });

  it('without uncounted tools, keeps the old behaviour: straight to the submit-only turn', async () => {
    const llm = new FakeLLMClient([callEcho('a'), submit({ answer: 'x' })]);
    await runAgent(options({ budget: { maxToolCalls: 1 } }), deps(llm));
    expect(llm.requests[1]?.tools?.map((t) => t.name)).toEqual(['submit_answer']);
    expect(lastUserText(llm.requests[1])).toEqual([BUDGET_EXHAUSTED_MESSAGE]);
  });
});

describe('runAgent: per-tool counts', () => {
  const failing: AgentTool<{ text: string }> = {
    name: 'fail',
    description: 'Always throws',
    input: z.object({ text: z.string() }),
    run: async () => {
      throw new Error('nope');
    },
  };

  it('counts calls, invalid input and thrown errors per tool, and reports whether the budget ran out', async () => {
    const llm = new FakeLLMClient([
      callEcho('a'),
      FakeLLMClient.toolCall('echo', { wrong: 1 }),
      FakeLLMClient.toolCall('fail', { text: 'x' }),
      submit({ answer: '1' }),
    ]);
    const result = await runAgent(options({ tools: [echo, failing], budget: { maxToolCalls: 5 } }), deps(llm));
    expect(result.toolStats).toEqual({
      echo: { calls: 2, invalidInput: 1, errors: 0 },
      fail: { calls: 1, invalidInput: 0, errors: 1 },
    });
    expect(result.budgetExhausted).toBe(false);
  });

  it('carries the counts on AgentSubmitError, with budgetExhausted when the budget was used up', async () => {
    const bad = submit({ answer: '' });
    const llm = new FakeLLMClient([callEcho('a'), bad, bad, bad]);
    const err = await runAgent(options({ budget: { maxToolCalls: 1 } }), deps(llm)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentSubmitError);
    expect((err as AgentSubmitError).details).toMatchObject({ toolStats: { echo: { calls: 1 } }, budgetExhausted: true });
  });
});
