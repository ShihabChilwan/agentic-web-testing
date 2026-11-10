import path from 'node:path';
import { executeRun, type ExecuteRunResult } from '../execution-engine/execute.js';
import { RUNS_DIR } from '../../shared/paths.js';
import { writeNoiseFile } from './noise.js';

export interface MeasureNoiseOptions {
  runId: string;
  /** Two or more executions that already recorded responses; when absent, `runs` new executions of the generation ref are run. */
  executions?: string[];
  /** New executions to run when `executions` is absent (default 3). */
  runs?: number;
  /** Two or more executions that recorded page snapshots, for the page noise; new executions record pages and are used for it. */
  pageExecutions?: string[];
  runsDir?: string;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

/**
 * `agent noise` (SPEC §7.6): two or more recorded executions of the generation version (run now unless
 * given), then noise-fields.json from their responses, every pair compared. No model call.
 */
export async function measureNoise(options: MeasureNoiseOptions) {
  const runsDir = options.runsDir ?? RUNS_DIR;
  const log = options.log ?? (() => {});
  const ran: ExecuteRunResult[] = [];
  let executions = options.executions;
  if (!executions) {
    const count = options.runs ?? 3;
    if (count < 2) throw new Error('noise needs two or more executions');
    for (let n = 1; n <= count; n++) {
      log(`Execution ${n} of ${count} (generation ref, recording responses and pages)`);
      ran.push(await executeRun({ runId: options.runId, runsDir, recordResponses: true, recordPages: true, log, ...(options.signal ? { signal: options.signal } : {}) }));
    }
    executions = ran.map((r) => r.execId);
  }
  if (executions.length < 2) throw new Error('noise needs two or more executions');
  const pageExecutions = options.pageExecutions ?? (ran.length > 0 ? executions : undefined);
  const written = await writeNoiseFile(path.join(runsDir, options.runId), executions, pageExecutions);
  return { ...written, executed: ran };
}
