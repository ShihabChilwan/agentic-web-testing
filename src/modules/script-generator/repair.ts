import type { TestCase } from '../../shared/schemas.js';
import { stripAnsi } from './classify.js';
import { findExpects } from './lock-check.js';
import { messageValue } from './suspected.js';

/** Extra attempts a script may use after a locked value failed in a way that looks like a script error. */
export const MAX_REPAIRS = 2;

export interface RepairInput {
  tc: TestCase;
  /** The body of the script whose dry run reached a locked value that differed. */
  body: string;
  expectationId: string;
  result: { message: string; pageSnapshot?: string; dom?: string; lastResponse?: string };
}

const normalise = (s: string) => s.replace(/\s+/g, ' ').trim();

/** What kind of value Playwright printed after "Expected:" or "Received:", or null when it is not a plain value. */
function printedKind(raw: string | null): 'string' | 'number' | 'boolean' | null {
  if (raw === null) return null;
  if (/^"/.test(raw)) return 'string';
  if (/^-?\d+(\.\d+)?$/.test(raw)) return 'number';
  if (/^(true|false)$/.test(raw)) return 'boolean';
  return null;
}

/** The "Received" part of a Playwright message: from its first Received line to the call log, without the diff's removed lines. */
function receivedRegion(message: string): string {
  const lines = message.split('\n');
  const start = lines.findIndex((l) => /Received/.test(l));
  if (start < 0) return '';
  const rest = lines.slice(start);
  const end = rest.findIndex((l) => /^\s*Call log:/.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).filter((l, i) => i === 0 || !l.startsWith('-')).join('\n');
}

/** The last API response a failed test left (last-response.json), or null. */
function lastResponseOf(text: string): { method: string; url: string; status: number; body: string } | null {
  try {
    const parsed = JSON.parse(text) as { method?: unknown; url?: unknown; status?: unknown; body?: unknown };
    if (typeof parsed.status !== 'number' || typeof parsed.body !== 'string') return null;
    return { method: String(parsed.method ?? ''), url: new URL(String(parsed.url ?? 'http://x/')).pathname, status: parsed.status, body: parsed.body };
  } catch {
    return null;
  }
}

const isStatus = (n: number) => Number.isInteger(n) && n >= 100 && n <= 599;

/** `res.status()` style subjects: a response held in a `const`, so the variable always means the same response. */
function statusSubject(subject: string, body: string): boolean {
  const m = /^([A-Za-z_$][\w$]*)\.status\(\)$/.exec(subject.trim());
  if (!m) return false;
  const name = m[1]!.replace(/\$/g, '\\$');
  const declarations = body.match(new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`, 'g')) ?? [];
  return declarations.length === 1 && declarations[0]!.startsWith('const');
}

/**
 * Whether a failure on a locked value looks like the script's mistake rather than a disagreement of the app (SPEC §6.2).
 * The correct version produced the received value, so a locked value that cannot be that kind of value, or that the
 * text it expects sits right next to, says the test read the wrong thing. Returns what to tell the model, or null when
 * the failure looks like a real disagreement. Nothing here changes a locked value; the script is repaired, and when the
 * repair does not reach a different result the original failure stands.
 */
export function scriptErrorHint(input: RepairInput): string | null {
  const { tc, body, expectationId: id } = input;
  const expectation = tc.expected.find((e) => e.id === id);
  if (!expectation || expectation.value === undefined) return null;
  const value = expectation.value;
  const message = stripAnsi(input.result.message);
  const received = messageValue(message, 'Received');
  const receivedKind = printedKind(received);
  const use = findExpects(body).find((u) => u.id === id);
  const subject = use?.subject ?? '';
  const what = `${id} ("${expectation.description}")`;

  // 1. The kinds differ: a status code compared with text, a message with a status, a role with a status.
  if (receivedKind !== null && typeof value !== receivedKind) {
    return `${what} is locked to the ${typeof value} ${JSON.stringify(value)}, but the test compared it with the ${receivedKind} ${received}. They cannot be the same kind of thing, so the test reads the wrong value: check the thing the description names (a status code is response.status(), a message or field is read from the response body, text from the element that shows it).`;
  }

  // 2. Two expectations check one response variable's status but lock different values: one of them reads the wrong response.
  if (use && statusSubject(subject, body)) {
    const other = findExpects(body).find((u) => u.id !== id && u.subject.trim() === subject.trim() && statusSubject(u.subject, body));
    const otherValue = other ? tc.expected.find((e) => e.id === other.id)?.value : undefined;
    if (other && otherValue !== undefined && otherValue !== value) {
      return `${what} and ${other.id} both check ${subject} but are locked to ${JSON.stringify(value)} and ${JSON.stringify(otherValue)}: one response has one status. Send the request that ${id}'s description names and check the status of that response.`;
    }
  }

  // 3. A status of another class than the locked one: a rejected request where success is expected, or the reverse.
  const wantsStatus = typeof value === 'number' && isStatus(value) && /status/i.test(`${expectation.description} ${subject}`);
  if (wantsStatus && receivedKind === 'number' && isStatus(Number(received))) {
    const got = Number(received);
    if (Math.floor(got / 100) !== Math.floor((value as number) / 100)) {
      if ((value as number) < 300 && got >= 400) {
        return `${what} expects ${value}, but the app rejected the request with ${got}. The correct version accepts a well-formed request, so the request is most likely wrong: compare its body with the "sends" shape in the endpoint list and with the frontend call (field names, nesting, required fields), use ids and values read from earlier responses, and log in as a user whose role the endpoint needs. The app's answer is below.`;
      }
      if ((value as number) >= 400 && got < 300) {
        return `${what} expects ${value}, but the app accepted the request with ${got}. Check that the request is exactly the invalid one the steps describe: it must leave out, or break, what the steps name (a field the steps say is missing must not be sent) and use the user or token the steps name.`;
      }
    }
  }

  // 4. Text locked for a rejected request (an error message), but the app's answer to the last request is another one:
  //    the request was probably rejected for another reason than the one the test means to provoke.
  if (typeof value === 'string' && input.result.lastResponse) {
    const last = lastResponseOf(input.result.lastResponse);
    if (last && last.status >= 400 && !normalise(last.body).includes(normalise(value))) {
      return `${what} expects the message ${JSON.stringify(value)}, but the last request (${last.method} ${last.url}) was rejected with ${last.status} and another answer (below). The request was probably rejected for a different reason than the one the test means to provoke: send a request that is valid except for exactly what the steps name (body shape as in the "sends" list and the frontend call, real ids from earlier responses, the right user), so that this message is what comes back.`;
    }
  }

  // 5. The expected text is part of what was received, or elsewhere on the page: the test looked at the wrong element.
  if (typeof value === 'string' && normalise(value).length >= 3) {
    const wanted = normalise(value);
    if (normalise(receivedRegion(message)).includes(wanted)) {
      return `${what}: the expected text ${JSON.stringify(value)} is part of what the element holds, so the test selected a larger element or compared too strictly. Select the element that holds exactly this text, or compare with a matcher that accepts the surrounding text (toContainText on the area that holds it).`;
    }
    const page = normalise(`${input.result.pageSnapshot ?? ''} ${input.result.dom ?? ''}`);
    if (page.includes(wanted)) {
      return `${what}: the expected text ${JSON.stringify(value)} is on the page (see the page below), but not in the element the test checked. Select the element that holds it (by role, label, or the area around it) instead of a first or last match.`;
    }
  }
  return null;
}
