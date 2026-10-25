import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Project root (the folder holding package.json). */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const RUNS_DIR = path.join(PROJECT_ROOT, 'runs');
export const TARGETS_DIR = path.join(PROJECT_ROOT, 'targets');
export const PRICING_FILE = path.join(PROJECT_ROOT, 'config', 'pricing.json');

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** `<target>-YYYYMMDD-HHmmss` in UTC. */
export function makeRunId(target: string, now: Date = new Date()): string {
  const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `${target}-${date}-${time}`;
}

export function targetPaths(name: string, targetsDir: string = TARGETS_DIR) {
  const dir = path.join(targetsDir, name);
  return {
    dir,
    config: path.join(dir, 'target.config.json'),
    variants: path.join(dir, 'variants.json'),
    variantsDir: path.join(dir, 'variants'),
    repo: path.join(dir, 'repo'),
  };
}

/** Absolute paths of the files in a run directory. */
export function runPaths(runId: string, runsDir: string = RUNS_DIR) {
  const dir = path.join(runsDir, runId);
  const executionDir = (execId: string) => path.join(dir, 'executions', execId);
  return {
    dir,
    runJson: path.join(dir, 'run.json'),
    llmCalls: path.join(dir, 'llm-calls.jsonl'),
    transcriptsDir: path.join(dir, 'transcripts'),
    prd: path.join(dir, 'prd.json'),
    coverageDir: path.join(dir, 'coverage'),
    coverage: path.join(dir, 'coverage', 'coverage.json'),
    testCases: path.join(dir, 'testcases.json'),
    scriptsDir: path.join(dir, 'scripts'),
    scriptsManifest: path.join(dir, 'scripts', 'manifest.json'),
    executionDir,
    results: (execId: string) => path.join(executionDir(execId), 'results.json'),
    artifactsDir: (execId: string, testId: string) => path.join(executionDir(execId), 'artifacts', testId),
    serverLogsDir: (execId: string) => path.join(executionDir(execId), 'server'),
    diagnoses: (execId: string) => path.join(executionDir(execId), 'diagnoses.json'),
    diagnosesNoTools: (execId: string) => path.join(executionDir(execId), 'diagnoses.no-tools.json'),
    onePromptDir: path.join(dir, 'ablation', 'one-prompt'),
    evalDir: path.join(dir, 'eval'),
  };
}
