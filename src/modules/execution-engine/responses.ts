import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RecordedResponse } from '../../shared/schemas.js';

/** What the execution helpers write per test into its output folder as responses.json (SPEC §7.6). */
export interface RawResponse {
  seq: number;
  source: 'api' | 'page';
  method: string;
  url: string;
  status: number;
  contentType: string;
  /** The body as text; null for a binary body or when it could not be read. */
  body: string | null;
  binary?: boolean;
  error?: string;
}

export const REDACTED = '<redacted>';
const SECRET_KEY = /token|password|passwd|secret|api_?key|authorization|cookie/i;
const JWT = /eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}/g;

/** Replaces the values of secret-looking keys and every JWT-looking string, at any depth. */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(JWT, REDACTED);
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) && v !== null && typeof v !== 'object' ? REDACTED : redact(v)]),
    );
  }
  return value;
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

/** One test's raw responses as validated, redacted lines (JSON bodies parsed when possible). */
export function toRecorded(testCaseId: string, raw: readonly RawResponse[]): RecordedResponse[] {
  return [...raw]
    .sort((a, b) => a.seq - b.seq)
    .map((r) => {
      let bodyKind: RecordedResponse['bodyKind'] = 'none';
      let body: unknown = null;
      if (r.binary) bodyKind = 'binary';
      else if (r.body !== null && r.body !== '') {
        try {
          body = JSON.parse(r.body);
          bodyKind = 'json';
        } catch {
          body = r.body;
          bodyKind = 'text';
        }
      }
      return RecordedResponse.parse({
        testCaseId,
        seq: r.seq,
        source: r.source,
        method: r.method.toUpperCase(),
        path: pathOf(r.url),
        status: r.status,
        contentType: r.contentType,
        bodyKind,
        body: redact(body),
        ...(r.error ? { error: r.error } : {}),
      });
    });
}

/**
 * Joins the tests' responses.json files (in run order) into one responses.jsonl. Returns the number of
 * lines and the tests whose file was missing (a test that used neither the api object nor the page).
 */
export async function writeResponsesFile(file: string, tests: ReadonlyArray<{ testCaseId: string; outputDir: string | undefined }>) {
  const lines: string[] = [];
  const missing: string[] = [];
  for (const { testCaseId, outputDir } of tests) {
    const text = outputDir ? await readFile(path.join(outputDir, 'responses.json'), 'utf8').catch(() => null) : null;
    if (text === null) {
      missing.push(testCaseId);
      continue;
    }
    for (const rec of toRecorded(testCaseId, JSON.parse(text) as RawResponse[])) lines.push(JSON.stringify(rec));
  }
  await writeFile(file, lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf8');
  return { responses: lines.length, missing };
}

/** Reads executions/<execId>/responses.jsonl. */
export async function readResponsesFile(file: string): Promise<RecordedResponse[]> {
  const text = await readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') throw new Error(`${file} does not exist: that execution did not record responses (run it with --record-responses)`);
    throw err;
  });
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l, i) => {
      try {
        return RecordedResponse.parse(JSON.parse(l));
      } catch (err) {
        throw new Error(`${file} line ${i + 1}: ${(err as Error).message}`, { cause: err });
      }
    });
}
