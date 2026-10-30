import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseLLMConfig } from '../../src/shared/config.js';
import { checkFrozen, currentFrozen, recordFreeze, requireFrozen } from '../../src/shared/freeze.js';

const config = parseLLMConfig({ LLM_BASE_URL: 'https://model.test/v1', LLM_API_KEY: 'sk-very-secret', LLM_EXTRA_BODY: '{"provider":{"order":["Wafer"]}}' });
let root: string;

const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.test', ...args], { cwd: root, encoding: 'utf8' });
const put = async (file: string, text: string) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text, 'utf8');
};
const commit = (message: string) => {
  git('add', '-A');
  git('commit', '-m', message);
};
/** Record, commit freeze.json and tag it, as the documented sequence does. */
const freeze = async () => {
  await recordFreeze(config, { projectRoot: root });
  commit('freeze');
  git('tag', '-a', 'freeze-v1', '-m', 'freeze');
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'awt-freeze-test-'));
  git('init', '-q');
  await put('package.json', JSON.stringify({ dependencies: { '@playwright/test': '1.64.0' } }));
  await put('package-lock.json', '{}\n');
  await put('src/a.ts', 'export const a = 1;\n');
  await put('docs/notes.md', 'notes\n');
  await put('targets/t/target.config.json', '{}\n');
  commit('base');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('freeze record', () => {
  it('refuses a dirty tree and writes no key', async () => {
    await put('src/a.ts', 'export const a = 2;\n');
    await expect(recordFreeze(config, { projectRoot: root })).rejects.toThrow(/Commit first/);
    commit('change');
    const { file, record } = await recordFreeze(config, { projectRoot: root });
    const text = await readFile(file, 'utf8');
    expect(text).not.toContain('sk-very-secret');
    expect(record.llm.baseUrlHost).toBe('model.test');
    expect(record.llm.extraBody).toEqual({ provider: { order: ['Wafer'] } });
    expect(record.limits).toMatchObject({ maxTestCases: 250, firstPassTestCases: 150 });
    expect(record.baseCommit).toBe(git('rev-parse', 'HEAD').trim());
  });

  it('refuses a request body that looks like it holds a credential, and a tag that exists', async () => {
    const bad = parseLLMConfig({ LLM_BASE_URL: 'https://model.test/v1', LLM_EXTRA_BODY: '{"api_key":"x"}' });
    await expect(recordFreeze(bad, { projectRoot: root })).rejects.toThrow(/credential/);
    await freeze();
    await expect(recordFreeze(config, { projectRoot: root })).rejects.toThrow(/already exists/);
  });
});

describe('freeze check', () => {
  it('has nothing to check before a freeze is recorded', async () => {
    expect(await checkFrozen({ projectRoot: root })).toEqual({ state: 'not-recorded' });
    expect(await requireFrozen({ projectRoot: root })).toBeUndefined();
  });

  it('is not frozen until the tag exists, then frozen at the tagged commit', async () => {
    await recordFreeze(config, { projectRoot: root });
    commit('freeze');
    const before = await checkFrozen({ projectRoot: root });
    expect(before.state === 'not-frozen' && before.reasons[0]).toMatch(/does not exist yet/);
    git('tag', '-a', 'freeze-v1', '-m', 'freeze');
    const status = await checkFrozen({ projectRoot: root, llmConfig: config });
    expect(status.state).toBe('frozen');
    if (status.state === 'frozen') expect(status.frozen).toMatchObject({ tag: 'freeze-v1', commit: git('rev-parse', 'HEAD').trim() });
    expect((await currentFrozen({ projectRoot: root }))?.tag).toBe('freeze-v1');
  });

  it('is not frozen after a change, committed or not, to a frozen path; other paths may change', async () => {
    await freeze();
    await put('docs/notes.md', 'more notes\n');
    commit('docs');
    expect((await checkFrozen({ projectRoot: root })).state).toBe('frozen');
    await put('src/a.ts', 'export const a = 3;\n');
    const edited = await checkFrozen({ projectRoot: root });
    expect(edited.state === 'not-frozen' && edited.reasons.join()).toContain('src/a.ts');
    commit('src');
    expect((await checkFrozen({ projectRoot: root })).state).toBe('not-frozen');
    expect(await currentFrozen({ projectRoot: root })).toBeUndefined();
    await expect(requireFrozen({ projectRoot: root })).rejects.toThrow(/Not the frozen framework/);
    const logged: string[] = [];
    expect(await requireFrozen({ projectRoot: root, allowUnfrozen: true, log: (m) => logged.push(m) })).toBeUndefined();
    expect(logged.join()).toContain('development results');
  });

  it('is not frozen with a new file in a frozen path, or when the tag is not the recorded base plus freeze.json', async () => {
    await freeze();
    await put('src/new.ts', 'export {};\n');
    expect((await checkFrozen({ projectRoot: root })).state).toBe('not-frozen');
    await rm(path.join(root, 'src/new.ts'));
    expect((await checkFrozen({ projectRoot: root })).state).toBe('frozen');

    // A second repo where the tagged commit also changes code after the record.
    await rm(path.join(root, '.git'), { recursive: true, force: true });
    git('init', '-q');
    commit('again');
    await recordFreeze(config, { projectRoot: root, tag: 'freeze-v9' });
    await put('src/a.ts', 'export const a = 4;\n');
    commit('freeze plus code');
    git('tag', '-a', 'freeze-v9', '-m', 'x');
    const status = await checkFrozen({ projectRoot: root });
    expect(status.state === 'not-frozen' && status.reasons.join()).toContain('differs from the recorded base');
  });

  it('allows the evaluation draw in the target folder but not a change to its config', async () => {
    await freeze();
    await put('targets/t/variants.json', '{}\n');
    await put('targets/t/variants/bug-001.patch', 'x\n');
    expect((await checkFrozen({ projectRoot: root, target: 't' })).state).toBe('frozen');
    commit('draw');
    expect((await checkFrozen({ projectRoot: root, target: 't' })).state).toBe('frozen');
    await put('targets/t/target.config.json', '{"changed":true}\n');
    commit('config');
    expect((await checkFrozen({ projectRoot: root, target: 't' })).state).toBe('not-frozen');
    expect((await checkFrozen({ projectRoot: root, target: 'new-target' })).state).toBe('frozen');
  });

  it('is not frozen when the model settings differ from the recorded ones', async () => {
    await freeze();
    const other = parseLLMConfig({ LLM_BASE_URL: 'https://model.test/v1', LLM_EXTRA_BODY: '{"provider":{"order":["Wafer"]}}', LLM_TEMPERATURE: '0.2' });
    const status = await checkFrozen({ projectRoot: root, llmConfig: other });
    expect(status.state === 'not-frozen' && status.reasons).toEqual(['model setting temperature differs from freeze.json']);
  });
});
