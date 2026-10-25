import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { ExecutionResults, TargetConfig } from '../../shared/schemas.js';
import { executeVersion, sourceTreeFor, type ExecuteVersionOptions } from './execute.js';

const execFileAsync = promisify(execFile);

/** Turns SIGTERM and SIGINT into a normal exit: Node writes NODE_V8_COVERAGE only when a process exits that way. */
export const COVERAGE_PRELOAD = "for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));\n";

interface V8Range {
  startOffset: number;
  endOffset: number;
  count: number;
}
interface V8Script {
  url: string;
  functions: Array<{ functionName: string; ranges: V8Range[] }>;
}

/**
 * Characters of one script that ran inside a function, from one process's V8 block coverage. Every range of every
 * function is applied outer before inner, so the innermost range decides a character's count (an uncalled handler's
 * count 0 overrides the module around it). Ranges of the module's top-level function count as not run: they cover
 * code that runs at load, such as registering a route, whether or not a request ever reached it.
 */
export function ranCharacters(script: V8Script, length: number): Uint8Array {
  const count = new Int32Array(length);
  const ranges = script.functions.flatMap((fn) => {
    const topLevel = fn.functionName === '' && fn.ranges[0]?.startOffset === 0;
    return fn.ranges.map((r) => ({ ...r, count: topLevel ? 0 : r.count }));
  });
  ranges.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  for (const r of ranges) count.fill(r.count, r.startOffset, Math.min(r.endOffset, length));
  return Uint8Array.from(count, (c) => (c > 0 ? 1 : 0));
}

/** 1-based lines holding a character that ran (whitespace does not count). */
export function ranLines(source: string, ran: Uint8Array): number[] {
  const lines: number[] = [];
  let offset = 0;
  source.split('\n').forEach((line, i) => {
    for (let j = 0; j < line.length; j++) {
      if (ran[offset + j] && line[j]!.trim() !== '') {
        lines.push(i + 1);
        break;
      }
    }
    offset += line.length + 1;
  });
  return lines;
}

/**
 * Lines that ran per repo-relative file, merged over every coverage file in `dir`. Only scripts inside the source
 * tree count (node_modules and the tools' own files are left out); `source` gives a file's text at the measured commit.
 */
export async function readV8Coverage(
  dir: string,
  treeDir: string,
  source: (rel: string) => Promise<string | null>,
): Promise<{ processes: number; files: Record<string, number[]> }> {
  const prefixes = [...new Set([treeDir, await realpath(treeDir).catch(() => treeDir)])].map((d) => `${pathToFileURL(d).href}/`);
  const merged = new Map<string, { text: string; ran: Uint8Array }>();
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.json'));
  for (const name of names) {
    const scripts = (JSON.parse(await readFile(path.join(dir, name), 'utf8')) as { result: V8Script[] }).result;
    for (const script of scripts) {
      const prefix = prefixes.find((p) => script.url.startsWith(p));
      if (!prefix) continue;
      const rel = decodeURIComponent(script.url.slice(prefix.length));
      if (rel.split('/').includes('node_modules')) continue;
      if (!merged.has(rel)) {
        const text = await source(rel);
        if (text === null) continue;
        merged.set(rel, { text, ran: new Uint8Array(text.length) });
      }
      const file = merged.get(rel)!;
      const ran = ranCharacters(script, file.text.length);
      for (let i = 0; i < ran.length; i++) if (ran[i]) file.ran[i] = 1;
    }
  }
  const files: Record<string, number[]> = {};
  for (const [rel, { text, ran }] of [...merged].sort(([a], [b]) => a.localeCompare(b))) files[rel] = ranLines(text, ran);
  return { processes: names.length, files };
}

export interface MeasureCoverageOptions extends Pick<ExecuteVersionOptions, 'config' | 'repoDir' | 'targetDir' | 'generationRef' | 'signal' | 'log' | 'startApp'> {
  runDir: string;
}

export interface MeasuredCoverage {
  commit: string;
  results: ExecutionResults;
  processes: number;
  files: Record<string, number[]>;
}

/**
 * Runs the scripts that passed their dry run on the generation version with backend coverage on (§5.1): the backend
 * gets NODE_V8_COVERAGE and a preload that turns SIGTERM into a normal exit, through the execution's own config
 * override. The execution is kept as coverage/execution/ (never under executions/, so it never counts as the
 * golden execution); the raw coverage files are removed once read (hundreds of MB).
 */
export async function measureCoverage(options: MeasureCoverageOptions): Promise<MeasuredCoverage> {
  const config: TargetConfig = options.config;
  if (config.coverage?.kind !== 'node-v8') throw new Error(`Target ${config.name} has no "coverage" setting in target.config.json`);
  const coverageDir = path.join(options.runDir, 'coverage');
  const rawDir = path.join(coverageDir, 'v8');
  const preload = path.join(coverageDir, 'flush-on-signal.cjs');
  const execId = 'coverage';
  await rm(coverageDir, { recursive: true, force: true });
  await rm(path.join(options.runDir, 'executions', execId), { recursive: true, force: true });
  await mkdir(rawDir, { recursive: true });
  await writeFile(preload, COVERAGE_PRELOAD, 'utf8');

  const request = { execId, ref: options.generationRef };
  const { commit, tree } = await sourceTreeFor(config, options.repoDir, request);
  const treeDir = tree.dir;
  const env = { NODE_V8_COVERAGE: rawDir, NODE_OPTIONS: `--require "${preload}"` };
  const { results } = await executeVersion({
    ...options,
    request: { ...request, configOverride: { backend: { env } } },
    sourceTree: tree,
  });
  await rename(path.join(options.runDir, 'executions', execId), path.join(coverageDir, 'execution'));
  const source = async (rel: string) =>
    execFileAsync('git', ['-C', options.repoDir, 'show', `${commit}:${rel}`], { maxBuffer: 64 * 1024 * 1024 }).then(
      (r) => r.stdout,
      () => null,
    );
  const read = await readV8Coverage(rawDir, treeDir, source);
  await rm(rawDir, { recursive: true, force: true });
  return { commit, results, ...read };
}
