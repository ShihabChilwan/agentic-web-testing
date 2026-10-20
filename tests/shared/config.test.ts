import { describe, expect, it } from 'vitest';
import { ConfigError, modelFor, parseLLMConfig, reasoningEffortFor } from '../../src/shared/config.js';

// Values are passed in directly; these tests never read .env or process.env.
const minimal = { LLM_BASE_URL: 'http://model.test/v1' };

function configError(env: Record<string, string | undefined>): string {
  try {
    parseLLMConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as Error).message;
  }
  throw new Error('expected parseLLMConfig to throw');
}

describe('parseLLMConfig', () => {
  it('applies the documented defaults', () => {
    const config = parseLLMConfig(minimal);
    expect(config).toMatchObject({
      provider: 'openai-compatible',
      model: 'z-ai/glm-5.3-flash',
      temperature: 1.0,
      topP: 1.0,
      reasoningEffort: 'medium',
      reasoningEfforts: { prd: 'medium', cases: 'low', scripts: 'medium', analyzer: 'medium' },
      concurrency: 4,
      contextTokens: 131072,
      timeoutMs: 1_200_000,
      maxTokensPerRun: 20_000_000,
      maxCostUsdPerRun: 2.0,
      extraHeaders: {},
    });
  });

  it('treats empty strings as unset, as in .env.example', () => {
    const config = parseLLMConfig({
      ...minimal,
      LLM_API_KEY: '',
      LLM_EXTRA_HEADERS: '',
      LLM_MODEL_PRD: '',
      LLM_CONCURRENCY: '',
      LLM_REASONING_EFFORT_CASES: '',
    });
    expect(config.apiKey).toBeUndefined();
    expect(config.extraHeaders).toEqual({});
    expect(config.models.prd).toBe('z-ai/glm-5.3-flash');
    expect(config.concurrency).toBe(4);
    expect(config.reasoningEfforts.cases).toBe('low');
  });

  it('parses numbers, overrides and extra headers', () => {
    const config = parseLLMConfig({
      ...minimal,
      LLM_MODEL: 'base-model',
      LLM_MODEL_ANALYZER: 'analyzer-model',
      LLM_REASONING_EFFORT_CASES: 'high',
      LLM_CONCURRENCY: '8',
      LLM_TEMPERATURE: '0.5',
      LLM_EXTRA_HEADERS: '{"X-Test-Key":"k","X-Test-Secret":"s"}',
    });
    expect(config.models).toEqual({ prd: 'base-model', cases: 'base-model', scripts: 'base-model', analyzer: 'analyzer-model' });
    expect(config.reasoningEfforts.cases).toBe('high');
    expect(config.concurrency).toBe(8);
    expect(config.temperature).toBe(0.5);
    expect(config.extraHeaders).toEqual({ 'X-Test-Key': 'k', 'X-Test-Secret': 's' });
  });

  it('requires LLM_BASE_URL for the openai-compatible provider', () => {
    expect(configError({})).toContain('LLM_BASE_URL');
  });

  it('rejects bad values and names the variable', () => {
    expect(configError({ ...minimal, LLM_REASONING_EFFORT_PRD: 'extreme' })).toContain('LLM_REASONING_EFFORT_PRD');
    expect(configError({ ...minimal, LLM_CONCURRENCY: '0' })).toContain('LLM_CONCURRENCY');
    expect(configError({ ...minimal, LLM_CONCURRENCY: 'four' })).toContain('LLM_CONCURRENCY');
    expect(configError({ ...minimal, LLM_PROVIDER: 'gemini' })).toContain('LLM_PROVIDER');
    expect(configError({ ...minimal, LLM_EXTRA_HEADERS: '["a"]' })).toContain('LLM_EXTRA_HEADERS');
  });

  it('never echoes header values in error messages', () => {
    const secret = 'super-secret-token-123';
    const notJson = configError({ ...minimal, LLM_EXTRA_HEADERS: `Modal-Key: ${secret}` });
    const wrongShape = configError({ ...minimal, LLM_EXTRA_HEADERS: `{"Modal-Key": {"v": "${secret}"}}` });
    expect(notJson).toContain('LLM_EXTRA_HEADERS');
    expect(notJson).not.toContain(secret);
    expect(wrongShape).not.toContain(secret);
  });
});

describe('per-purpose settings', () => {
  const config = parseLLMConfig({ ...minimal, LLM_MODEL_SCRIPTS: 'scripts-model', LLM_REASONING_EFFORT: 'low' });

  it('uses module overrides for module purposes', () => {
    expect(modelFor(config, 'scripts')).toBe('scripts-model');
    expect(reasoningEffortFor(config, 'analyzer')).toBe('medium');
  });

  it('falls back to the defaults for other purposes', () => {
    expect(modelFor(config, 'one-prompt')).toBe('z-ai/glm-5.3-flash');
    expect(reasoningEffortFor(config, 'one-prompt')).toBe('low');
  });
});

describe('LLM_EXTRA_BODY and LLM_REASONING_PARAM', () => {
  it('defaults to an empty extra body', () => {
    expect(parseLLMConfig(minimal).extraBody).toEqual({});
    expect(parseLLMConfig({ ...minimal, LLM_EXTRA_BODY: '' }).extraBody).toEqual({});
  });

  it('parses a JSON object, e.g. provider pinning', () => {
    const body = { provider: { only: ['wafer/nvfp4'], allow_fallbacks: false } };
    expect(parseLLMConfig({ ...minimal, LLM_EXTRA_BODY: JSON.stringify(body) }).extraBody).toEqual(body);
  });

  it('rejects invalid JSON, non-objects and fields the client sets', () => {
    expect(configError({ ...minimal, LLM_EXTRA_BODY: '{provider' })).toMatch(/LLM_EXTRA_BODY: must be a JSON object/);
    expect(configError({ ...minimal, LLM_EXTRA_BODY: '[1,2]' })).toContain('LLM_EXTRA_BODY');
    expect(configError({ ...minimal, LLM_EXTRA_BODY: '"text"' })).toContain('LLM_EXTRA_BODY');
    expect(configError({ ...minimal, LLM_EXTRA_BODY: '{"model":"x"}' })).toMatch(/must not set "model"/);
    expect(configError({ ...minimal, LLM_EXTRA_BODY: '{"reasoning":{"effort":"high"}}' })).toMatch(/"reasoning"/);
  });

  it('accepts both reasoning formats and rejects others', () => {
    expect(parseLLMConfig({ ...minimal, LLM_REASONING_PARAM: 'reasoning_object' }).reasoningParam).toBe('reasoning_object');
    expect(parseLLMConfig({ ...minimal, LLM_REASONING_PARAM: 'reasoning_effort' }).reasoningParam).toBe('reasoning_effort');
    expect(configError({ ...minimal, LLM_REASONING_PARAM: 'effort' })).toContain('LLM_REASONING_PARAM');
  });
});
