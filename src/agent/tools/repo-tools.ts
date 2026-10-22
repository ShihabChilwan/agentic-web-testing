import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AgentTool } from '../types.js';

export const MAX_LIST_DEPTH = 3;
export const MAX_READ_LINES = 400;
export const MAX_SEARCH_HITS = 50;
const MAX_LIST_ENTRIES = 1_000;
const MAX_SEARCH_FILE_BYTES = 1_000_000;
const MAX_SEARCH_LINE_CHARS = 1_000;
const MAX_GLOB_CHARS = 200;
const ALWAYS_HIDDEN = ['.git', 'node_modules'];

export interface RepoScope {
  /** Absolute path of the target repo working tree. */
  root: string;
  /** Globs (relative to the root) that must never be listed or read. */
  forbiddenPaths: readonly string[];
}

/** A path the tools refused; the message is shown to the model. */
export class PathRejectedError extends Error {
  override name = 'PathRejectedError';
}

const toPosix = (p: string) => p.split(path.sep).join('/');

/** True when a root-relative path is hidden from the tools (.git, node_modules or a forbidden glob). */
export function isHidden(relPath: string, scope: RepoScope): boolean {
  const rel = toPosix(relPath);
  if (rel === '' || rel === '.') return false;
  if (rel.split('/').some((segment) => ALWAYS_HIDDEN.includes(segment))) return true;
  return scope.forbiddenPaths.some((glob) => path.posix.matchesGlob(rel, glob));
}

/**
 * Resolves a model-supplied path inside the repo, or throws PathRejectedError.
 * Rejects absolute paths, `..`, hidden paths, and anything whose real location
 * (after following symlinks) is outside the root or hidden. A hidden or outside path gets the
 * same message as a missing one, so an error never tells that something exists (SPEC §8.4).
 */
export async function resolveInRepo(scope: RepoScope, input: string): Promise<{ abs: string; rel: string }> {
  const raw = input.trim() === '' ? '.' : input.trim();
  if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) throw new PathRejectedError(`Use a path relative to the repo root, not "${raw}".`);
  const rel = toPosix(path.posix.normalize(raw.replace(/\\/g, '/'))).replace(/\/$/, '');
  if (rel.split('/').includes('..')) throw new PathRejectedError(`Paths may not contain "..": "${raw}".`);
  const missing = () => new PathRejectedError(`"${raw}" does not exist.`);
  if (isHidden(rel, scope)) throw missing();

  const rootReal = await realpath(scope.root);
  let real: string;
  try {
    real = await realpath(path.join(rootReal, rel));
  } catch {
    throw missing();
  }
  const realRel = path.relative(rootReal, real);
  if (realRel.startsWith('..') || path.isAbsolute(realRel) || isHidden(realRel, scope)) throw missing();
  return { abs: real, rel: rel === '' ? '.' : rel };
}

/** Lines of a text file as read_file numbers them (a final newline does not start another line). */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

/** Runs a tool body, turning a rejected path into a message for the model. */
async function guarded(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PathRejectedError) return `Error: ${err.message}`;
    throw err;
  }
}

const ListInput = z.object({
  path: z.string().default('.').describe('Directory relative to the repo root'),
  depth: z.number().int().min(1).max(MAX_LIST_DEPTH).default(2).describe(`How many levels to show (1-${MAX_LIST_DEPTH})`),
});

const ReadInput = z.object({
  path: z.string().describe('File relative to the repo root'),
  startLine: z.number().int().min(1).optional().describe('First line to show (1-based)'),
  endLine: z.number().int().min(1).optional().describe('Last line to show (inclusive)'),
});

const SearchInput = z.object({
  pattern: z.string().min(1).describe('JavaScript regular expression, matched against each line'),
  glob: z.string().optional().describe('Only search files matching this glob, e.g. "server/**/*.js"'),
});

export function createRepoTools(scope: RepoScope): [AgentTool<z.infer<typeof ListInput>>, AgentTool<z.infer<typeof ReadInput>>, AgentTool<z.infer<typeof SearchInput>>] {
  const listFiles: AgentTool<z.infer<typeof ListInput>> = {
    name: 'list_files',
    description: `List files and folders under a directory of the repo as a tree (folders end with "/"). Depth at most ${MAX_LIST_DEPTH}.`,
    input: ListInput,
    run: ({ path: dir, depth }) =>
      guarded(async () => {
        const { abs, rel } = await resolveInRepo(scope, dir);
        if (!(await stat(abs)).isDirectory()) return `Error: "${dir}" is a file, not a directory. Use read_file.`;
        const lines: string[] = [`${rel}/`];
        let truncated = false;
        const walk = async (absDir: string, relDir: string, level: number) => {
          const entries = (await readdir(absDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
          for (const entry of entries) {
            const relEntry = relDir === '.' ? entry.name : `${relDir}/${entry.name}`;
            if (isHidden(relEntry, scope)) continue;
            if (lines.length >= MAX_LIST_ENTRIES) {
              truncated = true;
              return;
            }
            const indent = '  '.repeat(level);
            if (entry.isSymbolicLink()) lines.push(`${indent}${entry.name} (symlink, not followed)`);
            else if (entry.isDirectory()) {
              lines.push(`${indent}${entry.name}/`);
              if (level < depth) await walk(path.join(absDir, entry.name), relEntry, level + 1);
            } else lines.push(`${indent}${entry.name}`);
          }
        };
        await walk(abs, rel, 1);
        if (truncated) lines.push(`[listing stopped at ${MAX_LIST_ENTRIES} entries; list a subdirectory instead]`);
        return lines.join('\n');
      }),
  };

  const readFileTool: AgentTool<z.infer<typeof ReadInput>> = {
    name: 'read_file',
    description: `Read a text file of the repo with line numbers, at most ${MAX_READ_LINES} lines per call. Use startLine and endLine for long files.`,
    input: ReadInput,
    run: ({ path: file, startLine, endLine }) =>
      guarded(async () => {
        const { abs, rel } = await resolveInRepo(scope, file);
        if ((await stat(abs)).isDirectory()) return `Error: "${file}" is a directory. Use list_files.`;
        const text = await readFile(abs, 'utf8');
        if (text.includes('\u0000')) return `Error: "${rel}" looks like a binary file.`;
        const lines = splitLines(text);
        const total = lines.length;
        const start = startLine ?? 1;
        if (start > total) return `Error: "${rel}" has only ${total} lines.`;
        const requestedEnd = Math.min(endLine ?? total, total);
        if (requestedEnd < start) return `Error: endLine (${endLine}) is before startLine (${start}).`;
        const end = Math.min(requestedEnd, start + MAX_READ_LINES - 1);
        const body = lines
          .slice(start - 1, end)
          .map((line, i) => `${start + i}: ${line}`)
          .join('\n');
        const header = `${rel} (lines ${start}-${end} of ${total})`;
        const more = end < requestedEnd ? `\n[stopped at ${MAX_READ_LINES} lines; call again with startLine=${end + 1}]` : '';
        return `${header}\n${body}${more}`;
      }),
  };

  const searchCode: AgentTool<z.infer<typeof SearchInput>> = {
    name: 'search_code',
    description: `Search the repo's text files for a regular expression. Returns up to ${MAX_SEARCH_HITS} hits as "file:line: text".`,
    input: SearchInput,
    run: async ({ pattern, glob }) => {
      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch (err) {
        return `Error: invalid regular expression: ${(err as Error).message}`;
      }
      const globError = checkGlob(glob);
      if (globError) return `Error: ${globError}`;

      const rootReal = await realpath(scope.root);
      const files = (await listRepoFiles(rootReal, scope)).filter((rel) => !glob || path.posix.matchesGlob(rel, glob));

      const hits: string[] = [];
      for (const rel of files) {
        const abs = path.join(rootReal, rel);
        if ((await stat(abs)).size > MAX_SEARCH_FILE_BYTES) continue;
        const text = await readFile(abs, 'utf8');
        if (text.includes('\u0000')) continue;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!.slice(0, MAX_SEARCH_LINE_CHARS);
          if (!regex.test(line)) continue;
          if (hits.length === MAX_SEARCH_HITS) {
            return `${hits.join('\n')}\n[stopped at ${MAX_SEARCH_HITS} hits; narrow the pattern or the glob]`;
          }
          hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
        }
      }
      return hits.length > 0 ? hits.join('\n') : 'No matches.';
    },
  };

  return [listFiles, readFileTool, searchCode];
}

/**
 * Every regular file in the repo as a sorted root-relative POSIX path, skipping
 * hidden paths (.git, node_modules, forbidden globs) and symlinks, which are never followed.
 */
async function listRepoFiles(rootReal: string, scope: RepoScope): Promise<string[]> {
  const files: string[] = [];
  const walk = async (absDir: string, relDir: string) => {
    for (const entry of await readdir(absDir, { withFileTypes: true })) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isSymbolicLink() || isHidden(rel, scope)) continue;
      if (entry.isDirectory()) await walk(path.join(absDir, entry.name), rel);
      else if (entry.isFile()) files.push(rel);
    }
  };
  await walk(rootReal, '');
  return files.sort();
}

/** Model-supplied globs must stay inside the repo and stay simple (deeply nested braces make glob matching slow). */
function checkGlob(glob: string | undefined): string | undefined {
  if (glob === undefined) return undefined;
  if (glob.length > MAX_GLOB_CHARS) return `glob is longer than ${MAX_GLOB_CHARS} characters.`;
  if (glob.startsWith('/') || /^[A-Za-z]:/.test(glob)) return 'glob must be relative to the repo root.';
  if (glob.split(/[\\/]/).includes('..')) return 'glob may not contain "..".';
  let depth = 0;
  for (const ch of glob) {
    if (ch === '{' && ++depth > 1) return 'nested braces are not supported in globs.';
    if (ch === '}') depth = Math.max(0, depth - 1);
  }
  return undefined;
}
