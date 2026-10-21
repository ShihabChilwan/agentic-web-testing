import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { LLMCallLogLine } from '../shared/schemas.js';

export type Append = (file: string, text: string) => Promise<void>;

const defaultAppend: Append = async (file, text) => {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, text, 'utf8');
};

/** One write queue per file: parallel calls must not append at the same moment. */
const queues = new Map<string, Promise<void>>();

/**
 * Appends one validated JSON line per call to runs/<runId>/llm-calls.jsonl. Writes to the same file go
 * one after another: on some file systems (e.g. a 9p mount from a Windows host) simultaneous appends are
 * not atomic and lines get glued together or lost, which would undercount calls, cost and the run caps.
 */
export function appendCallLog(file: string, line: LLMCallLogLine, append: Append = defaultAppend): Promise<void> {
  let text: string;
  try {
    text = JSON.stringify(LLMCallLogLine.parse(line)) + '\n';
  } catch (err) {
    return Promise.reject(err);
  }
  const key = path.resolve(file);
  const next = (queues.get(key) ?? Promise.resolve()).then(() => append(file, text));
  const settled = next.catch(() => undefined);
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return next;
}

/**
 * Reads every valid line of a call log. A missing file is an empty log.
 * Lines that do not parse (e.g. one cut short by a crash) are skipped and counted.
 */
export async function readCallLog(file: string): Promise<{ lines: LLMCallLogLine[]; skipped: number }> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { lines: [], skipped: 0 };
    throw err;
  }
  const lines: LLMCallLogLine[] = [];
  let skipped = 0;
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    try {
      const parsed = LLMCallLogLine.safeParse(JSON.parse(raw));
      if (parsed.success) lines.push(parsed.data);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { lines, skipped };
}

/** Distinct upstream providers in a call log, sorted; for run.json `llm.upstreamProviders`. */
export function upstreamProvidersSeen(lines: readonly LLMCallLogLine[]): string[] {
  return [...new Set(lines.flatMap((l) => (l.upstreamProvider ? [l.upstreamProvider] : [])))].sort();
}
