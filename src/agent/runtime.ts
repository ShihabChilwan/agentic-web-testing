import { z } from 'zod';
import type { ZodType } from 'zod';
import type { ChatResponse, Message, TextBlock, ToolCallBlock, ToolDef, ToolResultBlock, Usage } from '../llm/types.js';
import { estimateTokens, guardContext } from './context-guard.js';
import { Transcript } from './transcript.js';
import { AgentBudgetError, AgentSubmitError } from './types.js';
import type { AgentDeps, AgentResult, AgentTool, RunAgentOptions, ToolStats } from './types.js';

export const TOOL_OUTPUT_LIMIT = 20_000;
export const SUBMIT_ATTEMPTS = 3;
export const DEFAULT_MAX_TOKENS_PER_CALL = 32_768;
/**
 * Runaway ceiling for exploring tool calls, shared by the PRD Generator and the one-prompt ablation.
 * A safety net, not a target: prompts never mention it.
 */
export const DEFAULT_EXPLORATION_CEILING = 200;
const MIN_TOKENS_PER_CALL = 1_024;

/**
 * Output limit for the next call. Servers such as vLLM reject a request whose
 * input plus output limit exceeds the context window, so the limit shrinks as
 * the conversation grows, keeping 5% of the context as a margin for the estimate.
 */
export function outputLimit(maxTokensPerCall: number, contextTokens: number, inputEstimate: number): number {
  const room = Math.floor(contextTokens * 0.95) - inputEstimate;
  return Math.max(MIN_TOKENS_PER_CALL, Math.min(maxTokensPerCall, room));
}

export const BUDGET_EXHAUSTED_MESSAGE = 'Budget exhausted. Submit your result now.';
export const wrapUpMessage = (toolNames: string[], submitName: string) =>
  `Tool budget for exploring is used up. Record any remaining findings with ${toolNames.join(', ')}, then call ${submitName}.`;
export const NUDGE_MESSAGE = 'Use a tool or submit your result.';
export const OUT_OF_SPACE_MESSAGE =
  'Your last reply ran out of space before you acted. Think less and call a tool or submit now.';

/** JSON Schema for a tool input, without the `$schema` header (saves tokens on every call). */
export function toJsonSchema(schema: ZodType): Record<string, unknown> {
  const { $schema: _omit, ...rest } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
  return rest;
}

export function truncateToolOutput(text: string, limit = TOOL_OUTPUT_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[output truncated: showing ${limit} of ${text.length} characters]`;
}

function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message));
}

/**
 * Runs one agent session: the model works with the given tools until it
 * submits a result that passes the schema and `validate`, or the session runs
 * out of budget or submit attempts.
 */
export async function runAgent<O>(opts: RunAgentOptions<O>, deps: AgentDeps): Promise<AgentResult<O>> {
  const started = Date.now();
  const maxToolCalls = opts.budget.maxToolCalls;
  const maxTurns = opts.budget.maxTurns ?? maxToolCalls + 10;
  const toolsByName = new Map(opts.tools.map((t) => [t.name, t]));
  if (toolsByName.has(opts.submit.name)) throw new Error(`Tool name "${opts.submit.name}" clashes with the submit tool`);

  const submitDef: ToolDef = {
    name: opts.submit.name,
    description: opts.submit.description,
    inputSchema: toJsonSchema(opts.submit.schema),
  };
  if (submitDef.inputSchema.type !== 'object') throw new Error('The submit schema must describe a JSON object');
  const toDef = (t: AgentTool<unknown>): ToolDef => ({ name: t.name, description: t.description, inputSchema: toJsonSchema(t.input) });
  const allDefs: ToolDef[] = [...opts.tools.map(toDef), submitDef];
  // Tools that do not count toward the budget stay available in a wrap-up phase once exploring is over.
  const uncounted = opts.tools.filter((t) => t.countsTowardBudget === false);
  const wrapUpDefs: ToolDef[] = [...uncounted.map(toDef), submitDef];

  const transcript = deps.transcriptDir ? await Transcript.create(deps.transcriptDir, opts.purpose) : Transcript.none();
  await transcript.write('start', {
    purpose: opts.purpose,
    system: opts.system,
    task: opts.task,
    tools: allDefs.map((d) => d.name),
    budget: { maxToolCalls, maxTurns },
  });

  let messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: opts.task }] }];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let toolCalls = 0;
  let uncountedToolCalls = 0;
  const toolStats: Record<string, ToolStats> = {};
  const runCounted = async (tool: AgentTool<unknown> | undefined, call: ToolCallBlock) => {
    const { result, outcome } = await runTool(tool, call);
    const stats = (toolStats[call.name] ??= { calls: 0, invalidInput: 0, errors: 0 });
    stats.calls++;
    if (outcome === 'invalidInput') stats.invalidInput++;
    if (outcome === 'error') stats.errors++;
    return result;
  };
  let turns = 0;
  let submitAttemptsLeft = SUBMIT_ATTEMPTS;
  // explore: every tool; wrapUp: only uncounted tools and submit; final: one submit-only turn.
  let phase: 'explore' | 'wrapUp' | 'final' = 'explore';
  // Context estimate: tokens of the last request plus characters added since.
  let baseTokens = estimateTokens(opts.system.length + JSON.stringify(allDefs).length);
  let baseMessageCount = 0;

  const details = () => ({
    toolCalls,
    uncountedToolCalls,
    toolStats: structuredClone(toolStats),
    budgetExhausted: toolCalls >= maxToolCalls,
    turns,
    usage: { ...usage },
  });
  const addUserBlocks = (blocks: Array<TextBlock | ToolResultBlock>) => {
    const last = messages.at(-1);
    if (last?.role === 'user') last.content.push(...blocks);
    else messages.push({ role: 'user', content: blocks });
  };

  try {
    for (;;) {
      if (phase === 'explore' && toolCalls >= maxToolCalls && uncounted.length > 0 && turns < maxTurns) {
        phase = 'wrapUp';
        const text = wrapUpMessage(uncounted.map((t) => t.name), opts.submit.name);
        addUserBlocks([{ type: 'text', text }]);
        await transcript.write('budget_exhausted', { phase, toolCalls, turns });
      }
      if (phase !== 'final' && (turns >= maxTurns || (phase === 'explore' && toolCalls >= maxToolCalls))) {
        phase = 'final';
        addUserBlocks([{ type: 'text', text: BUDGET_EXHAUSTED_MESSAGE }]);
        await transcript.write('budget_exhausted', { phase, toolCalls, turns });
      }
      const finalTurn = phase === 'final';

      const guarded = guardContext({ messages, baseTokens, baseMessageCount, contextTokens: deps.contextTokens });
      if (guarded.trims.length > 0) {
        messages = guarded.messages;
        await transcript.write('trim', {
          estimateBefore: guarded.estimateBefore,
          estimateAfter: guarded.estimateAfter,
          trims: guarded.trims,
        });
      }

      turns++;
      const requestMessageCount = messages.length;
      const response: ChatResponse = await deps.llm.chat({
        purpose: opts.purpose,
        system: opts.system,
        messages,
        tools: finalTurn ? [submitDef] : phase === 'wrapUp' ? wrapUpDefs : allDefs,
        maxTokens: outputLimit(deps.maxTokensPerCall ?? DEFAULT_MAX_TOKENS_PER_CALL, deps.contextTokens, guarded.estimateAfter),
      });
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;
      baseTokens = response.usage.inputTokens;
      baseMessageCount = requestMessageCount;

      messages.push({
        role: 'assistant',
        content: response.content,
        ...(response.reasoning ? { reasoning: response.reasoning } : {}),
        ...(response.reasoningDetails ? { reasoningDetails: response.reasoningDetails } : {}),
      });
      await transcript.write('response', {
        turn: turns,
        content: response.content,
        reasoning: response.reasoning,
        reasoningDetails: response.reasoningDetails,
        stopReason: response.stopReason,
        usage: response.usage,
        latencyMs: response.latencyMs,
      });

      const calls = response.content.filter((b): b is ToolCallBlock => b.type === 'tool_call');
      if (calls.length === 0) {
        if (finalTurn) throw new AgentBudgetError('Budget exhausted and no result was submitted', details());
        // A reply cut off by the output limit (usually by long reasoning) is a failed turn: ask for less thinking.
        const nudge = response.stopReason === 'max_tokens' ? OUT_OF_SPACE_MESSAGE : NUDGE_MESSAGE;
        addUserBlocks([{ type: 'text', text: nudge }]);
        await transcript.write('nudge', { text: nudge, stopReason: response.stopReason });
        continue;
      }

      const results: ToolResultBlock[] = [];
      let submitted = false;
      for (const call of calls) {
        if (call.name === opts.submit.name) {
          submitted = true;
          const check = await checkSubmission(opts, call.input);
          if (check.ok) {
            await transcript.write('submit', { toolCallId: call.id, ok: true });
            await transcript.write('end', { ok: true, ...details(), durationMs: Date.now() - started });
            return {
              output: check.output,
              ...details(),
              durationMs: Date.now() - started,
              ...(transcript.file ? { transcriptFile: transcript.file } : {}),
            };
          }
          submitAttemptsLeft--;
          await transcript.write('submit', { toolCallId: call.id, ok: false, errors: check.errors, submitAttemptsLeft });
          if (submitAttemptsLeft === 0) {
            throw new AgentSubmitError(
              `All ${SUBMIT_ATTEMPTS} submit attempts were rejected`,
              check.errors,
              details(),
            );
          }
          results.push({
            type: 'tool_result',
            toolCallId: call.id,
            isError: true,
            content: `Submission rejected (${submitAttemptsLeft} attempt(s) left). Fix these problems and submit again:\n${check.errors.map((e) => `- ${e}`).join('\n')}`,
          });
          continue;
        }

        const tool = toolsByName.get(call.name);
        let result: ToolResultBlock;
        if (finalTurn) {
          result = errorResult(call, `Only ${opts.submit.name} is available now. ${BUDGET_EXHAUSTED_MESSAGE}`);
        } else if (tool?.countsTowardBudget === false) {
          uncountedToolCalls++;
          result = await runCounted(tool, call);
        } else if (phase === 'wrapUp' || toolCalls >= maxToolCalls) {
          result = errorResult(call, `Tool budget exhausted; this call was not run.`);
        } else {
          toolCalls++;
          result = await runCounted(tool, call);
        }
        results.push(result);
        await transcript.write('tool_result', {
          toolCallId: call.id,
          name: call.name,
          isError: result.isError ?? false,
          content: result.content,
        });
      }
      addUserBlocks(results);

      // In the final turn only a (rejected) submission earns another turn, while attempts remain.
      if (finalTurn && !submitted) throw new AgentBudgetError('Budget exhausted and no result was submitted', details());
    }
  } catch (err) {
    await transcript.write('end', {
      ok: false,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      ...details(),
      durationMs: Date.now() - started,
    });
    throw err;
  }
}

type SubmissionCheck<O> = { ok: true; output: O } | { ok: false; errors: string[] };

async function checkSubmission<O>(opts: RunAgentOptions<O>, input: unknown): Promise<SubmissionCheck<O>> {
  const parsed = opts.submit.schema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: formatZodIssues(parsed.error) };
  const errors = opts.submit.validate ? await opts.submit.validate(parsed.data) : [];
  return errors.length > 0 ? { ok: false, errors } : { ok: true, output: parsed.data };
}

function errorResult(call: ToolCallBlock, content: string): ToolResultBlock {
  return { type: 'tool_result', toolCallId: call.id, isError: true, content };
}

async function runTool(
  tool: AgentTool<any> | undefined, // eslint-disable-line @typescript-eslint/no-explicit-any
  call: ToolCallBlock,
): Promise<{ result: ToolResultBlock; outcome: 'ok' | 'invalidInput' | 'error' }> {
  if (!tool) return { result: errorResult(call, `Unknown tool "${call.name}".`), outcome: 'invalidInput' };
  const parsed = tool.input.safeParse(call.input);
  if (!parsed.success) {
    const message = `Invalid input for ${call.name}:\n${formatZodIssues(parsed.error).map((e) => `- ${e}`).join('\n')}`;
    return { result: errorResult(call, message), outcome: 'invalidInput' };
  }
  try {
    const output = await tool.run(parsed.data);
    return { result: { type: 'tool_result', toolCallId: call.id, content: truncateToolOutput(output) }, outcome: 'ok' };
  } catch (err) {
    const message = truncateToolOutput(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return { result: errorResult(call, message), outcome: 'error' };
  }
}
