// What the page may show of an error or a log line: no links to other services and no key-like identifiers.

const URL_RE = /https?:\/\/[^\s)'"]+/gi;
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?=[:/]|$)/i;
/** 28 or more id-like characters in one piece, e.g. a key id or a token (a plain word or a path is shorter or has more punctuation). */
const TOKEN_RE = /(?<![\w/.-])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{28,}(?![\w/.-])/g;
/** A run id such as mern-ecommerce-20261104-154332 is long but is not a secret. */
const RUN_ID_RE = /^[a-z][a-z0-9-]*-\d{8}-\d{6}$/;
const KEY_PREFIX_RE = /\bsk-[A-Za-z0-9_-]+/g;

/** The short message of an error: first line, cut at the first link, identifiers removed. */
export function shortError(text: unknown, max = 200): string {
  let s = String(text ?? '').split('\n').find((l) => l.trim()) ?? '';
  const cut = s.search(/https?:\/\/|\bManage it\b/i);
  if (cut >= 0) s = s.slice(0, cut);
  s = s.replace(KEY_PREFIX_RE, '').replace(TOKEN_RE, (t) => (RUN_ID_RE.test(t) ? t : '')).replace(/\s+/g, ' ').trim().replace(/[\s.,;:]+$/, '');
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s;
}

/** A log line with links to other services and key-like identifiers hidden; local addresses stay. */
export function redactLine(line: string): string {
  return line
    .replace(URL_RE, (u) => (LOCAL.test(u) ? u : '[link hidden]'))
    .replace(KEY_PREFIX_RE, '[id hidden]')
    .replace(TOKEN_RE, (t) => (RUN_ID_RE.test(t) ? t : '[id hidden]'));
}
