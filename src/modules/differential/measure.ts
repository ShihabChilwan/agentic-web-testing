import path from 'node:path';
import { executeRun, type ExecuteRunResult } from '../execution-engine/execute.js';
import { RUNS_DIR } from '../../shared/paths.js';
import { writeNoiseFile } from './noise.js';

export interface MeasureNoiseOptions {
  runId: string;
  /** Two executions that already recorded responses; when absent, two new executions of the generation ref are run. */
  executions?: [string, string];
  runsDir?: string;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

/**
 * `agent noise` (SPEC §7.6): two recorded executions of the generation version (run now unless given),
 * then noise-fields.json from their responses. No model call.
 */
export async function measureNoise(options: MeasureNoiseOptions) {
  const runsDir = options.runsDir ?? RUNS_DIR;
  const log = options.log ?? (() => {});
  const ran: ExecuteRunResult[] = [];
  let executions = options.executions;
  if (!executions) {
    for (const n of [1, 2]) {
      log(`Execution ${n} of 2 (generation ref, recording responses)`);
      ran.push(await executeRun({ runId: options.runId, runsDir, recordResponses: true, log, ...(options.signal ? { signal: options.signal } : {}) }));
    }
    executions = [ran[0]!.execId, ran[1]!.execId];
  }
  const written = await writeNoiseFile(path.join(runsDir, options.runId), executions);
  return { ...written, executed: ran };
}
