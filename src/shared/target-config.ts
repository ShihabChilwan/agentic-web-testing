import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT, TARGETS_DIR, targetPaths } from './paths.js';
import { TargetConfig } from './schemas.js';

export interface LoadedTarget {
  config: TargetConfig;
  /** Absolute path of targets/<name>/ (config and helper files). */
  targetDir: string;
  /** Absolute path of the cloned target repo. */
  repoDir: string;
}

/** Reads and validates targets/<name>/target.config.json. */
export async function loadTargetConfig(
  name: string,
  { targetsDir = TARGETS_DIR, projectRoot = PROJECT_ROOT } = {},
): Promise<LoadedTarget> {
  const paths = targetPaths(name, targetsDir);
  let raw: string;
  try {
    raw = await readFile(paths.config, 'utf8');
  } catch {
    throw new Error(`No target config at ${paths.config}`);
  }
  const result = TargetConfig.safeParse(JSON.parse(raw));
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid ${paths.config}:\n${issues}`);
  }
  const config = result.data;
  if (config.name !== name) {
    throw new Error(`${paths.config} has name "${config.name}", expected "${name}"`);
  }
  return { config, targetDir: paths.dir, repoDir: path.resolve(projectRoot, config.repoPath) };
}
