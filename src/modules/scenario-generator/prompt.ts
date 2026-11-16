import type { CoverageReport, Prd, PrdRequirement, TargetConfig } from '../../shared/schemas.js';
import { renderSettings } from '../../shared/target-settings.js';
import { templateMatches } from '../../shared/route-paths.js';
import { renderEndpointIndex } from '../test-case-generator/context.js';
import type { ReadLines } from '../test-case-generator/context.js';
import { describesEndpoint, namesPage } from '../test-case-generator/generate.js';
import { MAX_CITATION_LINES, MAX_POINTS_PER_FEATURE, MIN_LIST_RECORDS, roleUsers } from './points.js';
import { asRanges, endpointKey, unrunLines, type SuiteUsage } from './usage.js';

/** Characters of "code no test ran" per task. */
const UNRUN_CHAR_CAP = 3_000;

/** The discovery system prompt. The same for every target app: nothing app-specific belongs here. */
export function buildDiscoverySystemPrompt(): string {
  return `You look for situations that the existing test suite of a web application never sets up, so that new scenario tests can set them up. A scenario test prepares a situation (through the API where possible), performs one action, and keeps what the application answers; a later comparison of two versions of the application decides whether the answer changed. So a good scenario reaches code that behaves differently depending on data, options or earlier actions.

You get one feature of the application: its requirements, its API endpoints and pages, what the existing tests already send, and lines of code no test ran. Read the code with list_files, read_file and search (read-only) before you propose anything, then submit with submit_variation_points.

## Kinds of variation points
- list: an endpoint or page that lists records with sorting, paging or filtering. Create at least ${MIN_LIST_RECORDS} records first (set records and describe them in setup), with values that sort differently, then read the list with the option.
- unused-option: an option, query value, filter value, sort direction or enum value the code accepts that the existing tests never sent (each sort direction, each filter value). Put the exact values in values; each value must appear in the cited lines.
- state-after-action: a view or list whose content depends on an earlier action (after adding, liking, deleting, changing a status). Do the action first in setup, then view the result in the action.
- boundary: empty and boundary inputs: an empty list, text with spaces around it, the longest allowed value, the smallest or largest number the code accepts. Cite the code that sets the limit.
Role checks (each user role, and the wrong role for a route) are added by code; do not propose them.

## Rules
- Every point cites application code you read that shows the variation: citation { file, lines } with at most ${MAX_CITATION_LINES} lines.
- layer "api" names one endpoint of the list as "METHOD /path"; layer "ui" names the page it opens by a path that fits a page route.
- user is the fixture user who performs the action ("users.<name>") or "visitor" (not logged in).
- setup creates what the action needs through the API, as a fixture user who may do it, with new unique values. Never change a fixture user's profile, password, role or data; create a new user and change that one.
- Skip what the existing tests already do (listed), what needs email, payment or other outside services, and what only a person can check.
- At most ${MAX_POINTS_PER_FEATURE} points: the ones most likely to show a different answer when the code behind them changes. An empty list is right when nothing fits.`;
}

export interface DiscoveryTaskInput {
  feature: Prd['features'][number];
  requirements: PrdRequirement[];
  prd: Prd;
  config: TargetConfig;
  usage: SuiteUsage;
  coverage: CoverageReport | null;
  read: ReadLines;
  /** Role points code already added for this feature ("METHOD /path as role"). */
  rolePoints: string[];
}

/** The endpoints and pages of a feature: those its requirements describe or name. */
export function featureTargets(requirements: readonly PrdRequirement[], prd: Prd): { endpoints: Prd['apiEndpoints']; pages: Prd['uiRoutes'] } {
  return {
    endpoints: prd.apiEndpoints.filter((e) => requirements.some((r) => describesEndpoint(r, e, prd.apiEndpoints))),
    pages: prd.uiRoutes.filter((p) => requirements.some((r) => namesPage(r, p.path))),
  };
}

const list = (values: Iterable<string>) => [...values].sort().join(', ') || '(none)';

/** The user message for one feature's discovery session. */
export async function buildDiscoveryTask(input: DiscoveryTaskInput): Promise<string> {
  const { feature, requirements, prd, config, usage } = input;
  const { endpoints, pages } = featureTargets(requirements, prd);
  const reqText = requirements
    .map((r) => `- ${r.id} [${r.layer}]: ${r.statement}\n${r.acceptanceCriteria.map((c) => `   - ${c.text} (evidence: ${c.evidence.map((e) => `${e.file}:${e.lines[0]}-${e.lines[1]}`).join(', ')})`).join('\n')}`)
    .join('\n');
  const users = roleUsers(config.fixtures)
    .map((u) => (u.user === 'visitor' ? '- visitor: not logged in' : `- ${u.user}: role ${u.role}`))
    .join('\n');

  const used = endpoints.map((e) => {
    const u = usage.endpoints.get(endpointKey(e));
    if (!u || u.tests.size === 0) return `- ${endpointKey(e)}: no existing test sends it`;
    const query = [...u.query.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, values]) => `${name}=${list(values)}`).join('; ');
    return `- ${endpointKey(e)}: sent by ${u.tests.size} tests as ${list(u.roles)}${query ? `; query values sent: ${query}` : '; no query values'}${u.statuses.size ? `; statuses seen: ${[...u.statuses].sort().join(', ')}` : ''}`;
  });
  const opened = pages.map((p) => {
    const roles = [...usage.pages.entries()].filter(([route]) => templateMatches(route, p.path) || route === p.path).flatMap(([, r]) => [...r]);
    return `- ${p.path}: ${roles.length ? `opened as ${list(new Set(roles))}` : 'no existing test opens it'}`;
  });

  const unrun: string[] = [];
  if (input.coverage) {
    const ranges = new Map<string, Array<[number, number]>>();
    for (const e of [...endpoints.flatMap((x) => x.evidence), ...requirements.flatMap((r) => r.acceptanceCriteria.flatMap((c) => c.evidence))]) {
      if (!ranges.has(e.file)) ranges.set(e.file, []);
      ranges.get(e.file)!.push(e.lines);
    }
    let size = 0;
    for (const [file, rs] of [...ranges.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const lines = new Set<number>();
      for (const r of rs) for (const n of await unrunLines(file, r, input.coverage, input.read)) lines.add(n);
      if (lines.size === 0) continue;
      const line = `- ${file}: lines ${asRanges([...lines])}`;
      if (size + line.length > UNRUN_CHAR_CAP) break;
      unrun.push(line);
      size += line.length;
    }
  }

  const settings = renderSettings(config);
  return [
    `Find variation points for feature ${feature.id}.`,
    `Feature ${feature.id}: ${feature.name}. ${feature.description}`,
    `## Requirements\n${reqText}`,
    `## API endpoints of this feature\n${endpoints.length ? renderEndpointIndex(endpoints) : '(none)'}`,
    `## Pages of this feature\n${pages.length ? pages.map((p) => `- ${p.path}${p.authRequired ? ' (login required)' : ''}: ${p.summary}`).join('\n') : '(none)'}`,
    `## Users\n${users}`,
    ...(settings ? [`## Settings\n${settings}`] : []),
    `## What the existing tests already do\n${[...used, ...opened].join('\n') || '(nothing for this feature)'}`,
    input.coverage
      ? `## Code no test ran (measured with code coverage on the backend; only lines of these requirements' evidence)\n${unrun.join('\n') || '(every cited backend line ran)'}`
      : '## Code no test ran\n(not measured for this run)',
    `## Role scenarios already added by code (do not propose these)\n${input.rolePoints.length ? input.rolePoints.map((p) => `- ${p}`).join('\n') : '(none)'}`,
    `## Limits\nAt most ${MAX_POINTS_PER_FEATURE} points.`,
  ].join('\n\n');
}
