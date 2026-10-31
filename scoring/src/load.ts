import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Diagnoses, EvalMapping, ExecutionResults } from '../../src/shared/schemas.js';

export interface LoadedVersion {
  version: string;
  execId: string | null;
  /** Wall-clock of the cloud task, from mapping.json. */
  executionMs: number;
  results: ExecutionResults | null;
  /** Null when the execution was never analysed. */
  diagnoses: Diagnoses | null;
}

export interface LoadedSuite {
  runDir: string;
  repeatId: string;
  versions: Map<string, LoadedVersion>;
}

async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Reads one imported run: eval/mapping.json, and per version its results.json and (when present) diagnoses.json. */
export async function loadSuite(runDir: string): Promise<LoadedSuite> {
  const mappingRaw = await readJson(path.join(runDir, 'eval', 'mapping.json'));
  if (mappingRaw === null) throw new Error(`${runDir} has no eval/mapping.json: it is not an imported cloud run`);
  const mapping = EvalMapping.parse(mappingRaw);
  const versions = new Map<string, LoadedVersion>();
  for (const v of mapping.versions) {
    let results: ExecutionResults | null = null;
    let diagnoses: Diagnoses | null = null;
    if (v.execId !== null) {
      const dir = path.join(runDir, 'executions', v.execId);
      const r = await readJson(path.join(dir, 'results.json'));
      if (r === null) throw new Error(`${dir}/results.json is missing for ${v.version}`);
      results = ExecutionResults.parse(r);
      const d = await readJson(path.join(dir, 'diagnoses.json'));
      diagnoses = d === null ? null : Diagnoses.parse(d);
    }
    versions.set(v.version, { version: v.version, execId: v.execId, executionMs: v.durationMs, results, diagnoses });
  }
  if (!versions.has('golden')) throw new Error(`${runDir} has no golden execution in its mapping`);
  return { runDir, repeatId: mapping.repeatId, versions };
}
