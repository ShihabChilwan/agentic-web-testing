export class PlaceholderError extends Error {
  override name = 'PlaceholderError';
}

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;
const WHOLE_PLACEHOLDER = /^\{\{\s*([\w.-]+)\s*\}\}$/;

function lookup(context: Record<string, unknown>, key: string): string | number | boolean {
  let value: unknown = context;
  for (const part of key.split('.')) {
    value = value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  throw new PlaceholderError(
    value === undefined ? `Unknown placeholder {{${key}}}` : `Placeholder {{${key}}} is not a string, number or boolean`,
  );
}

/**
 * Replaces `{{a.b.c}}` placeholders in strings, recursing into arrays and objects.
 * A string that is exactly one placeholder takes the value's own type (e.g. a number);
 * placeholders inside longer strings are inserted as text. With `encode` (e.g. for URL paths)
 * every inserted value is text passed through it.
 */
export function fillPlaceholders<T>(
  value: T,
  context: Record<string, unknown>,
  { encode }: { encode?: (text: string) => string } = {},
): T {
  if (typeof value === 'string') {
    const whole = WHOLE_PLACEHOLDER.exec(value);
    if (whole && !encode) return lookup(context, whole[1]!) as T;
    const text = (key: string) => String(lookup(context, key));
    return value.replace(PLACEHOLDER, (_m, key: string) => (encode ? encode(text(key)) : text(key))) as T;
  }
  if (Array.isArray(value)) return value.map((v) => fillPlaceholders(v, context, { ...(encode ? { encode } : {}) })) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, fillPlaceholders(v, context, { ...(encode ? { encode } : {}) })]),
    ) as T;
  }
  return value;
}
