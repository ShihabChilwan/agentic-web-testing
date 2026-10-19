import { describe, expect, it } from 'vitest';
import { guardContext, TRIMMED_PLACEHOLDER } from '../../src/agent/context-guard.js';
import type { Message } from '../../src/llm/types.js';

const TASK = 'Explore the repo and submit a PRD.';

/** A conversation of `n` tool round-trips, each tool result `resultChars` long and each reasoning `reasoningChars` long. */
function conversation(n: number, resultChars: number, reasoningChars = 0): Message[] {
  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: TASK }] }];
  for (let i = 1; i <= n; i++) {
    messages.push({
      role: 'assistant',
      content: [
        { type: 'text', text: `step ${i}` },
        { type: 'tool_call', id: `c${i}`, name: 'read_file', input: { path: `f${i}.js` } },
      ],
      ...(reasoningChars ? { reasoning: 'r'.repeat(reasoningChars) } : {}),
    });
    messages.push({ role: 'user', content: [{ type: 'tool_result', toolCallId: `c${i}`, content: String(i % 10).repeat(resultChars) }] });
  }
  return messages;
}

const toolResults = (messages: Message[]) =>
  messages.flatMap((m) => (m.role === 'user' ? m.content.filter((b) => b.type === 'tool_result') : []));

describe('guardContext', () => {
  it('does nothing at or below 75% of the context', () => {
    const messages = conversation(10, 1_000); // ~2,500 tokens of tool output
    const result = guardContext({ messages, baseTokens: 0, baseMessageCount: 0, contextTokens: 10_000 });
    expect(result.trims).toEqual([]);
    expect(result.messages).toBe(messages);
  });

  it('trims the oldest tool results until below 60%, keeping the 4 newest', () => {
    const messages = conversation(10, 4_000); // ~10,000 tokens of tool output; 75% of 12,000 = 9,000
    const result = guardContext({ messages, baseTokens: 0, baseMessageCount: 0, contextTokens: 12_000 });
    expect(result.estimateBefore).toBeGreaterThan(9_000);
    expect(result.estimateAfter).toBeLessThan(7_200);
    const contents = toolResults(result.messages).map((b) => b.content);
    // Oldest first, and no more than needed: each trim saves ~985 tokens, so 3 trims get from ~10,090 below 7,200.
    expect(contents.slice(0, 3).every((c) => c === TRIMMED_PLACEHOLDER)).toBe(true);
    expect(contents.slice(3).every((c) => c !== TRIMMED_PLACEHOLDER)).toBe(true);
    expect(result.trims.map((t) => (t.kind === 'tool_result' ? t.toolCallId : ''))).toEqual(['c1', 'c2', 'c3']);
  });

  it('never trims the 4 newest tool results, even when still above the target', () => {
    const messages = conversation(6, 4_000);
    const result = guardContext({ messages, baseTokens: 0, baseMessageCount: 0, contextTokens: 6_000 });
    const contents = toolResults(result.messages).map((b) => b.content);
    expect(contents.slice(0, 2)).toEqual([TRIMMED_PLACEHOLDER, TRIMMED_PLACEHOLDER]);
    expect(contents.slice(2).every((c) => c.length === 4_000)).toBe(true);
  });

  it('never changes the task or the model text, tool calls and newest reasoning', () => {
    const messages = conversation(8, 4_000, 400);
    const result = guardContext({ messages, baseTokens: 0, baseMessageCount: 0, contextTokens: 6_000 });
    expect(result.trims.length).toBeGreaterThan(0);
    expect(result.messages[0]).toEqual(messages[0]);
    const assistants = (ms: Message[]) => ms.filter((m) => m.role === 'assistant').map((m) => m.content);
    expect(assistants(result.messages)).toEqual(assistants(messages));
    const lastFour = result.messages.filter((m) => m.role === 'assistant').slice(-4);
    expect(lastFour.every((m) => m.role === 'assistant' && m.reasoning?.length === 400)).toBe(true);
  });

  it('falls back to dropping reasoning from assistant messages older than the newest 4', () => {
    const messages = conversation(8, 10, 8_000); // tool results are tiny; reasoning is the bulk
    const result = guardContext({ messages, baseTokens: 0, baseMessageCount: 0, contextTokens: 20_000 });
    const reasoningTrims = result.trims.filter((t) => t.kind === 'reasoning');
    expect(reasoningTrims.length).toBeGreaterThan(0);
    const assistants = result.messages.filter((m) => m.role === 'assistant');
    expect(assistants.slice(-4).every((m) => m.role === 'assistant' && m.reasoning)).toBe(true);
    // Oldest reasoning goes first.
    expect(assistants[0]?.role === 'assistant' && assistants[0].reasoning).toBeFalsy();
    expect(result.estimateAfter).toBeLessThan(12_000);
  });

  it('returns the messages unchanged when nothing can be trimmed', () => {
    const messages = conversation(2, 40_000);
    const result = guardContext({ messages, baseTokens: 0, baseMessageCount: 0, contextTokens: 10_000 });
    expect(result.trims).toEqual([]);
    expect(result.messages).toBe(messages);
  });

  it('does not change its input', () => {
    const messages = conversation(10, 4_000, 100);
    const copy = structuredClone(messages);
    guardContext({ messages, baseTokens: 0, baseMessageCount: 0, contextTokens: 12_000 });
    expect(messages).toEqual(copy);
  });

  it('counts tokens from the last request plus characters added since', () => {
    const messages = conversation(2, 400);
    // The last request reported 7,600 tokens and covered all but the final tool result (400 chars = 100 tokens).
    const result = guardContext({ messages, baseTokens: 7_600, baseMessageCount: messages.length - 1, contextTokens: 10_000 });
    expect(result.estimateBefore).toBe(7_700);
  });

  it('skips results that were already trimmed', () => {
    const first = guardContext({ messages: conversation(10, 4_000), baseTokens: 0, baseMessageCount: 0, contextTokens: 12_000 });
    const again = guardContext({ messages: first.messages, baseTokens: 9_500, baseMessageCount: first.messages.length, contextTokens: 12_000 });
    const ids = again.trims.map((t) => (t.kind === 'tool_result' ? t.toolCallId : t.kind));
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.some((id) => ['c1', 'c2', 'c3'].includes(id))).toBe(false);
  });
});

describe('guardContext: structured reasoning details', () => {
  it('counts reasoning details and drops them together with the reasoning text', () => {
    const messages = conversation(8, 10).map((m) =>
      m.role === 'assistant'
        ? { ...m, reasoning: 'short', reasoningDetails: [{ type: 'reasoning.text', text: 'r'.repeat(8_000) }] }
        : m,
    );
    const result = guardContext({ messages, baseTokens: 0, baseMessageCount: 0, contextTokens: 16_000 });
    const dropped = result.trims.filter((t) => t.kind === 'reasoning');
    expect(dropped.length).toBeGreaterThan(0);
    for (const trim of dropped) {
      const m = result.messages[trim.messageIndex]!;
      expect(m.role === 'assistant' && (m.reasoning ?? m.reasoningDetails)).toBeFalsy();
      expect(trim.removedChars).toBeGreaterThan(8_000);
    }
    const kept = result.messages.filter((m) => m.role === 'assistant').slice(-4);
    expect(kept.every((m) => m.role === 'assistant' && m.reasoningDetails?.length === 1)).toBe(true);
  });
});
