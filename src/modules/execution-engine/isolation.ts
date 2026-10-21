import { stat } from 'node:fs/promises';
import type { HealthCheckResult, Incident } from '../../shared/schemas.js';
import { waitForHealthy } from './health.js';
import type { RunningTarget } from './lifecycle.js';

/** After this many failed restores in a row, restores stop for the rest of the run (SPEC §7.2). */
export const MAX_FAILED_RESTORES = 2;
/** After this many failed frontend restarts in a row, the frontend is no longer restarted. */
export const MAX_FAILED_FRONTEND_RESTARTS = 2;

export interface TestRecord {
  /** True only when the restore before this test succeeded. */
  isolated: boolean;
  /** Size of the backend log when the test started and ended: the test's own log lines. */
  logStart: number;
  logEnd?: number;
  outputDir?: string;
}

export interface IsolationOptions {
  /** The execution's server/backend.log. */
  backendLog: string;
  frontendHealthUrl: string;
  /** Quick frontend check before each test (default: its health check within 5 s). */
  frontendUp?: () => Promise<boolean>;
  log?: (message: string) => void;
}

type IsolationTarget = Pick<RunningTarget, 'restore' | 'restartFrontend' | 'exitOf'>;

const sizeOf = (file: string) => stat(file).then((s) => s.size, () => 0);

/**
 * Before every test: check both services (restart a crashed frontend, note a crashed backend), then
 * restore the data. A test whose restore failed runs anyway, marked not isolated; after
 * MAX_FAILED_RESTORES failures in a row, restores stop and every later test is not isolated.
 */
export class TestIsolation {
  readonly records = new Map<string, TestRecord>();
  readonly incidents: Incident[] = [];
  restores = 0;
  restoreMs = 0;
  givenUp = false;
  private failedRestores = 0;
  private failedFrontendRestarts = 0;
  private readonly frontendUp: () => Promise<boolean>;

  constructor(
    private readonly target: IsolationTarget,
    private readonly options: IsolationOptions,
  ) {
    this.frontendUp =
      options.frontendUp ??
      (async () => (await waitForHealthy('frontend', options.frontendHealthUrl, { timeoutMs: 5000, intervalMs: 500 })).ok);
  }

  private incident(beforeTestCaseId: string | null, kind: Incident['kind'], detail: string): void {
    this.incidents.push({ beforeTestCaseId, kind, detail });
    this.options.log?.(`${kind}${beforeTestCaseId ? ` before ${beforeTestCaseId}` : ''}: ${detail}`);
  }

  /** Notes a backend that exited since it was last started; the next restore starts it again. */
  private checkBackend(testId: string | null): void {
    const exit = this.target.exitOf('backend');
    if (exit) this.incident(testId, 'backend-crashed', `the backend process had exited (${exit.code !== null ? `code ${exit.code}` : `signal ${exit.signal}`})`);
  }

  private async checkFrontend(testId: string): Promise<void> {
    if (this.failedFrontendRestarts >= MAX_FAILED_FRONTEND_RESTARTS) return;
    const exit = this.target.exitOf('frontend');
    if (!exit && (await this.frontendUp())) return;
    const why = exit ? `the frontend process had exited (${exit.code !== null ? `code ${exit.code}` : `signal ${exit.signal}`})` : 'the frontend did not answer its health check';
    let health: HealthCheckResult | undefined;
    try {
      health = await this.target.restartFrontend();
    } catch (err) {
      this.options.log?.(`Frontend restart threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (health?.ok) {
      this.failedFrontendRestarts = 0;
      this.incident(testId, 'frontend-restarted', `${why}; restarted`);
    } else {
      this.failedFrontendRestarts++;
      const last = this.failedFrontendRestarts >= MAX_FAILED_FRONTEND_RESTARTS ? '; no further restarts' : '';
      this.incident(testId, 'frontend-restart-failed', `${why}; the restart did not make it healthy${last}`);
    }
  }

  /** Returns true when the data was restored (the test is isolated). */
  private async restore(testId: string): Promise<boolean> {
    if (this.givenUp) return false;
    const started = Date.now();
    this.restores++;
    let failure: string | null = null;
    try {
      const result = await this.target.restore();
      if (!result.backendHealthy) failure = result.problems.join('; ') || 'the backend was not healthy after the restore';
      else if (result.problems.length > 0) this.incident(testId, 'restore-problem', result.problems.join('; '));
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    this.restoreMs += Date.now() - started;
    if (failure === null) {
      this.failedRestores = 0;
      return true;
    }
    this.failedRestores++;
    this.incident(testId, 'restore-failed', failure);
    if (this.failedRestores >= MAX_FAILED_RESTORES) {
      this.givenUp = true;
      this.incident(testId, 'restores-given-up', `${MAX_FAILED_RESTORES} restores failed in a row; this and every later test run without a data restore (not isolated)`);
    }
    return false;
  }

  async before(testId: string): Promise<void> {
    if (!this.givenUp) this.checkBackend(testId);
    await this.checkFrontend(testId);
    const isolated = await this.restore(testId);
    this.records.set(testId, { isolated, logStart: await sizeOf(this.options.backendLog) });
  }

  async after(testId: string, outputDir: string): Promise<void> {
    const record = this.records.get(testId);
    if (!record) throw new Error(`/after for ${testId} without /before`);
    record.logEnd = await sizeOf(this.options.backendLog);
    record.outputDir = outputDir;
  }

  /** After the last test: a backend that crashed during it is recorded too. */
  finish(): void {
    if (!this.givenUp) this.checkBackend(null);
  }
}
