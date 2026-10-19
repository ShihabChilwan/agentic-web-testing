import type { ChatProvider, ChatRequest, ChatResponse, LLMClient, ProviderRequest, ToolCallBlock } from './types.js';

/** One scripted step: a response, an error to throw, or a function of the request. */
export type FakeStep = ChatResponse | Error | ((req: ChatRequest) => ChatResponse | Promise<ChatResponse>);

/**
 * Returns scripted responses in order, for unit tests. Records every request
 * it receives. Throws when the script runs out, so a test never silently
 * makes more calls than it planned.
 *
 * Also usable as a provider behind the real client, to test retries, limits and logging.
 */
export class FakeLLMClient implements LLMClient, ChatProvider {
  readonly name = 'openai-compatible';
  readonly requests: ProviderRequest[] = [];
  private readonly steps: FakeStep[];

  constructor(steps: FakeStep[] = []) {
    this.steps = [...steps];
  }

  /** Adds steps to the end of the script. */
  push(...steps: FakeStep[]): this {
    this.steps.push(...steps);
    return this;
  }

  get remaining(): number {
    return this.steps.length;
  }

  async chat(req: ChatRequest | ProviderRequest): Promise<ChatResponse> {
    this.requests.push(structuredClone(req) as ProviderRequest);
    const step = this.steps.shift();
    if (step === undefined) throw new Error(`FakeLLMClient: no scripted response left for call ${this.requests.length}`);
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step(req) : structuredClone(step);
  }

  /** A response with plain text and no tool call. */
  static text(text: string, extra: Partial<ChatResponse> = {}): ChatResponse {
    return { ...baseResponse('end'), content: [{ type: 'text', text }], ...extra };
  }

  /** A response that calls one or more tools. */
  static toolCalls(calls: Array<Omit<ToolCallBlock, 'type' | 'id'> & { id?: string }>, extra: Partial<ChatResponse> = {}): ChatResponse {
    const content: ToolCallBlock[] = calls.map((c, i) => ({ type: 'tool_call', id: c.id ?? `call-${i + 1}`, name: c.name, input: c.input }));
    return { ...baseResponse('tool_call'), content, ...extra };
  }

  /** A response that calls a single tool. */
  static toolCall(name: string, input: unknown, extra: Partial<ChatResponse> = {}): ChatResponse {
    return FakeLLMClient.toolCalls([{ name, input }], extra);
  }
}

function baseResponse(stopReason: ChatResponse['stopReason']): ChatResponse {
  return { content: [], stopReason, usage: { inputTokens: 100, outputTokens: 20 }, model: 'fake-model', latencyMs: 1 };
}
