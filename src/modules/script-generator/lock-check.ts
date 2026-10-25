import ts from 'typescript';
import type { TestCase } from '../../shared/schemas.js';
import { fixtureValues } from '../test-case-generator/context.js';
import { VALUE_MATCHERS } from './classify.js';
import { LOCK_END, LOCK_START, renderExpected } from './render.js';

interface ExpectUse {
  id: string;
  /** Source text of expect's first argument (what is checked: a value, locator or page). */
  subject: string;
  matcher: string | null;
  /** Source text of the matcher's arguments. */
  matcherArgs: string;
}

/** Every `expect(x, 'E<n>')` / `expect.soft(x, 'E<n>')` with its matcher, found in the syntax tree. */
export function findExpects(source: string): ExpectUse[] {
  const file = ts.createSourceFile('script.ts', source, ts.ScriptTarget.ES2022, true);
  const uses: ExpectUse[] = [];
  const isExpect = (e: ts.Expression) =>
    (ts.isIdentifier(e) && e.text === 'expect') ||
    (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'expect' && e.name.text === 'soft');
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && isExpect(node.expression) && node.arguments.length >= 2) {
      const message = node.arguments[1]!;
      if (ts.isStringLiteralLike(message) && /^E\d+$/.test(message.text)) {
        // Walk up through `.not` / `.resolves` to the matcher call: expect(...).not.toHaveText(...)
        let access: ts.Node = node;
        let matcher: string | null = null;
        let matcherArgs = '';
        while (ts.isPropertyAccessExpression(access.parent) && access.parent.expression === access) {
          const name = access.parent.name.text;
          const call = access.parent.parent;
          if (ts.isCallExpression(call) && call.expression === access.parent) {
            matcher = name;
            matcherArgs = call.arguments.map((a) => a.getText(file)).join(', ');
            break;
          }
          access = access.parent;
        }
        uses.push({ id: message.text, subject: node.arguments[0]!.getText(file), matcher, matcherArgs });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return uses;
}

/**
 * The lock check (§6.3), run on every attempt before the dry run. Returns problems for the model.
 * - the EXPECTED block is byte-identical to the rendered one, and the body neither redefines nor edits it;
 * - every expectation is checked by an expect whose message is its id;
 * - an expectation with a value is asserted through `EXPECTED.<id>.value` as the argument of a value
 *   matcher, and never inside expect's subject (a value inside a locator would turn "wrong text" into
 *   "element not found", hiding a real disagreement);
 * - no fixed sleeps, no imports, no literal fixture credentials, no `.json()` (bodyOf reads any body).
 */
export function lockCheck(tc: TestCase, file: string, body: string, fixtures: unknown): string[] {
  const problems: string[] = [];
  const rendered = renderExpected(tc);
  if (!file.includes(rendered)) problems.push('The locked EXPECTED block was changed; it is written for you and must stay as it is.');
  if (body.includes(LOCK_START) || body.includes(LOCK_END) || /\b(const|let|var)\s+EXPECTED\b/.test(body)) {
    problems.push('The body must not define or edit EXPECTED; use the block that is already in the file.');
  }
  if (/\bEXPECTED\s*(\.\s*E\d+\s*(\.\s*\w+)?)?\s*=[^=]/.test(body)) problems.push('The body must not assign to EXPECTED.');
  if (/^\s*import\s/m.test(body) || /\brequire\(/.test(body)) problems.push('The body must not import anything; everything you need is already imported.');
  if (/\bwaitForTimeout\s*\(/.test(body)) problems.push('Do not use waitForTimeout; wait for a locator, a URL or a response instead.');
  if (/\.json\s*\(\s*\)/.test(body)) problems.push('Read response bodies with await bodyOf(res), not res.json(): an error response may not be JSON (e.g. a plain "Unauthorized"), and res.json() then throws before any check runs.');

  const uses = findExpects(body);
  for (const e of tc.expected) {
    const own = uses.filter((u) => u.id === e.id);
    if (own.length === 0) {
      problems.push(`${e.id} is not checked: add an expect whose message is '${e.id}', e.g. expect(x, '${e.id}').toBe(...)`);
      continue;
    }
    if (e.value === undefined) continue;
    const ref = new RegExp(`\\bEXPECTED\\s*\\.\\s*${e.id}\\s*\\.\\s*value\\b`);
    if (own.some((u) => ref.test(u.subject))) {
      problems.push(
        `${e.id}: EXPECTED.${e.id}.value must not be used inside expect's first argument (e.g. a getByText locator); select the element by role, label or placeholder and compare with a matcher such as toHaveText(EXPECTED.${e.id}.value)`,
      );
    }
    if (!own.some((u) => u.matcher !== null && VALUE_MATCHERS.has(u.matcher) && ref.test(u.matcherArgs))) {
      problems.push(
        `${e.id} has a locked value: compare it with a value matcher (${[...VALUE_MATCHERS].slice(0, 6).join(', ')}, …) whose argument is EXPECTED.${e.id}.value, not a literal`,
      );
    }
  }

  const credentials = fixtureValues(fixtures).filter((v) => v.includes('@') || v.length >= 6);
  for (const value of new Set(credentials)) {
    if (body.includes(`'${value}'`) || body.includes(`"${value}"`) || body.includes(`\`${value}\``)) {
      problems.push(`Do not write fixture data as a literal (${JSON.stringify(value)}); use fixtures.<path>, e.g. fixtures.users.<name>.email.`);
    }
  }
  return problems;
}
