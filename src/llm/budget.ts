import { LLMBudgetExceededError } from './errors.js';
import type { LLMCallLogLine } from '../shared/schemas.js';

export interface BudgetCaps {
  maxTokens: number;
  maxCostUsd: number;
}

/**
 * Running token and cost totals for one run, with hard caps.
 * Totals start from the run's call log, so the caps hold across separate CLI commands.
 */
export class RunBudget {
  tokens = 0;
  costUsd = 0;

  constructor(readonly caps: BudgetCaps) {}

  static fromCallLog(caps: BudgetCaps, lines: readonly LLMCallLogLine[]): RunBudget {
    const budget = new RunBudget(caps);
    for (const line of lines) budget.add(line.inputTokens + line.outputTokens, line.costUsd);
    return budget;
  }

  /** Throws when a cap has been reached, so the next call never starts. */
  check(): void {
    if (this.tokens >= this.caps.maxTokens) {
      throw new LLMBudgetExceededError(
        `token cap reached: ${this.tokens} of ${this.caps.maxTokens} tokens used in this run (LLM_MAX_TOKENS_PER_RUN)`,
      );
    }
    if (this.costUsd >= this.caps.maxCostUsd) {
      throw new LLMBudgetExceededError(
        `cost cap reached: $${this.costUsd.toFixed(4)} of $${this.caps.maxCostUsd.toFixed(2)} used in this run (LLM_MAX_COST_USD_PER_RUN)`,
      );
    }
  }

  add(tokens: number, costUsd: number | null): void {
    this.tokens += tokens;
    this.costUsd += costUsd ?? 0;
  }
}
