import type { ValueShape } from '../../shared/schemas.js';

/** Shown for a value that one side does not have (JSON has no undefined). */
export const ABSENT = '(absent)';

const ISO_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const DELIMITERS = new Set(['-', '_', ' ', '/', '.', '@', ':', ',']);

/** `string`, `number`, `boolean`, `null`, `array`, `object` or `absent`. */
export function typeOf(v: unknown): string {
  if (v === ABSENT) return 'absent';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** The character classes of a text: `a` lower-case, `A` upper-case, `9` digit, any other character itself; sorted, unique. */
function classes(text: string): string {
  const set = new Set([...text].map((c) => (/[a-z]/.test(c) ? 'a' : /[A-Z]/.test(c) ? 'A' : /[0-9]/.test(c) ? '9' : c)));
  return [...set].sort().join('');
}

/**
 * The classes a random tail may use: a tail that mixes upper- and lower-case letters is taken as a
 * random id from the URL-safe alphabet (letters, digits, `_`, `-`), so `_` and `-` are allowed even when
 * the correct runs happened not to show them.
 */
function tailClasses(observed: string): string {
  return observed.includes('a') && observed.includes('A') ? classes(`${observed}9_-`) : observed;
}

/** The common start of two texts, cut back to just after its last delimiter, and the two tails after it. */
function splitTail(a: string, b: string): { prefix: string; ta: string; tb: string } {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  while (i > 0 && !DELIMITERS.has(a[i - 1]!)) i--;
  return { prefix: a.slice(0, i), ta: a.slice(i), tb: b.slice(i) };
}

/**
 * The shape of one pair of values that differed between two runs of the same version: both ISO times
 * (`time`); two texts with the same start and different tails (`tail`: tail lengths and character
 * classes, e.g. a slug with a random suffix of 10 characters); otherwise only their types (`type`).
 */
export function observeShape(a: unknown, b: unknown): ValueShape {
  const types = [...new Set([typeOf(a), typeOf(b)])].sort();
  if (typeof a === 'string' && typeof b === 'string') {
    if (ISO_TIME.test(a) && ISO_TIME.test(b)) return { kind: 'time', types };
    const { ta, tb } = splitTail(a, b);
    if (ta && tb) return { kind: 'tail', types, tailLength: [Math.min(ta.length, tb.length), Math.max(ta.length, tb.length)], tailChars: tailClasses(classes(ta + tb)) };
  }
  return { kind: 'type', types };
}

/** Two shapes of the same field as one: the same kind widens, different kinds fall back to `type`. */
export function mergeShapes(x: ValueShape, y: ValueShape): ValueShape {
  const types = [...new Set([...x.types, ...y.types])].sort();
  if (x.kind === 'time' && y.kind === 'time') return { kind: 'time', types };
  if (x.kind === 'tail' && y.kind === 'tail') {
    return {
      kind: 'tail',
      types,
      tailLength: [Math.min(x.tailLength![0], y.tailLength![0]), Math.max(x.tailLength![1], y.tailLength![1])],
      tailChars: tailClasses(classes(`${x.tailChars ?? ''}${y.tailChars ?? ''}`)),
    };
  }
  return { kind: 'type', types };
}

/**
 * True when a difference between two values fits the shape the correct runs showed for this field: both
 * times; the same start with tails of a learned length made of learned character classes; or, for
 * `type`, types the correct runs had. A value that breaks the shape (a lost suffix, another kind of
 * value, a missing field where the correct runs always had one) is a real difference.
 */
export function fitsShape(a: unknown, b: unknown, shape: ValueShape): boolean {
  if (shape.kind === 'time') return typeof a === 'string' && typeof b === 'string' && ISO_TIME.test(a) && ISO_TIME.test(b);
  if (shape.kind === 'tail') {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const { ta, tb } = splitTail(a, b);
    const [min, max] = shape.tailLength!;
    const allowed = new Set(shape.tailChars ?? '');
    const ok = (t: string) => t.length >= min && t.length <= max && [...classes(t)].every((c) => allowed.has(c));
    return ok(ta) && ok(tb);
  }
  return shape.types.includes(typeOf(a)) && shape.types.includes(typeOf(b));
}

/** A short description of a shape for people, e.g. `start + random tail of 10 characters [A_a9]`. */
export function describeShape(shape: ValueShape): string {
  if (shape.kind === 'time') return 'a time';
  if (shape.kind === 'tail') {
    const [min, max] = shape.tailLength!;
    return `same start + tail of ${min === max ? min : `${min}-${max}`} characters [${shape.tailChars}]`;
  }
  return `any ${shape.types.join(' or ')}`;
}
