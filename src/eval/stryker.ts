import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { PROJECT_ROOT } from '../shared/paths.js';
import type { EvaluationConfig } from '../shared/schemas.js';

const execFileAsync = promisify(execFile);

const STRYKER_TIMEOUT_MS = 30 * 60_000;

/** Behaviour-changing mutators kept as candidates (SPEC §11.2). */
export const MUTATORS = [
  'ConditionalExpression',
  'EqualityOperator',
  'LogicalOperator',
  'BooleanLiteral',
  'ArithmeticOperator',
  'UnaryOperator',
  'OptionalChaining',
  'MethodExpression',
] as const;

const Position = z.object({ line: z.number().int().positive(), column: z.number().int().positive() });

/** The parts of Stryker's mutation.json that are used (mutation-testing-report-schema; unknown keys ignored). */
export const MutationReport = z.object({
  files: z.record(
    z.string(),
    z.object({
      source: z.string(),
      mutants: z.array(
        z.object({
          id: z.string().min(1),
          mutatorName: z.string().min(1),
          replacement: z.string().optional(),
          location: z.object({ start: Position, end: Position }),
        }),
      ),
    }),
  ),
});

export type MutationReport = z.infer<typeof MutationReport>;

export interface MutantList {
  report: MutationReport;
  /** Copy of Stryker's mutation.json in the work folder. */
  reportFile: string;
  sha256: string;
  version: string;
  mutants: number;
}

/** The installed @stryker-mutator/core version (pinned in package.json). */
export async function strykerVersion(): Promise<string> {
  const require = createRequire(path.join(PROJECT_ROOT, 'package.json'));
  const pkg = JSON.parse(await readFile(require.resolve('@stryker-mutator/core/package.json'), 'utf8')) as { version: string };
  return pkg.version;
}

/** Stryker config for listing only: the no-op command runner, so the app never runs. */
export function strykerConfig(mutate: EvaluationConfig['mutate']) {
  return {
    testRunner: 'command',
    commandRunner: { command: 'node -e "process.exit(0)"' },
    plugins: [],
    mutate: [...mutate.backend, ...mutate.frontend],
    ignorePatterns: ['node_modules', '**/node_modules'],
    reporters: ['json'],
    jsonReporter: { fileName: 'reports/mutation/mutation.json' },
    concurrency: 4,
    coverageAnalysis: 'off',
    tempDirName: '.stryker-tmp',
    cleanTempDir: true,
    logLevel: 'info',
  };
}

/**
 * Runs Stryker in `treeDir` (a golden source tree without node_modules) and returns its mutant list
 * (SPEC §11.2 step 1). Writes stryker.log and mutation.json into `workDir`.
 */
export async function listMutants(treeDir: string, mutate: EvaluationConfig['mutate'], workDir: string): Promise<MutantList> {
  await writeFile(path.join(treeDir, 'stryker.config.json'), JSON.stringify(strykerConfig(mutate), null, 2));
  const bin = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'stryker');
  const logFile = path.join(workDir, 'stryker.log');
  try {
    const { stdout, stderr } = await execFileAsync(bin, ['run', 'stryker.config.json'], {
      cwd: treeDir,
      maxBuffer: 100 * 1024 * 1024,
      timeout: STRYKER_TIMEOUT_MS,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', FORCE_COLOR: '0' },
    });
    await writeFile(logFile, stdout + stderr);
  } catch (err) {
    const { stdout = '', stderr = '' } = err as { stdout?: string; stderr?: string };
    await writeFile(logFile, stdout + stderr);
    throw new Error(`Stryker failed; see ${logFile}`, { cause: err });
  }
  const reportFile = path.join(workDir, 'mutation.json');
  await copyFile(path.join(treeDir, 'reports', 'mutation', 'mutation.json'), reportFile);
  const text = await readFile(reportFile, 'utf8');
  const report = MutationReport.parse(JSON.parse(text));
  const mutants = Object.values(report.files).reduce((n, f) => n + f.mutants.length, 0);
  return { report, reportFile, sha256: createHash('sha256').update(text).digest('hex'), version: await strykerVersion(), mutants };
}
