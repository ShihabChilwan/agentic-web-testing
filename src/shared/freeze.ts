import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_MAX_TOKENS_PER_CALL } from '../agent/runtime.js';
import type { LLMConfig } from './config.js';
import { PROJECT_ROOT } from './paths.js';
import { FIRST_PASS_TEST_CASES, FreezeRecord, MAX_TEST_CASES, MAX_TEST_CASES_PER_REQUIREMENT, SCHEMA_VERSION } from './schemas.js';
import type { FrozenInfo } from './schemas.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_FREEZE_TAG = 'freeze-v1';
export const FREEZE_FILE = 'freeze/freeze.json';
/** What the freeze covers, relative to the project root (`targets/<name>` of the evaluated target is added when it exists at the tag). */
export const FROZEN_PATHS = ['src', 'tools', 'cloud', 'tests', 'config', 'package.json', 'package-lock.json', 'freeze'];

/** A request-body fragment that could carry a credential; LLM_EXTRA_BODY holds provider routing only. */
const SECRET_LOOKING = /key|token|secret|password|authorization|bearer/i;

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const fileSha = async (file: string) => (existsSync(file) ? sha256(await readFile(file)) : null);

export interface FreezeOptions {
  projectRoot?: string;
  tag?: string;
  now?: Date;
}

/** The freeze record for the current state; throws on a dirty tree or a request body that looks like it holds a credential. */
export async function buildFreezeRecord(config: LLMConfig, options: FreezeOptions = {}): Promise<FreezeRecord> {
  const root = options.projectRoot ?? PROJECT_ROOT;
  const dirty = (await git(root, ['status', '--porcelain'])).trim();
  if (dirty) throw new Error(`Commit first: the freeze records HEAD, and these files differ from it:\n${dirty}`);
  if (SECRET_LOOKING.test(JSON.stringify(config.extraBody))) {
    throw new Error('LLM_EXTRA_BODY looks like it holds a credential; it may hold provider routing only');
  }
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  const playwrightVersion = pkg.dependencies?.['@playwright/test'] ?? 'unknown';
  const lock = await fileSha(path.join(root, 'package-lock.json'));
  if (!lock) throw new Error('package-lock.json is missing');
  const host = (() => {
    try {
      return config.baseUrl ? new URL(config.baseUrl).host : null;
    } catch {
      return null;
    }
  })();
  return FreezeRecord.parse({
    schemaVersion: SCHEMA_VERSION,
    tag: options.tag ?? DEFAULT_FREEZE_TAG,
    recordedAt: (options.now ?? new Date()).toISOString(),
    baseCommit: (await git(root, ['rev-parse', 'HEAD'])).trim(),
    llm: {
      provider: config.provider,
      baseUrlHost: host,
      models: { ...config.models, other: config.model },
      temperature: config.temperature,
      topP: config.topP,
      reasoningEffort: { ...config.reasoningEfforts, other: config.reasoningEffort },
      reasoningParam: config.reasoningParam,
      concurrency: config.concurrency,
      contextTokens: config.contextTokens,
      timeoutMs: config.timeoutMs,
      extraBody: config.extraBody,
      maxTokensPerCall: DEFAULT_MAX_TOKENS_PER_CALL,
    },
    limits: { maxTestCases: MAX_TEST_CASES, firstPassTestCases: FIRST_PASS_TEST_CASES, maxTestCasesPerRequirement: MAX_TEST_CASES_PER_REQUIREMENT },
    files: { packageLockSha256: lock, specSha256: await fileSha(path.join(root, 'SPEC.md')), claudeSha256: await fileSha(path.join(root, 'CLAUDE.md')) },
    playwrightVersion,
  });
}

/** `npm run freeze:record`: writes freeze/freeze.json. Refused once the tag exists (a freeze is never rewritten). */
export async function recordFreeze(config: LLMConfig, options: FreezeOptions = {}): Promise<{ file: string; record: FreezeRecord }> {
  const root = options.projectRoot ?? PROJECT_ROOT;
  const tag = options.tag ?? DEFAULT_FREEZE_TAG;
  const exists = await git(root, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]).then(() => true, () => false);
  if (exists) throw new Error(`Tag ${tag} already exists; a freeze is never rewritten (use a new tag name for a new freeze)`);
  const record = await buildFreezeRecord(config, { ...options, tag });
  const file = path.join(root, FREEZE_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return { file, record };
}

export type FreezeStatus =
  | { state: 'not-recorded' }
  | { state: 'frozen'; frozen: FrozenInfo }
  | { state: 'not-frozen'; reasons: string[] };

export interface CheckFrozenOptions extends FreezeOptions {
  /** The target about to be used: its folder must be unchanged since the tag when it existed then. */
  target?: string;
  /** The model settings in force; compared with the recorded ones. */
  llmConfig?: LLMConfig;
}

/** Fields of the recorded model settings that differ from the settings in force. */
export function settingsDifferences(record: FreezeRecord, config: LLMConfig): string[] {
  const now = {
    provider: config.provider,
    models: { ...config.models, other: config.model },
    temperature: config.temperature,
    topP: config.topP,
    reasoningEffort: { ...config.reasoningEfforts, other: config.reasoningEffort },
    reasoningParam: config.reasoningParam,
    concurrency: config.concurrency,
    contextTokens: config.contextTokens,
    timeoutMs: config.timeoutMs,
    extraBody: config.extraBody,
  };
  const then = record.llm as Record<string, unknown>;
  return Object.entries(now)
    .filter(([key, value]) => JSON.stringify(sortKeys(value)) !== JSON.stringify(sortKeys(then[key])))
    .map(([key]) => `model setting ${key} differs from freeze.json`);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortKeys(v)]));
  return value;
}

/**
 * Whether the framework is the frozen one: freeze/freeze.json exists, its tag exists and the tagged commit differs from
 * the recorded base only by that file, the working tree and HEAD match the tag in every frozen path (and in the
 * evaluated target's folder when it existed at the tag, except the evaluation draw), and the model settings are the recorded ones.
 */
export async function checkFrozen(options: CheckFrozenOptions = {}): Promise<FreezeStatus> {
  const root = options.projectRoot ?? PROJECT_ROOT;
  const file = path.join(root, FREEZE_FILE);
  if (!existsSync(file)) return { state: 'not-recorded' };
  const text = await readFile(file, 'utf8');
  const record = FreezeRecord.parse(JSON.parse(text));
  const reasons: string[] = [];
  const tagCommit = (await git(root, ['rev-parse', '--verify', '--quiet', `refs/tags/${record.tag}^{commit}`]).catch(() => '')).trim();
  if (!tagCommit) return { state: 'not-frozen', reasons: [`tag ${record.tag} does not exist yet (commit freeze/freeze.json, then create the tag)`] };

  const sinceBase = (await git(root, ['diff', '--name-only', record.baseCommit, tagCommit]).catch(() => 'unknown base commit\n')).split('\n').filter(Boolean);
  if (sinceBase.some((f) => f !== FREEZE_FILE)) reasons.push(`tag ${record.tag} differs from the recorded base ${record.baseCommit.slice(0, 7)} in: ${sinceBase.filter((f) => f !== FREEZE_FILE).join(', ')}`);

  const paths = [...FROZEN_PATHS];
  if (options.target) {
    const dir = `targets/${options.target}`;
    const atTag = (await git(root, ['ls-tree', '--name-only', tagCommit, `${dir}/`]).catch(() => '')).trim();
    if (atTag) paths.push(dir);
  }
  // The evaluation draw (variants.json, variants/) is written into the target's folder after the tag.
  const draw = options.target ? [`:(exclude)targets/${options.target}/variants.json`, `:(exclude)targets/${options.target}/variants`] : [];
  const changed = (await git(root, ['diff', '--name-only', tagCommit, '--', ...paths, ...draw])).split('\n').filter(Boolean);
  if (changed.length > 0) reasons.push(`changed since ${record.tag}: ${changed.slice(0, 8).join(', ')}${changed.length > 8 ? ` (+${changed.length - 8} more)` : ''}`);
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '--', ...paths, ...draw])).split('\n').filter(Boolean);
  if (untracked.length > 0) reasons.push(`untracked in frozen paths: ${untracked.slice(0, 8).join(', ')}`);
  if (options.llmConfig) reasons.push(...settingsDifferences(record, options.llmConfig));

  if (reasons.length > 0) return { state: 'not-frozen', reasons };
  return { state: 'frozen', frozen: { tag: record.tag, commit: (await git(root, ['rev-parse', 'HEAD'])).trim(), freezeSha256: sha256(text) } };
}

/** The `frozen` field for a new run: set only when the framework is the frozen one; never throws. */
export async function currentFrozen(options: CheckFrozenOptions = {}): Promise<FrozenInfo | undefined> {
  try {
    const status = await checkFrozen(options);
    return status.state === 'frozen' ? status.frozen : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The guard of the `eval` commands: after a freeze is recorded, they run only on the frozen framework unless
 * `allowUnfrozen`. Before any freeze is recorded there is nothing to guard. Returns the frozen info when frozen.
 */
export async function requireFrozen(options: CheckFrozenOptions & { allowUnfrozen?: boolean; log?: (message: string) => void }): Promise<FrozenInfo | undefined> {
  const status = await checkFrozen(options);
  if (status.state === 'frozen') return status.frozen;
  if (status.state === 'not-recorded') return undefined;
  const message = `Not the frozen framework:\n  ${status.reasons.join('\n  ')}`;
  if (options.allowUnfrozen) {
    options.log?.(`${message}\n  (continuing because of --allow-unfrozen; results from this run are development results)`);
    return undefined;
  }
  throw new Error(`${message}\nRun on the tagged commit, or pass --allow-unfrozen for development work.`);
}
