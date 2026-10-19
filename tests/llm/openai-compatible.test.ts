import { describe, expect, it } from 'vitest';
import { LLMRequestError } from '../../src/llm/errors.js';
import { OpenAICompatibleProvider } from '../../src/llm/openai-compatible.js';
import type { ProviderRequest } from '../../src/llm/types.js';

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/** A stub fetch that records each request and answers with the given responses in order. */
function stubFetch(responses: Array<{ status?: number; body: unknown } | Error | 'hang'>) {
  const captured: Captured[] = [];
  const fetchStub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    captured.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const next = responses.shift();
    if (next === undefined) throw new Error('stub fetch: no response left');
    if (next === 'hang') {
      return new Promise((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
      );
    }
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fetchStub as typeof fetch, captured };
}

function provider(fetchStub: typeof fetch, timeoutMs = 5_000) {
  return new OpenAICompatibleProvider({
    baseUrl: 'http://model.test/v1',
    apiKey: 'test-api-key',
    extraHeaders: { 'X-Proxy-Key': 'proxy-key-value', 'X-Proxy-Secret': 'proxy-secret-value' },
    timeoutMs,
    fetch: fetchStub,
  });
}

const request: ProviderRequest = {
  purpose: 'prd',
  system: 'You are a test.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Start.' }] }],
  maxTokens: 1000,
  model: 'openai/gpt-oss-120b',
  temperature: 1,
  topP: 1,
  reasoningEffort: 'high',
  tools: [{ name: 'read_file', description: 'Reads a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
};

function completion(message: Record<string, unknown>, finishReason = 'stop') {
  return {
    id: 'c1',
    object: 'chat.completion',
    created: 0,
    model: 'openai/gpt-oss-120b',
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finishReason }],
    usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
  };
}

describe('OpenAICompatibleProvider request', () => {
  it('sends model, sampling, reasoning_effort, tools, auth and extra headers', async () => {
    const stub = stubFetch([{ body: completion({ content: 'hi' }) }]);
    await provider(stub.fetch).chat(request);
    const [sent] = stub.captured;
    expect(sent?.url).toBe('http://model.test/v1/chat/completions');
    expect(sent?.headers.get('authorization')).toBe('Bearer test-api-key');
    expect(sent?.headers.get('x-proxy-key')).toBe('proxy-key-value');
    expect(sent?.headers.get('x-proxy-secret')).toBe('proxy-secret-value');
    expect(sent?.body).toMatchObject({
      model: 'openai/gpt-oss-120b',
      temperature: 1,
      top_p: 1,
      max_completion_tokens: 1000,
      reasoning_effort: 'high',
      messages: [
        { role: 'system', content: 'You are a test.' },
        { role: 'user', content: 'Start.' },
      ],
      tools: [{ type: 'function', function: { name: 'read_file', description: 'Reads a file' } }],
    });
    expect(sent?.body).not.toHaveProperty('tool_choice');
  });

  it('omits reasoning_effort when the client has dropped it', async () => {
    const stub = stubFetch([{ body: completion({ content: 'hi' }) }]);
    const { reasoningEffort: _r, ...withoutEffort } = request;
    await provider(stub.fetch).chat(withoutEffort);
    expect(stub.captured[0]?.body).not.toHaveProperty('reasoning_effort');
  });

  it('sends history with tool calls, tool results and reasoning in OpenAI format', async () => {
    const stub = stubFetch([
      { body: completion({ content: null, reasoning_content: 'I should read it.', tool_calls: [] }) },
      { body: completion({ content: 'done' }) },
    ]);
    const p = provider(stub.fetch);
    await p.chat(request); // the server's reasoning field name is learned from this response
    await p.chat({
      ...request,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Start.' }] },
        {
          role: 'assistant',
          reasoning: 'I should read package.json.',
          content: [{ type: 'tool_call', id: 'call-1', name: 'read_file', input: { path: 'package.json' } }],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolCallId: 'call-1', content: '1: {}' },
            { type: 'text', text: 'Keep going.' },
          ],
        },
      ],
    });
    expect(stub.captured[1]?.body.messages).toEqual([
      { role: 'system', content: 'You are a test.' },
      { role: 'user', content: 'Start.' },
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'I should read package.json.',
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"package.json"}' } }],
      },
      { role: 'tool', tool_call_id: 'call-1', content: '1: {}' },
      { role: 'user', content: 'Keep going.' },
    ]);
  });

  it('sends reasoning back under `reasoning` when the server uses that name', async () => {
    const stub = stubFetch([{ body: completion({ content: 'a', reasoning: 'thinking' }) }, { body: completion({ content: 'b' }) }]);
    const p = provider(stub.fetch);
    await p.chat(request);
    await p.chat({ ...request, messages: [{ role: 'assistant', reasoning: 'thinking', content: [{ type: 'text', text: 'a' }] }] });
    expect((stub.captured[1]?.body.messages as unknown[])[1]).toEqual({ role: 'assistant', content: 'a', reasoning: 'thinking' });
  });
});

describe('OpenAICompatibleProvider response', () => {
  it('maps text, reasoning_content, usage and stop reason', async () => {
    const stub = stubFetch([{ body: completion({ content: 'hello', reasoning_content: 'thinking' }) }]);
    const response = await provider(stub.fetch).chat(request);
    expect(response).toMatchObject({
      content: [{ type: 'text', text: 'hello' }],
      reasoning: 'thinking',
      stopReason: 'end',
      usage: { inputTokens: 120, outputTokens: 30 },
      model: 'openai/gpt-oss-120b',
    });
  });

  it('reads reasoning from `reasoning` as well', async () => {
    const stub = stubFetch([{ body: completion({ content: 'hello', reasoning: 'thinking' }) }]);
    expect((await provider(stub.fetch).chat(request)).reasoning).toBe('thinking');
  });

  it('maps tool calls, keeping invalid JSON arguments as the raw string', async () => {
    const stub = stubFetch([
      {
        body: completion(
          {
            content: null,
            tool_calls: [
              { id: 'a', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } },
              { id: 'b', type: 'function', function: { name: 'read_file', arguments: '{path: README' } },
            ],
          },
          'tool_calls',
        ),
      },
    ]);
    const response = await provider(stub.fetch).chat(request);
    expect(response.stopReason).toBe('tool_call');
    expect(response.content).toEqual([
      { type: 'tool_call', id: 'a', name: 'read_file', input: { path: 'README.md' } },
      { type: 'tool_call', id: 'b', name: 'read_file', input: '{path: README' },
    ]);
  });

  it('reports a length cut-off as max_tokens', async () => {
    const stub = stubFetch([{ body: completion({ content: 'partial' }, 'length') }]);
    expect((await provider(stub.fetch).chat(request)).stopReason).toBe('max_tokens');
  });
});

describe('OpenAICompatibleProvider errors', () => {
  async function errorOf(p: Promise<unknown>): Promise<LLMRequestError> {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LLMRequestError);
    return err as LLMRequestError;
  }

  it.each([
    [429, 'rate_limit'],
    [500, 'server'],
    [503, 'server'],
    [400, 'client'],
    [401, 'client'],
    [404, 'client'],
  ] as const)('maps HTTP %i to %s', async (status, kind) => {
    const stub = stubFetch([{ status, body: { error: { message: 'nope' } } }]);
    const err = await errorOf(provider(stub.fetch).chat(request));
    expect(err.kind).toBe(kind);
    expect(err.status).toBe(status);
  });

  it('makes exactly one request (SDK retries are off)', async () => {
    const stub = stubFetch([{ status: 503, body: {} }, { body: completion({ content: 'late' }) }]);
    await errorOf(provider(stub.fetch).chat(request));
    expect(stub.captured).toHaveLength(1);
  });

  it('maps a network failure to network', async () => {
    const stub = stubFetch([new TypeError('fetch failed')]);
    expect((await errorOf(provider(stub.fetch).chat(request))).kind).toBe('network');
  });

  it('maps a timeout to timeout', async () => {
    const stub = stubFetch(['hang']);
    expect((await errorOf(provider(stub.fetch, 20).chat(request))).kind).toBe('timeout');
  });
});
