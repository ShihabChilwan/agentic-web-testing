import { modelFor, reasoningEffortFor } from '../shared/config.js';
import type { LLMConfig } from '../shared/config.js';
import type { Pricing, ReasoningEffort } from '../shared/schemas.js';
import { RunBudget } from './budget.js';
import { appendCallLog, readCallLog } from './call-log.js';
import { LLMRequestError, redact } from './errors.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { costUsd, loadPricing } from './pricing.js';
import { DEFAULT_RETRY, withRetry } from './retry.js';
import type { RetryOptions } from './retry.js';
import { Limiter } from './limiter.js';
import type { ChatProvider, ChatRequest, ChatResponse, LLMClient, ProviderRequest } from './types.js';

export interface LLMClientDeps {
  provider: ChatProvider;
  pricing: Pricing | null;
  budget: RunBudget;
  /** runs/<runId>/llm-calls.jsonl */
  callLogFile: string;
  retry?: RetryOptions;
  warn?: (message: string) => void;
  now?: () => Date;
}

/**
 * The only way the pipeline talks to a model. Every call goes through
 * limiter → budget check → retry → provider, and is logged to llm-calls.jsonl.
 */
export class RunLLMClient implements LLMClient {
  private readonly limiter: Limiter;
  private readonly secrets: string[];
  private reasoningEffortRejected = false;

  constructor(
    private readonly config: LLMConfig,
    private readonly deps: LLMClientDeps,
  ) {
    this.limiter = new Limiter(config.concurrency);
    this.secrets = [config.apiKey ?? '', ...Object.values(config.extraHeaders)];
  }

  chat(req: ChatRequest): Promise<ChatResponse> {
    return this.limiter.run(() => this.call(req));
  }

  private async call(req: ChatRequest): Promise<ChatResponse> {
    const { provider, budget } = this.deps;
    const now = this.deps.now ?? (() => new Date());
    budget.check();

    const model = modelFor(this.config, req.purpose);
    const effort: ReasoningEffort = req.reasoningEffort ?? reasoningEffortFor(this.config, req.purpose);
    const resolved: ProviderRequest = {
      ...req,
      model,
      temperature: req.temperature ?? this.config.temperature,
      topP: req.topP ?? this.config.topP,
    };

    const started = now();
    let requests = 0;
    const send = async (): Promise<ChatResponse> => {
      const withEffort = !this.reasoningEffortRejected;
      requests++;
      try {
        return await provider.chat(withEffort ? { ...resolved, reasoningEffort: effort } : resolved);
      } catch (err) {
        if (withEffort && isReasoningEffortRejection(err)) {
          this.reasoningEffortRejected = true;
          (this.deps.warn ?? console.warn)(
            'The model endpoint rejected the reasoning effort parameter; continuing without it for the rest of this run.',
          );
          requests++;
          return await provider.chat(resolved);
        }
        throw err;
      }
    };

    // Read when logging: the first request of this call may have found that the endpoint rejects it.
    const logBase = () => ({
      ts: started.toISOString(),
      purpose: req.purpose,
      provider: provider.name,
      model,
      reasoningEffort: this.reasoningEffortRejected ? null : effort,
      latencyMs: now().getTime() - started.getTime(),
    });

    try {
      const response = await withRetry(send, this.deps.retry ?? DEFAULT_RETRY);
      const { usage } = response;
      // Prefer the exact cost the provider reports; fall back to config/pricing.json.
      const priced = costUsd(this.deps.pricing, model, usage);
      const cost = usage.costUsd ?? priced;
      const costSource = usage.costUsd !== undefined ? 'provider' : priced !== null ? 'pricing' : null;
      budget.add(usage.inputTokens + usage.outputTokens, cost);
      await appendCallLog(this.deps.callLogFile, {
        ...logBase(),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ok: true,
        attempts: requests,
        costUsd: cost,
        costSource,
        ...(usage.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
        ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
        ...(response.upstreamProvider ? { upstreamProvider: response.upstreamProvider } : {}),
        ...(response.systemFingerprint ? { systemFingerprint: response.systemFingerprint } : {}),
      });
      return response;
    } catch (err) {
      const safe = this.redactError(err);
      if (safe instanceof LLMRequestError) safe.attempts = requests;
      await appendCallLog(this.deps.callLogFile, {
        ...logBase(),
        inputTokens: 0,
        outputTokens: 0,
        ok: false,
        attempts: Math.max(requests, 1),
        costUsd: null,
        costSource: null,
        error: safe.message,
      });
      throw safe;
    }
  }

  /** Returns an error whose message contains no API key or header value. */
  private redactError(err: unknown): Error {
    if (err instanceof LLMRequestError) {
      return new LLMRequestError(redact(err.message, this.secrets), err.kind, err.status);
    }
    return new Error(redact(err instanceof Error ? err.message : String(err), this.secrets));
  }
}

/**
 * A 400 whose message names the reasoning effort parameter (`reasoning_effort`, or
 * `reasoning.effort` / an unsupported `reasoning` field): the endpoint does not accept it.
 */
export function isReasoningEffortRejection(err: unknown): boolean {
  if (!(err instanceof LLMRequestError) || err.status !== 400) return false;
  return (
    /reasoning[_ .]effort/i.test(err.message) ||
    /\breasoning\b.*\b(unsupported|not supported|unrecognized|not allowed|unknown)\b/i.test(err.message) ||
    /\b(unsupported|unrecognized|unknown)\b.*\breasoning\b/i.test(err.message)
  );
}

/**
 * Builds the client for one run: loads prices, rebuilds the run's totals from
 * its call log, and creates the configured provider.
 */
export async function createLLMClient(
  config: LLMConfig,
  options: { callLogFile: string; pricingFile: string; warn?: (message: string) => void },
): Promise<RunLLMClient> {
  const warn = options.warn ?? console.warn;
  const pricing = await loadPricing(options.pricingFile);
  const { lines, skipped } = await readCallLog(options.callLogFile);
  if (skipped > 0) warn(`Skipped ${skipped} unreadable line(s) in ${options.callLogFile} when totalling LLM usage.`);
  const budget = RunBudget.fromCallLog({ maxTokens: config.maxTokensPerRun, maxCostUsd: config.maxCostUsdPerRun }, lines);
  return new RunLLMClient(config, {
    provider: createProvider(config),
    pricing,
    budget,
    callLogFile: options.callLogFile,
    warn,
  });
}

function createProvider(config: LLMConfig): ChatProvider {
  if (config.provider === 'anthropic') {
    throw new Error('The anthropic provider is not implemented yet; set LLM_PROVIDER=openai-compatible.');
  }
  if (!config.baseUrl) throw new Error('LLM_BASE_URL is required for the openai-compatible provider.');
  return new OpenAICompatibleProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    extraHeaders: config.extraHeaders,
    extraBody: config.extraBody,
    reasoningParam: config.reasoningParam,
    timeoutMs: config.timeoutMs,
  });
}
