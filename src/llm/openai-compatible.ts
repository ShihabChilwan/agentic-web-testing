import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError } from 'openai';
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import type { ReasoningParam } from '../shared/config.js';
import { errorKindForStatus, LLMRequestError } from './errors.js';
import type {
  ChatProvider,
  ChatResponse,
  Message,
  ProviderRequest,
  StopReason,
  TextBlock,
  ToolCallBlock,
} from './types.js';

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string | undefined;
  extraHeaders: Record<string, string>;
  /** Merged into every request body; config validation keeps it off the fields set here. */
  extraBody?: Record<string, unknown>;
  reasoningParam?: ReasoningParam;
  timeoutMs: number;
  /** For tests: a stub in place of the global fetch. */
  fetch?: typeof fetch;
}

/** Servers name the reasoning field differently: vLLM uses `reasoning_content`, some use `reasoning`. */
type ReasoningField = 'reasoning_content' | 'reasoning';

/**
 * Talks to any OpenAI-compatible chat completions endpoint (vLLM serving
 * gpt-oss, OpenAI itself). One request per call; the client does retries.
 */
export class OpenAICompatibleProvider implements ChatProvider {
  readonly name = 'openai-compatible';
  private readonly client: OpenAI;
  /** Sent back under the same name the server used, once we have seen one. */
  private reasoningField: ReasoningField = 'reasoning_content';
  private readonly extraBody: Record<string, unknown>;
  private readonly reasoningParam: ReasoningParam;

  constructor(options: OpenAICompatibleOptions) {
    this.extraBody = options.extraBody ?? {};
    this.reasoningParam = options.reasoningParam ?? 'reasoning_effort';
    this.client = new OpenAI({
      baseURL: options.baseUrl,
      // The SDK falls back to OPENAI_API_KEY and refuses to start without a key; self-hosted endpoints may need none.
      apiKey: options.apiKey ?? 'none',
      defaultHeaders: options.extraHeaders,
      timeout: options.timeoutMs,
      maxRetries: 0,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  async chat(req: ProviderRequest): Promise<ChatResponse> {
    const effort = req.reasoningEffort
      ? this.reasoningParam === 'reasoning_object'
        ? { reasoning: { effort: req.reasoningEffort } }
        : { reasoning_effort: req.reasoningEffort }
      : {};
    // The SDK sends unknown body fields as they are.
    const body = {
      ...this.extraBody,
      model: req.model,
      messages: [{ role: 'system', content: req.system }, ...req.messages.flatMap((m) => this.toOpenAI(m))],
      max_completion_tokens: req.maxTokens,
      temperature: req.temperature,
      top_p: req.topP,
      ...effort,
      ...(req.tools?.length ? { tools: req.tools.map(toOpenAITool) } : {}),
    } as ChatCompletionCreateParamsNonStreaming;

    const started = Date.now();
    let completion: ChatCompletion;
    try {
      completion = await this.client.chat.completions.create(body);
    } catch (err) {
      throw toRequestError(err);
    }
    const latencyMs = Date.now() - started;
    return this.fromOpenAI(completion, latencyMs);
  }

  private toOpenAI(message: Message): ChatCompletionMessageParam[] {
    if (message.role === 'assistant') {
      const text = message.content
        .filter((b): b is TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      const toolCalls = message.content.filter((b): b is ToolCallBlock => b.type === 'tool_call');
      const out: ChatCompletionMessageParam & Record<string, unknown> = {
        role: 'assistant',
        content: text.length > 0 ? text : null,
        ...(toolCalls.length
          ? {
              tool_calls: toolCalls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: typeof c.input === 'string' ? c.input : JSON.stringify(c.input) },
              })),
            }
          : {}),
      };
      if (message.reasoning) out[this.reasoningField] = message.reasoning;
      if (message.reasoningDetails) out.reasoning_details = message.reasoningDetails;
      return [out];
    }

    // Tool results become `tool` messages, which must directly follow the assistant's tool calls;
    // any text in the same user turn follows as a user message.
    const out: ChatCompletionMessageParam[] = [];
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        out.push({ role: 'tool', tool_call_id: block.toolCallId, content: block.content });
      }
    }
    const text = message.content
      .filter((b): b is TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    if (text.length > 0) out.push({ role: 'user', content: text });
    return out;
  }

  private fromOpenAI(completion: ChatCompletion, latencyMs: number): ChatResponse {
    const choice = completion.choices[0];
    if (!choice) throw new LLMRequestError('response contained no choices', 'client');
    const message = choice.message as typeof choice.message & {
      reasoning_content?: string;
      reasoning?: string;
      reasoning_details?: unknown;
    };

    let reasoning: string | undefined;
    if (typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0) {
      reasoning = message.reasoning_content;
      this.reasoningField = 'reasoning_content';
    } else if (typeof message.reasoning === 'string' && message.reasoning.length > 0) {
      reasoning = message.reasoning;
      this.reasoningField = 'reasoning';
    }

    const content: Array<TextBlock | ToolCallBlock> = [];
    if (message.content) content.push({ type: 'text', text: message.content });
    for (const call of message.tool_calls ?? []) {
      if (call.type !== 'function') continue;
      content.push({ type: 'tool_call', id: call.id, name: call.function.name, input: parseArguments(call.function.arguments) });
    }

    const reasoningDetails = Array.isArray(message.reasoning_details) ? message.reasoning_details : undefined;
    const hasToolCalls = content.some((b) => b.type === 'tool_call');
    const stopReason: StopReason = hasToolCalls ? 'tool_call' : choice.finish_reason === 'length' ? 'max_tokens' : 'end';

    // Optional fields some endpoints add (OpenRouter: provider, usage.cost); read only when present.
    const extra = completion as ChatCompletion & { provider?: unknown };
    const usage = completion.usage as
      | (NonNullable<ChatCompletion['usage']> & { cost?: unknown })
      | undefined;
    const cached = usage?.prompt_tokens_details?.cached_tokens;
    const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens;

    return {
      content,
      ...(reasoning ? { reasoning } : {}),
      ...(reasoningDetails ? { reasoningDetails } : {}),
      stopReason,
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
        ...(typeof cached === 'number' ? { cachedInputTokens: cached } : {}),
        ...(typeof reasoningTokens === 'number' ? { reasoningTokens } : {}),
        ...(typeof usage?.cost === 'number' && usage.cost >= 0 ? { costUsd: usage.cost } : {}),
      },
      model: completion.model,
      ...(typeof extra.provider === 'string' && extra.provider ? { upstreamProvider: extra.provider } : {}),
      ...(completion.system_fingerprint ? { systemFingerprint: completion.system_fingerprint } : {}),
      latencyMs,
    };
  }
}

function toOpenAITool(tool: { name: string; description: string; inputSchema: Record<string, unknown> }): ChatCompletionTool {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } };
}

/** Tool arguments arrive as a JSON string. Invalid JSON is passed on as the raw string, so the agent's schema check reports it to the model. */
function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function toRequestError(err: unknown): LLMRequestError {
  if (err instanceof APIConnectionTimeoutError) return new LLMRequestError('request timed out', 'timeout');
  if (err instanceof APIConnectionError) return new LLMRequestError(`network error: ${err.message}`, 'network');
  if (err instanceof APIError && typeof err.status === 'number') {
    return new LLMRequestError(err.message, errorKindForStatus(err.status), err.status);
  }
  return new LLMRequestError(err instanceof Error ? err.message : String(err), 'client');
}
