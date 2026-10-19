import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { LLMCallLogLine } from '../shared/schemas.js';

/** Appends one validated JSON line per call to runs/<runId>/llm-calls.jsonl. */
export async function appendCallLog(file: string, line: LLMCallLogLine): Promise<void> {
  const valid = LLMCallLogLine.parse(line);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(valid) + '\n', 'utf8');
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
