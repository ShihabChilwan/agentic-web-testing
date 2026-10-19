import type { ReasoningEffort } from '../shared/schemas.js';

export type TextBlock = { type: 'text'; text: string };
export type ToolCallBlock = { type: 'tool_call'; id: string; name: string; input: unknown };
export type ToolResultBlock = { type: 'tool_result'; toolCallId: string; content: string; isError?: boolean };

/**
 * gpt-oss returns its reasoning separately from its text. It is kept on the
 * assistant message and sent back with the history in later tool-calling
 * turns, or the model loses track mid-task.
 */
export type Message =
  | { role: 'user'; content: Array<TextBlock | ToolResultBlock> }
  | { role: 'assistant'; content: Array<TextBlock | ToolCallBlock>; reasoning?: string };

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
}

export interface ChatRequest {
  /** 'prd' | 'cases' | 'scripts' | 'analyzer' | 'one-prompt' ...; selects per-module settings and labels the call log. */
  purpose: string;
  system: string;
  messages: Message[];
  /** Forced tool choice is not supported by gpt-oss on vLLM; restrict `tools` instead. */
  tools?: ToolDef[];
  maxTokens: number;
  temperature?: number;
  topP?: number;
  reasoningEffort?: ReasoningEffort;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export type StopReason = 'end' | 'tool_call' | 'max_tokens';

export interface ChatResponse {
  content: Array<TextBlock | ToolCallBlock>;
  reasoning?: string;
  stopReason: StopReason;
  usage: Usage;
  model: string;
  latencyMs: number;
}

export interface LLMClient {
  chat(req: ChatRequest): Promise<ChatResponse>;
}

/** A request with every setting resolved, as a provider receives it. */
export interface ProviderRequest extends ChatRequest {
  model: string;
  temperature: number;
  topP: number;
  /** Absent when the endpoint has rejected the parameter for this run. */
  reasoningEffort?: ReasoningEffort;
}

/** One model API. Providers make exactly one request per call: no retries, limits or logging. */
export interface ChatProvider {
  readonly name: 'openai-compatible' | 'anthropic';
  chat(req: ProviderRequest): Promise<ChatResponse>;
}
