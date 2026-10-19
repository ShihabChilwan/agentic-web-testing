import type { Message } from '../llm/types.js';

export const TRIMMED_PLACEHOLDER = '[output removed to save space; call the tool again if needed]';

export interface GuardInput {
  messages: readonly Message[];
  /** Input tokens reported for the previous request (or an estimate before the first one). */
  baseTokens: number;
  /** How many of `messages` were part of that previous request; the rest are counted by characters. */
  baseMessageCount: number;
  contextTokens: number;
  /** Start trimming above this share of the context (default 0.75). */
  trimAbove?: number;
  /** Trim until the estimate is below this share (default 0.6). */
  trimTo?: number;
  /** Tool results that are never trimmed, counted from the newest (default 4). */
  keepToolResults?: number;
  /** Assistant messages whose reasoning is never dropped, counted from the newest (default 4). */
  keepReasoning?: number;
}

export type Trim =
  | { kind: 'tool_result'; messageIndex: number; toolCallId: string; removedChars: number }
  | { kind: 'reasoning'; messageIndex: number; removedChars: number };

export interface GuardResult {
  /** The messages to send; a new array when anything was trimmed, otherwise the input array. */
  messages: Message[];
  estimateBefore: number;
  estimateAfter: number;
  trims: Trim[];
}

/** Rough token count: about 4 characters per token. */
export const estimateTokens = (chars: number) => Math.ceil(chars / 4);

export function messageChars(message: Message): number {
  let chars = message.role === 'assistant' ? (message.reasoning?.length ?? 0) : 0;
  for (const block of message.content) {
    if (block.type === 'text') chars += block.text.length;
    else if (block.type === 'tool_result') chars += block.content.length;
    else chars += block.name.length + JSON.stringify(block.input ?? null).length;
  }
  return chars;
}

/**
 * Keeps the conversation inside the model's context window. Pure: returns
 * new messages and a record of what was trimmed, and never changes its input.
 *
 * Above `trimAbove` of the context, the content of the oldest tool results
 * (all but the newest `keepToolResults`) is replaced with a placeholder until
 * the estimate is below `trimTo`. If that is not enough, reasoning is dropped
 * from assistant messages older than the newest `keepReasoning`. The system
 * prompt, the task and the model's own text and tool calls are never changed.
 */
export function guardContext(input: GuardInput): GuardResult {
  const trimAbove = input.trimAbove ?? 0.75;
  const trimTo = input.trimTo ?? 0.6;
  const keepToolResults = input.keepToolResults ?? 4;
  const keepReasoning = input.keepReasoning ?? 4;

  const addedChars = input.messages.slice(input.baseMessageCount).reduce((sum, m) => sum + messageChars(m), 0);
  const estimateBefore = input.baseTokens + estimateTokens(addedChars);
  if (estimateBefore <= input.contextTokens * trimAbove) {
    return { messages: input.messages as Message[], estimateBefore, estimateAfter: estimateBefore, trims: [] };
  }

  const target = input.contextTokens * trimTo;
  const messages: Message[] = structuredClone(input.messages) as Message[];
  const trims: Trim[] = [];
  let estimate = estimateBefore;

  // Every tool result, oldest first, minus the newest few.
  const toolResults: Array<{ messageIndex: number; blockIndex: number }> = [];
  messages.forEach((m, messageIndex) => {
    if (m.role !== 'user') return;
    m.content.forEach((b, blockIndex) => {
      if (b.type === 'tool_result') toolResults.push({ messageIndex, blockIndex });
    });
  });
  const trimmable = toolResults.slice(0, Math.max(0, toolResults.length - keepToolResults));

  for (const { messageIndex, blockIndex } of trimmable) {
    if (estimate < target) break;
    const block = messages[messageIndex]!.content[blockIndex]!;
    if (block.type !== 'tool_result' || block.content === TRIMMED_PLACEHOLDER) continue;
    const removedChars = block.content.length - TRIMMED_PLACEHOLDER.length;
    if (removedChars <= 0) continue;
    block.content = TRIMMED_PLACEHOLDER;
    estimate -= removedChars / 4;
    trims.push({ kind: 'tool_result', messageIndex, toolCallId: block.toolCallId, removedChars });
  }

  if (estimate >= target) {
    const assistantIndexes = messages.flatMap((m, i) => (m.role === 'assistant' ? [i] : []));
    const older = assistantIndexes.slice(0, Math.max(0, assistantIndexes.length - keepReasoning));
    for (const messageIndex of older) {
      if (estimate < target) break;
      const m = messages[messageIndex]!;
      if (m.role !== 'assistant' || !m.reasoning) continue;
      const removedChars = m.reasoning.length;
      delete m.reasoning;
      estimate -= removedChars / 4;
      trims.push({ kind: 'reasoning', messageIndex, removedChars });
    }
  }

  // Still too large: send anyway and let the server's error fail the call.
  if (trims.length === 0) {
    return { messages: input.messages as Message[], estimateBefore, estimateAfter: estimateBefore, trims };
  }
  return { messages, estimateBefore, estimateAfter: Math.ceil(estimate), trims };
}
