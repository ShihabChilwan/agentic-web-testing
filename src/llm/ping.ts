// Sends one request to the configured model endpoint and prints what came back.
// Usage: npm run llm:ping
import { loadLLMConfig } from '../shared/config.js';
import { PRICING_FILE, makeRunId, runPaths } from '../shared/paths.js';
import { createLLMClient } from './client.js';

const config = await loadLLMConfig();
const paths = runPaths(makeRunId('ping'));
const client = await createLLMClient(config, { callLogFile: paths.llmCalls, pricingFile: PRICING_FILE });

const extraKeys = Object.keys(config.extraBody);
console.log(`Provider ${config.provider}, model ${config.model}. Sending one request...`);
// Field names only: values stay out of the output.
console.log(`Extra body fields: ${extraKeys.length ? extraKeys.join(', ') : 'none'}; reasoning format: ${config.reasoningParam}`);
console.log('(The first request after the endpoint has been idle can take several minutes while the model loads.)');

try {
  const response = await client.chat({
    purpose: 'ping',
    system: 'You are a helpful assistant.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word: pong' }] }],
    maxTokens: 512,
    reasoningEffort: 'low',
  });
  const text = response.content
    .flatMap((b) => (b.type === 'text' ? [b.text] : []))
    .join(' ')
    .trim();
  console.log(`model:      ${response.model}`);
  console.log(`provider:   ${response.upstreamProvider ?? 'not reported'}`);
  console.log(`latency:    ${response.latencyMs} ms`);
  const { usage } = response;
  console.log(`tokens:     ${usage.inputTokens} in, ${usage.outputTokens} out`);
  console.log(`reasoning tokens: ${usage.reasoningTokens ?? 'not reported'}`);
  console.log(`cost:       ${usage.costUsd !== undefined ? `$${usage.costUsd.toFixed(6)} (reported by provider)` : 'not reported'}`);
  console.log(`stop:       ${response.stopReason}`);
  console.log(`reasoning:  ${response.reasoning ? `${response.reasoning.length} characters` : 'none returned'}`);
  console.log(`reply:      ${text.slice(0, 200) || '(empty)'}`);
  console.log(`call log:   ${paths.llmCalls}`);
} catch (err) {
  // Errors from the client are already redacted (no keys or header values).
  console.error(`Ping failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  process.exitCode = 1;
}
