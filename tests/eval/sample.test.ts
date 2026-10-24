import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { applyMutant, filePatch, mutantLines } from '../../src/eval/patch.js';
import { candidatesFrom, changedLines, devBugOverlap, draw, near, shuffle, type Candidate } from '../../src/eval/sample.js';
import { MutationReport } from '../../src/eval/stryker.js';
import { envSignature, readDevBugs } from '../../src/eval/variants.js';
import { startFailure } from '../../src/eval/start-check.js';

// Real Stryker 10.0.0 output (tests/fixtures/stryker/README.md) and the real dev-bug patches.
const fixture = (name: string) => new URL(`../fixtures/stryker/${name}`, import.meta.url);
const report = MutationReport.parse(JSON.parse(await readFile(fixture('mutation.json'), 'utf8')));
const devBugDir = new URL('../../targets/mern-ecommerce/dev-bugs/', import.meta.url);
const AUTH = 'server/routes/api/auth.js';
const LOGIN = 'client/app/containers/Login/index.js';
const MUTATE = { backend: ['server/routes/api/*.js'], frontend: ['client/app/containers/**/{actions,reducer,index}.js'] };

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('candidates', () => {
  const candidates = candidatesFrom(report, MUTATE);

  it('keep only behaviour-changing mutators, with the layer of the glob that matched, in a stable order', () => {
    expect(new Set(candidates.map((c) => c.mutator))).not.toContain('StringLiteral');
    expect(new Set(candidates.map((c) => c.mutator))).not.toContain('BlockStatement');
    expect(candidates.filter((c) => c.file === AUTH).every((c) => c.layer === 'backend')).toBe(true);
    expect(candidates.filter((c) => c.file === LOGIN).every((c) => c.layer === 'frontend')).toBe(true);
    expect(candidates.find((c) => c.mutantId === '5213')).toMatchObject({ mutator: 'BooleanLiteral', lines: [48, 48], replacement: 'isMatch' });
    const keys = candidates.map((c) => `${c.file}:${String(c.start.line).padStart(5, '0')}:${String(c.start.column).padStart(4, '0')}`);
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
  });

  it('drop files no glob matches', () => {
    expect(candidatesFrom(report, { backend: MUTATE.backend, frontend: [] }).some((c) => c.file === LOGIN)).toBe(false);
  });

  it('shuffle the same way for the same seed only', () => {
    const ids = (seed: number) => shuffle(candidates, seed).map((c) => c.mutantId);
    expect(ids(20261022)).toEqual(ids(20261022));
    expect(ids(20261022)).not.toEqual(ids(20261023));
    expect([...ids(1)].sort()).toEqual(candidates.map((c) => c.mutantId).sort());
  });
});

describe('dev-bug overlap', () => {
  it('reads the changed golden lines from the real dev-bug patches', async () => {
    const dev1 = await readFile(new URL('dev-001-login-accepts-any-password.patch', devBugDir), 'utf8');
    const dev2 = await readFile(new URL('dev-002-login-redirects-home.patch', devBugDir), 'utf8');
    expect(changedLines('dev-001.patch', dev1)).toEqual([{ patch: 'dev-001.patch', file: AUTH, lines: [48] }]);
    expect(changedLines('dev-002.patch', dev2)).toEqual([{ patch: 'dev-002.patch', file: LOGIN, lines: [32] }]);
  });

  it('reads every patch under dev-bugs/, nested trial draws included', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dev-bugs-'));
    tempDirs.push(dir);
    await mkdir(path.join(dir, 'dev-bugs', 'trial-x', 'variants'), { recursive: true });
    await writeFile(path.join(dir, 'dev-bugs', 'a.patch'), '--- a/x.js\n+++ b/x.js\n@@ -3,1 +3,1 @@\n-a\n+b\n');
    await writeFile(path.join(dir, 'dev-bugs', 'trial-x', 'variants', 'bug-001.patch'), '--- a/y.js\n+++ b/y.js\n@@ -9,1 +9,1 @@\n-a\n+b\n');
    await writeFile(path.join(dir, 'dev-bugs', 'EXPECTED.md'), '# notes\n');
    expect(await readDevBugs(dir)).toEqual([
      { patch: 'a.patch', file: 'x.js', lines: [3] },
      { patch: 'trial-x/variants/bug-001.patch', file: 'y.js', lines: [9] },
    ]);
    // The real target: the two hand-written dev bugs and the 12 bugs of the trial draw.
    const real = await readDevBugs(fileURLToPath(new URL('../../targets/mern-ecommerce/', import.meta.url)));
    expect(real).toHaveLength(14);
    expect(real).toContainEqual({ patch: 'trial-20261022/variants/bug-006.patch', file: AUTH, lines: [40] });
  });

  it('marks the line before an insertion, and ignores removed lines that look like headers', () => {
    const patch = ['--- a/x.js', '+++ b/x.js', '@@ -10,2 +10,3 @@', ' a', '+b', ' c', '@@ -20,2 +21,1 @@', '--- old comment', ' d'].join('\n');
    expect(changedLines('p', patch)).toEqual([{ patch: 'p', file: 'x.js', lines: [10, 20] }]);
  });

  it('redraws a mutant within 5 lines of a dev bug in the same file only', () => {
    const devBugs = [{ patch: 'dev-001.patch', file: AUTH, lines: [48] }];
    const at = (file: string, line: number) => ({ file, lines: [line, line] }) as Candidate;
    expect(devBugOverlap(at(AUTH, 48), devBugs, 5)).toEqual({ patch: 'dev-001.patch', line: 48 });
    expect(devBugOverlap(at(AUTH, 43), devBugs, 5)).not.toBeNull();
    expect(devBugOverlap(at(AUTH, 42), devBugs, 5)).toBeNull();
    expect(devBugOverlap({ file: AUTH, lines: [30, 60] } as Candidate, devBugs, 5)).not.toBeNull();
    expect(devBugOverlap(at(LOGIN, 48), devBugs, 5)).toBeNull();
    expect(near([10, 12], [17, 17], 5)).toBe(true);
    expect(near([10, 12], [18, 18], 5)).toBe(false);
  });
});

describe('draw', () => {
  const make = (id: number, file: string, line: number, layer: Candidate['layer'] = 'backend'): Candidate => ({
    mutantId: String(id),
    file,
    layer,
    mutator: 'EqualityOperator',
    start: { line, column: 1 },
    end: { line, column: 2 },
    replacement: 'x',
    lines: [line, line],
  });

  it('fills the quotas in order, records discards with reasons, and passes over full files and near neighbours silently', async () => {
    const shuffled = [
      make(1, 'a.js', 10),
      make(2, 'a.js', 12), // near 1: passed over
      make(3, 'dev.js', 50), // dev bug: overlaps-dev-bug
      make(4, 'b.js', 10), // start fails
      make(5, 'a.js', 40),
      make(6, 'a.js', 80), // a.js full: passed over
      make(7, 'c.js', 5),
      make(8, 'f.js', 5, 'frontend'),
      make(9, 'g.js', 5, 'frontend'), // frontend full: passed over
    ];
    const tried: string[] = [];
    const { accepted, discards } = await draw(
      shuffled,
      { quota: { backend: 3, frontend: 1, maxPerFile: 2 }, window: 5, devBugs: [{ patch: 'dev-009.patch', file: 'dev.js', lines: [52] }] },
      async (c) => {
        tried.push(c.mutantId);
        return c.mutantId === '4' ? { ok: false, reason: 'start-failed', detail: 'backend exited (code 1)' } : { ok: true };
      },
    );
    expect(accepted.map((c) => c.mutantId)).toEqual(['1', '5', '7', '8']);
    expect(tried).toEqual(['1', '4', '5', '7', '8']);
    expect(discards).toEqual([
      { strykerMutantId: '3', file: 'dev.js', lines: [50, 50], mutator: 'EqualityOperator', reason: 'overlaps-dev-bug', detail: 'within 5 lines of dev-009.patch (line 52)' },
      { strykerMutantId: '4', file: 'b.js', lines: [10, 10], mutator: 'EqualityOperator', reason: 'start-failed', detail: 'backend exited (code 1)' },
    ]);
  });

  it('fails when the candidates run out before the quotas are met', async () => {
    await expect(
      draw([make(1, 'a.js', 1)], { quota: { backend: 2, frontend: 0, maxPerFile: 2 }, window: 5, devBugs: [] }, async () => ({ ok: true })),
    ).rejects.toThrow(/Only 1 of 2 code variants found \(backend 1\/2/);
  });
});

describe('patch', () => {
  it('applies a mutant at Stryker 1-based, end-exclusive positions and writes a patch git apply accepts on a golden export', async () => {
    const source = report.files[AUTH]!.source;
    const mutant = candidatesFrom(report, MUTATE).find((c) => c.mutantId === '5213')!;
    const mutated = applyMutant(source, mutant);
    expect(mutantLines(source, mutated, mutant)).toEqual({ original: '    if (!isMatch) {', mutated: '    if (isMatch) {' });

    const patch = await filePatch(AUTH, source, mutated);
    expect(patch.split('\n').slice(0, 4)).toEqual([`diff --git a/${AUTH} b/${AUTH}`, expect.stringMatching(/^index /), `--- a/${AUTH}`, `+++ b/${AUTH}`]);

    const dir = await mkdtemp(path.join(tmpdir(), 'eval-patch-'));
    tempDirs.push(dir);
    await mkdir(path.join(dir, path.dirname(AUTH)), { recursive: true });
    await writeFile(path.join(dir, AUTH), source);
    await writeFile(path.join(dir, 'm.patch'), patch);
    execFileSync('git', ['apply', 'm.patch'], { cwd: dir }); // the same call buildSourceTree makes, outside any repo
    expect(await readFile(path.join(dir, AUTH), 'utf8')).toBe(mutated);
  });

  it('keeps multi-line replacements and line counts straight', () => {
    const source = 'a\nswitch (x) {\n  case 1:\n    y();\n    break;\n}\nz\n';
    const c = { start: { line: 3, column: 3 }, end: { line: 5, column: 11 }, replacement: 'case 1:', lines: [3, 5] as [number, number] };
    const mutated = applyMutant(source, c);
    expect(mutated).toBe('a\nswitch (x) {\n  case 1:\n}\nz\n');
    expect(mutantLines(source, mutated, c)).toEqual({ original: '  case 1:\n    y();\n    break;', mutated: '  case 1:' });
  });
});

describe('start checks', () => {
  const ok = { healthChecks: { backend: true, frontend: true }, exited: { backend: null, frontend: null }, buildErrors: [] as Array<'backend' | 'frontend'> };

  it('fail a start only for an exited process or a build error, not for a failed health check', () => {
    expect(startFailure(ok)).toBeNull();
    expect(startFailure({ ...ok, healthChecks: { backend: false, frontend: true } })).toBeNull();
    expect(startFailure({ ...ok, exited: { backend: { code: 1, signal: null }, frontend: null } })).toBe('backend exited (code 1)');
    expect(startFailure({ ...ok, buildErrors: ['frontend'] })).toBe('frontend build failed');
  });

  it('compare two environment-fault starts without console errors', () => {
    const app = { logins: { broken: [], unreachable: false }, page: { document: 200, requests: ['GET http://localhost:3999/api/x -> failed net::ERR_CONNECTION_REFUSED'], consoleErrors: 3 } };
    const a = { ...ok, app };
    expect(envSignature(a)).toBe(envSignature({ ...ok, app: { ...app, page: { ...app.page, consoleErrors: 7 } } }));
    expect(envSignature(a)).not.toBe(envSignature({ ...ok, app: { ...app, page: { ...app.page, requests: [] } } }));
  });
});
