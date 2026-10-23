import { createHash } from 'node:crypto';
import type { CloudBuild, CloudVersion, Variants } from '../../shared/schemas.js';
import { shuffle } from '../sample.js';

/** The image's task list (SPEC §11.7): golden first, then every variant in variants.json order. */
export function versionsFrom(variants: Variants, variantsDir: string): CloudVersion[] {
  return [
    { version: 'golden', skipSeed: false },
    ...variants.variants.map((v): CloudVersion =>
      v.kind === 'code'
        ? { version: v.id, patch: `${variantsDir}/${v.patch}`, skipSeed: false }
        : { version: v.id, ...(v.configOverride ? { configOverride: v.configOverride } : {}), skipSeed: v.skipSeed },
    ),
  ];
}

/** A 32-bit seed from a repeat id (the Cloud Run execution name). */
export function repeatSeed(repeatId: string): number {
  return createHash('sha256').update(repeatId).digest().readUInt32BE(0);
}

/**
 * Opaque execution ids for one repeat: x-01 … x-NN shuffled over the versions with the repeat id as the
 * seed, so every task of a repeat derives the same mapping on its own and no id says which version it is.
 */
export function execIdsFor(versions: readonly string[], repeatId: string): Map<string, string> {
  const ids = versions.map((_, i) => `x-${String(i + 1).padStart(2, '0')}`);
  const shuffled = shuffle(ids, repeatSeed(repeatId));
  return new Map(versions.map((v, i) => [v, shuffled[i]!]));
}

const REPEAT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The task's version and execution id from Cloud Run's variables (SPEC §11.7). */
export function taskVersion(build: CloudBuild, env: NodeJS.ProcessEnv): { index: number; repeatId: string; version: CloudVersion; execId: string } {
  const rawIndex = env.CLOUD_RUN_TASK_INDEX;
  const index = rawIndex !== undefined && /^\d+$/.test(rawIndex) ? Number(rawIndex) : NaN;
  if (!Number.isInteger(index)) throw new Error(`CLOUD_RUN_TASK_INDEX must be a number, got ${JSON.stringify(rawIndex)}`);
  const version = build.versions[index];
  if (!version) throw new Error(`CLOUD_RUN_TASK_INDEX ${index} is outside the image's ${build.versions.length} versions`);
  const repeatId = env.CLOUD_RUN_EXECUTION ?? '';
  if (!REPEAT_ID.test(repeatId)) throw new Error(`CLOUD_RUN_EXECUTION must be a lowercase id like "eval-9b-abcde" or "local-1", got ${JSON.stringify(repeatId)}`);
  const execId = execIdsFor(build.versions.map((v) => v.version), repeatId).get(version.version)!;
  return { index, repeatId, version, execId };
}
