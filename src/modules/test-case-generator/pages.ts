import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { snapshotForModel, type PageSnapshot } from '../execution-engine/probe.js';
import { templateMatches, textPaths } from '../../shared/route-paths.js';
import { PageSnapshots } from '../../shared/schemas.js';
import type { PageSnapshotEntry, Prd, PrdRequirement, TargetConfig } from '../../shared/schemas.js';
import type { SubmitTestCases } from './checks.js';

/** Characters of page snapshots in one session's task; the rest are named as left out. */
export const PAGE_SNAPSHOT_TASK_CHARS = 30_000;

export interface SnapshotRequest {
  path: string;
  route: string;
  user: string | null;
  role: string | null;
}

/** A path still holding a placeholder (":id", "<id>", "{id}", "${id}") cannot be opened. */
const isConcrete = (p: string) => !/[<>{}$]|\/:/.test(p);

/** The first fixture user of each role, as dot paths ("users.admin"), in fixture order. */
export function usersByRole(config: TargetConfig): Array<{ user: string; role: string }> {
  const seen = new Set<string>();
  const out: Array<{ user: string; role: string }> = [];
  for (const [name, u] of Object.entries(config.fixtures.users)) {
    if (seen.has(u.role)) continue;
    seen.add(u.role);
    out.push({ user: `users.${name}`, role: u.role });
  }
  return out;
}

/**
 * The pages to snapshot (SPEC §5): every PRD page a ui or e2e requirement names, as a concrete path (a route with a
 * parameter only where a requirement writes a concrete path), seen by a visitor, or for a page that requires login,
 * by the first fixture user of each role. Catch-all routes are left out.
 */
export function snapshotRequests(prd: Prd, config: TargetConfig): SnapshotRequest[] {
  const roles = usersByRole(config);
  const out: SnapshotRequest[] = [];
  const seen = new Set<string>();
  const texts = (r: PrdRequirement) => [r.statement, ...r.acceptanceCriteria.map((c) => c.text)];
  const pageRequirements = prd.requirements.filter((r) => r.layer !== 'api');
  for (const route of prd.uiRoutes.filter((r) => !r.path.includes('*'))) {
    const named = textPaths(pageRequirements.flatMap(texts)).filter((p) => templateMatches(route.path, p));
    if (named.length === 0) continue;
    const paths = isConcrete(route.path) ? [route.path] : [...new Set(named.filter(isConcrete))];
    for (const p of paths) {
      const viewers = route.authRequired ? roles.map((r) => ({ user: r.user, role: r.role })) : [{ user: null, role: null }];
      for (const v of viewers) {
        const key = `${p}|${v.user ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ path: p, route: route.path, user: v.user, role: v.role });
      }
    }
  }
  return out;
}

export type TakeSnapshots = (config: TargetConfig, requests: ReadonlyArray<{ path: string; user?: string }>) => Promise<Array<PageSnapshot | null>>;

/**
 * runs/<runId>/pages/snapshots.json for the run (SPEC §5): reused when it was taken at the same generation commit and
 * holds every page asked for; otherwise the missing pages are taken with `take` (which needs the app running at the
 * generation ref) and the file is written again.
 */
export async function collectPageSnapshots(options: {
  runDir: string;
  generationCommit: string;
  requests: SnapshotRequest[];
  config: TargetConfig;
  /** Called only when pages are missing; returns the snapshots in request order (null: could not open). */
  take: (requests: SnapshotRequest[]) => Promise<Array<PageSnapshot | null>>;
}): Promise<{ file: string; snapshots: PageSnapshots; taken: number }> {
  const file = path.join(options.runDir, 'pages', 'snapshots.json');
  const existing = await readFile(file, 'utf8').then(
    (t) => PageSnapshots.safeParse(JSON.parse(t)),
    () => null,
  );
  const kept = existing?.success && existing.data.generationCommit === options.generationCommit ? existing.data.pages : [];
  const have = new Set(kept.map((p) => `${p.path}|${p.user ?? ''}`));
  const missing = options.requests.filter((r) => !have.has(`${r.path}|${r.user ?? ''}`));
  if (missing.length === 0 && existing?.success && kept.length > 0) return { file, snapshots: existing.data, taken: 0 };
  const taken = missing.length > 0 ? await options.take(missing) : [];
  const added: PageSnapshotEntry[] = missing.flatMap((r, i) => {
    const s = taken[i];
    return s ? [{ path: r.path, route: r.route, user: r.user, role: r.role, finalPath: s.finalPath, aria: s.aria }] : [];
  });
  const snapshots = PageSnapshots.parse({ schemaVersion: '1.0', generationCommit: options.generationCommit, takenAt: new Date().toISOString(), pages: [...kept, ...added] });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(snapshots, null, 2)}\n`, 'utf8');
  return { file, snapshots, taken: missing.length };
}

const viewer = (e: PageSnapshotEntry) => (e.user ? `logged in as ${e.user} (role ${e.role})` : 'not logged in');

/** The task section for a session's requirements: their pages' snapshots, without link URLs, at most PAGE_SNAPSHOT_TASK_CHARS. */
export function renderPageSnapshots(pages: readonly PageSnapshotEntry[], requirements: readonly PrdRequirement[]): string | null {
  const named = textPaths(requirements.flatMap((r) => [r.statement, ...r.acceptanceCriteria.map((c) => c.text)]));
  const mine = pages.filter((p) => named.some((n) => templateMatches(p.route, n)));
  if (mine.length === 0) return null;
  const blocks: string[] = [];
  const left: string[] = [];
  let used = 0;
  for (const p of mine) {
    const moved = p.finalPath !== p.path ? `; the browser ended on ${p.finalPath}` : '';
    const block = `### ${p.path} (${viewer(p)}${moved})\n\`\`\`yaml\n${snapshotForModel(p.aria)}\n\`\`\``;
    if (used + block.length > PAGE_SNAPSHOT_TASK_CHARS) left.push(`${p.path} (${viewer(p)})`);
    else {
      blocks.push(block);
      used += block.length;
    }
  }
  return [
    '## The pages as they are now (accessibility tree, taken on the running application)',
    'Text that a ui test case expects to see must be text these pages show (a heading, a label, a button, a message). For text that appears only after a step acts on the page (a message after submitting a form), set "afterAction": true on that expectation.',
    ...blocks,
    ...(left.length > 0 ? [`[left out because of the size limit: ${left.join(', ')}]`] : []),
  ].join('\n\n');
}

/** Lowercase, whitespace collapsed: how expectation text is looked up in a snapshot (link URLs left out). */
const normalise = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * F (SPEC §5): a ui test case's expected text must be on a page it opens, as its fixture user (or a visitor) sees it,
 * unless the expectation is marked afterAction and a step acts on the page after opening it. Checked only where a
 * snapshot of that page exists; URL paths and non-text values are not checked.
 */
export function snapshotProblems(sub: SubmitTestCases, pages: readonly PageSnapshotEntry[]): string[] {
  const problems: string[] = [];
  sub.testCases.forEach((tc, i) => {
    if (tc.layer !== 'ui') return;
    const users = new Set(tc.fixturesUsed);
    const opened = tc.steps.flatMap((step, s) => textPaths([step]).map((p) => ({ path: p, step: s })));
    const seen = pages.filter((p) => opened.some((o) => o.path === p.path) && (p.user === null || users.has(p.user)));
    if (seen.length === 0) return;
    // Prefer what the case's own user sees; a visitor's view only when there is none for its user.
    const byPath = new Map<string, PageSnapshotEntry[]>();
    for (const p of seen) byPath.set(p.path, [...(byPath.get(p.path) ?? []), p]);
    const views = [...byPath.values()].map((list) => list.find((p) => p.user !== null) ?? list[0]!);
    const text = views.map((v) => normalise(snapshotForModel(v.aria)));
    const firstOpen = Math.min(...opened.filter((o) => views.some((v) => v.path === o.path)).map((o) => o.step));
    tc.expected.forEach((e, j) => {
      if (typeof e.value !== 'string' || e.value.startsWith('/') || /^https?:\/\//.test(e.value) || e.value.trim() === '') return;
      if (text.some((t) => t.includes(normalise(e.value as string)))) return;
      const where = `testCases[${i}].expected[${j}]`;
      const page = views.map((v) => `${v.path} as ${v.user ? `${v.user} (role ${v.role})` : 'a visitor'} sees it`).join(', ');
      if (e.afterAction === true) {
        if (tc.steps.length - 1 > firstOpen) return;
        problems.push(`${where}: "afterAction" needs a step that acts on the page after opening it (fill, click, submit); this case only opens it`);
        return;
      }
      problems.push(
        `${where}.value ${JSON.stringify(e.value)} is not on ${page}; expect text the page shows (see "The pages as they are now"), or set "afterAction": true if it appears only after a step acts on the page`,
      );
    });
  });
  return problems;
}
