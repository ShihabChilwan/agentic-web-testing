import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
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

/** A cost cap for a measurement (SPEC §2.4): `capUsd`, and a folder shared by every process that counts against it. */
export interface CostCapOptions {
  capUsd: number;
  /** A folder where each process keeps its spend in a file of its own; without it, the cap counts this process only. */
  ledgerDir?: string;
}

/** The share of a cost cap kept free: calls stop once the spend reaches 80% of the cap, since calls already running still cost. */
export const COST_CAP_MARGIN = 0.2;

/**
 * A cost cap checked before every model call. With a ledger folder, each process writes its own total to
 * `<ledgerDir>/<pid>-<random>.json` (written whole and renamed, so a reader never sees half a file) and a
 * check sums every file there, so parallel analyses stop together. Calls stop at the cap less the margin.
 */
export class CostCap {
  private own = 0;
  private readonly file: string | undefined;

  constructor(readonly options: CostCapOptions) {
    if (!(options.capUsd > 0)) throw new Error(`The cost cap must be a positive number of US dollars: ${options.capUsd}`);
    this.file = options.ledgerDir ? path.join(options.ledgerDir, `${process.pid}-${randomUUID()}.json`) : undefined;
  }

  /** The spend at which calls stop. */
  get stopAtUsd(): number {
    return this.options.capUsd * (1 - COST_CAP_MARGIN);
  }

  /** This process's spend plus, with a ledger folder, every other process's. */
  async spentUsd(): Promise<number> {
    if (!this.options.ledgerDir) return this.own;
    const names = await readdir(this.options.ledgerDir).catch(() => [] as string[]);
    let total = this.own;
    for (const name of names) {
      const file = path.join(this.options.ledgerDir, name);
      if (!name.endsWith('.json') || file === this.file) continue;
      const entry = await readFile(file, 'utf8').then((t) => JSON.parse(t) as { spentUsd?: unknown }, () => null);
      if (entry && typeof entry.spentUsd === 'number') total += entry.spentUsd;
    }
    return total;
  }

  /** Throws when the spend has reached the stop point, so the next call never starts. */
  async check(): Promise<void> {
    const spent = await this.spentUsd();
    if (spent >= this.stopAtUsd) {
      throw new LLMBudgetExceededError(
        `cost cap reached: $${spent.toFixed(4)} spent of a $${this.options.capUsd.toFixed(2)} cap (calls stop at ${Math.round((1 - COST_CAP_MARGIN) * 100)}%, $${this.stopAtUsd.toFixed(4)})`,
      );
    }
  }

  /** Records the cost of one finished call. */
  async add(costUsd: number | null): Promise<void> {
    this.own += costUsd ?? 0;
    if (!this.file) return;
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify({ spentUsd: this.own, pid: process.pid, updatedAt: new Date().toISOString() }));
    await rename(tmp, this.file);
  }
}
