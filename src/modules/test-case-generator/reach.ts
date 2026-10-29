import type { CoverageReport, Prd, TargetConfig } from '../../shared/schemas.js';
import type { ReadLines } from './context.js';

type Endpoint = Prd['apiEndpoints'][number];

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a script's source sends the endpoint's request: a call `<x>.<method>(` whose first argument is a string
 * naming the endpoint's whole path, where a parameter segment (`:id`, `{id}`, `<id>`) is any text without a slash
 * (`${id}` in a template string included). The login endpoint of the target is sent by the login helpers
 * (`loginViaApi`, `loggedInPage`, `loginViaUi`), which scripts call without naming it.
 */
export function scriptSends(endpoint: Endpoint, scriptSources: readonly string[], login?: { method: string; path: string }): boolean {
  const path = endpoint.path.replace(/\/+$/, '');
  const pattern = path
    .split('/')
    .map((segment) => (/^[:{<]/.test(segment) ? '[^/\'"`\\s?]+' : escapeRegex(segment)))
    .join('/');
  const call = new RegExp(`\\.${endpoint.method.toLowerCase()}\\s*\\(\\s*[\`'"][^\`'"]*?${pattern}/?(?=[\`'"?])`);
  const isLogin = login !== undefined && login.method === endpoint.method && login.path.replace(/\/+$/, '') === path;
  return scriptSources.some((source) => call.test(source) || (isLogin && /\b(?:loginViaApi|loggedInPage|loginViaUi)\s*\(/.test(source)));
}

/**
 * Whether the endpoint's evidence holds code that coverage can see running: a function body (`function`, `=>`). An
 * evidence range that only declares the route (`router.post('/login', a, b, handler)`) runs once at module load, which
 * coverage leaves out, so it can never show the endpoint as reached.
 */
export async function hasMeasurableCode(endpoint: Endpoint, read: ReadLines): Promise<boolean> {
  for (const ev of endpoint.evidence) {
    const text = (await read(ev.file))?.slice(ev.lines[0] - 1, ev.lines[1]).join('\n') ?? '';
    if (/\bfunction\b|=>/.test(text)) return true;
  }
  return false;
}

/** The disabled setting (a key of `disabledServices`, whole word) the endpoint's evidence names, if any. */
export async function namedDisabledSetting(endpoint: Endpoint, disabledKeys: readonly string[], read: ReadLines): Promise<string | undefined> {
  for (const ev of endpoint.evidence) {
    const text = (await read(ev.file))?.slice(ev.lines[0] - 1, ev.lines[1]).join('\n');
    const key = text === undefined ? undefined : disabledKeys.find((k) => new RegExp(`\\b${escapeRegex(k)}\\b`).test(text));
    if (key) return key;
  }
  return undefined;
}

export interface EndpointClass {
  /** A disabled setting the endpoint's code names while a passing script sends it and its handler never runs. */
  gatedBy?: string;
  /** Reached because a passing script sends it, although its evidence holds no code coverage can see. */
  observed?: true;
}

/**
 * What coverage alone cannot tell about the unreached endpoints (SPEC §5.1), from what the passing scripts send:
 * - gated: the evidence names a disabled setting AND a passing script sends the request, yet the handler never ran:
 *   the request was turned away before the handler. A mention without such a request proves nothing (an optional
 *   cache switch looks the same), so that endpoint is still asked for.
 * - observed: the evidence holds no measurable code (only the route declaration) and a passing script sends the
 *   request: counted as reached.
 */
export async function classifyUnreached(
  endpoints: readonly Endpoint[],
  reach: ReadonlyArray<{ reached: boolean }>,
  options: { disabledKeys: readonly string[]; read: ReadLines; scriptSources: readonly string[]; login?: TargetConfig['auth'] },
): Promise<EndpointClass[]> {
  const login = options.login && 'method' in options.login.login ? { method: options.login.login.method, path: options.login.login.path } : undefined;
  return Promise.all(
    endpoints.map(async (e, i): Promise<EndpointClass> => {
      if (reach[i]!.reached || !scriptSends(e, options.scriptSources, login)) return {};
      const key = await namedDisabledSetting(e, options.disabledKeys, options.read);
      if (key) return { gatedBy: key };
      return (await hasMeasurableCode(e, options.read)) ? {} : { observed: true };
    }),
  );
}

export type CoverageEndpoint = CoverageReport['endpoints'][number];
