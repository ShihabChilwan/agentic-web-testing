import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { resolveCommit } from '../../modules/execution-engine/index.js';
import { readRunManifest } from '../../shared/run-manifest.js';
import { PROJECT_ROOT, RUNS_DIR, runPaths, TARGETS_DIR, targetPaths } from '../../shared/paths.js';
import { CloudBuild, Variants, type EvaluationConfig, type TargetConfig } from '../../shared/schemas.js';
import { loadTargetConfig } from '../../shared/target-config.js';
import { loadEvaluationConfig } from '../variants.js';
import { filesUnder, suiteHash } from './suite.js';
import { versionsFrom } from './versions.js';

const execFileAsync = promisify(execFile);
const TEMPLATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'template');

/** Paths of the project never copied into the image: tests, development bugs, the evaluation's answers and host scripts. */
const EXCLUDED = (target: string) => ['tests', 'cloud', '.env.example', `targets/${target}/repo`, `targets/${target}/dev-bugs`, `targets/${target}/variants.json`, `targets/${target}/evaluation.json`];

/** Anything that looks like a secret fails the build folder (no key or .env ever goes into the image). */
const SECRET = /\b(?:LLM|OPENROUTER|ANTHROPIC|OPENAI)_API_KEY\s*=\s*['"]?[A-Za-z0-9_-]{8,}|\bsk-[A-Za-z0-9_-]{20,}|BEGIN [A-Z ]*PRIVATE KEY/;

export interface CloudContextOptions {
  target: string;
  runId: string;
  /** Default: <project>/build/cloud. Replaced on every call. */
  outDir?: string;
  projectRoot?: string;
  runsDir?: string;
  targetsDir?: string;
  /** The variant list to build the image for, relative to targets/<name>/ (default variants.json; e.g. a development draw under dev-bugs/). */
  variantsFile?: string;
  /** Install production dependencies in a temp folder and load the task's CLI there (default true; off in unit tests). */
  checkInstall?: boolean;
  log?: (message: string) => void;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd, maxBuffer: 50 * 1024 * 1024 })).stdout;
}

/** Applies every `from → to` text replacement to every string inside `value`. */
export function replaceDeep<T>(value: T, replace: Record<string, string>): T {
  if (typeof value === 'string') return Object.entries(replace).reduce((s, [from, to]) => s.split(from).join(to), value as string) as T;
  if (Array.isArray(value)) return value.map((v) => replaceDeep(v, replace)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceDeep(v, replace)])) as T;
  return value;
}

/** Files under `dir` that are named .env or contain something that looks like a key. */
export async function findSecrets(dir: string): Promise<string[]> {
  const hits: string[] = [];
  for (const rel of await filesUnder(dir)) {
    if (/(^|\/)\.env(\.|$)/.test(rel)) {
      hits.push(rel);
      continue;
    }
    const buffer = await readFile(path.join(dir, rel));
    if (buffer.includes(0)) continue;
    if (SECRET.test(buffer.toString('utf8'))) hits.push(rel);
  }
  return hits;
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in values)) throw new Error(`Unknown template value {{${key}}}`);
    return values[key]!;
  });
}

/** Dockerfile lines that install each service's packages and record the lockfile hash (SPEC §7.5). */
function installLines(config: TargetConfig): string {
  const services = [config.backend, ...(config.frontend ? [config.frontend] : [])].filter((s, i, all) => all.findIndex((o) => o.cwd === s.cwd) === i);
  return services
    .map((s) => ` && (cd ${path.posix.join(config.repoPath, s.cwd)} && ${s.install} && sha256sum package-lock.json | cut -d' ' -f1 > node_modules/.lockfile-hash) \\\n`)
    .join('');
}

/**
 * Installs only production dependencies (as the image does) into a temporary copy of `appDir` and loads the
 * task's CLI there. A package that src/ needs at run time but that is a devDependency fails here, not in the cloud.
 */
export async function checkProductionInstall(appDir: string): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'awt-prod-'));
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
  try {
    await cp(appDir, dir, { recursive: true });
    const step = async (what: string, file: string, args: string[]) => {
      try {
        await execFileAsync(file, args, { cwd: dir, env, maxBuffer: 50 * 1024 * 1024, timeout: 10 * 60_000 });
      } catch (err) {
        const { stderr = '', stdout = '' } = err as { stderr?: string; stdout?: string };
        throw new Error(`${what} failed with production dependencies only:\n${(stderr || stdout).trim().split('\n').slice(0, 15).join('\n')}`, { cause: err });
      }
    };
    await step('npm ci --omit=dev', 'npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
    await step('Loading the CLI (eval cloud-task --help)', path.join(dir, 'node_modules', '.bin', 'tsx'), ['src/cli.ts', 'eval', 'cloud-task', '--help']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The image's entrypoint.sh for the target's `cloud` settings. */
export async function renderEntrypoint(cloud: Pick<NonNullable<EvaluationConfig['cloud']>, 'startServices' | 'serviceLogs'>): Promise<string> {
  return fill(await readFile(path.join(TEMPLATE_DIR, 'entrypoint.sh'), 'utf8'), {
    startServices: cloud.startServices || 'true',
    serviceLogs: cloud.serviceLogs.map((f) => `--service-log ${f}`).join(' '),
    serviceLogFiles: cloud.serviceLogs.join(' '),
  });
}

/** Path of the plain-Node fallback that writes status.json when the task cannot (copied into the image). */
export const FALLBACK_STATUS_SCRIPT = path.join(TEMPLATE_DIR, 'fallback-status.cjs');

export interface CloudContextResult {
  outDir: string;
  build: CloudBuild;
}

/**
 * `eval cloud-context` (SPEC §11.7): writes the Docker build folder for one target and one run's suite:
 * the committed framework (no tests, dev bugs or answers), the target repo's generation ref as a git bundle,
 * the suite, the version list and the generated Dockerfile. Refuses uncommitted changes and anything that
 * looks like a secret.
 */
export async function createCloudContext(options: CloudContextOptions): Promise<CloudContextResult> {
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const targetsDir = options.targetsDir ?? TARGETS_DIR;
  const log = options.log ?? (() => {});
  const outDir = options.outDir ?? path.join(projectRoot, 'build', 'cloud');

  const dirty = (await git(projectRoot, ['status', '--porcelain'])).trim();
  if (dirty) throw new Error(`Commit first: the image is tagged with the framework commit, and these files differ from it:\n${dirty}`);
  const frameworkCommit = (await git(projectRoot, ['rev-parse', 'HEAD'])).trim();

  const { config, repoDir, targetDir } = await loadTargetConfig(options.target, { targetsDir, projectRoot });
  const evaluation: EvaluationConfig = await loadEvaluationConfig(targetDir);
  const cloud = evaluation.cloud ?? { replace: {}, imageSetup: '', startServices: '', serviceLogs: [] };
  const variantsFile = path.join(targetPaths(options.target, targetsDir).dir, options.variantsFile ?? 'variants.json');
  const variants = Variants.parse(JSON.parse(await readFile(variantsFile, 'utf8')));
  const runDir = runPaths(options.runId, options.runsDir ?? RUNS_DIR).dir;
  const manifest = await readRunManifest(path.join(runDir, 'run.json'));
  if (manifest.target !== options.target) throw new Error(`Run ${options.runId} is for ${manifest.target}, not ${options.target}`);
  if (manifest.stages.scripts?.status !== 'done') throw new Error(`The scripts stage of ${options.runId} is not done`);
  const goldenCommit = await resolveCommit(repoDir, manifest.generationRef);
  if (goldenCommit !== variants.goldenCommit) throw new Error(`variants.json was made at ${variants.goldenCommit}, the run's ${manifest.generationRef} is ${goldenCommit}`);
  const hash = await suiteHash(runDir);
  const imageTag = `${frameworkCommit.slice(0, 7)}-${hash.slice(0, 8)}`;

  await rm(outDir, { recursive: true, force: true });
  const appDir = path.join(outDir, 'app');
  const imageDir = path.join(outDir, 'image');
  await mkdir(appDir, { recursive: true });
  await mkdir(imageDir, { recursive: true });

  log(`Framework ${frameworkCommit.slice(0, 7)}: exporting committed files`);
  const excludes = EXCLUDED(options.target).map((p) => `:(exclude)${p}`);
  const tarFile = path.join(outDir, 'app.tar');
  await git(projectRoot, ['archive', '--format=tar', '-o', tarFile, 'HEAD', '--', '.', ...excludes]);
  await execFileAsync('tar', ['-x', '-f', tarFile, '-C', appDir]);
  await rm(tarFile);
  // Patches of a development draw live under dev-bugs/, which the export leaves out: copy just those the versions use.
  for (const v of variants.variants) {
    if (v.kind !== 'code') continue;
    const to = path.join(appDir, path.relative(projectRoot, targetDir), v.patch);
    await mkdir(path.dirname(to), { recursive: true });
    await cp(path.join(targetDir, v.patch), to);
  }
  const relTargetDir = path.relative(targetsDir, targetDir);
  const appTargetConfig = path.join(appDir, 'targets', relTargetDir, 'target.config.json');
  const rawConfig = JSON.parse(await readFile(appTargetConfig, 'utf8')) as unknown;
  await writeFile(appTargetConfig, `${JSON.stringify(replaceDeep(rawConfig, cloud.replace), null, 2)}\n`);

  log(`Target ${manifest.generationRef} = ${goldenCommit.slice(0, 7)}: writing target.bundle`);
  await git(repoDir, ['bundle', 'create', path.join(outDir, 'target.bundle'), manifest.generationRef]);

  log(`Suite of ${options.runId}: ${hash.slice(0, 12)}`);
  const imageRun = path.join(imageDir, 'run');
  await mkdir(imageRun, { recursive: true });
  await writeFile(path.join(imageRun, 'run.json'), `${JSON.stringify({ ...manifest, executions: [] }, null, 2)}\n`);
  await cp(path.join(runDir, 'testcases.json'), path.join(imageRun, 'testcases.json'));
  await cp(path.join(runDir, 'scripts'), path.join(imageRun, 'scripts'), { recursive: true });

  const projectTargetDir = path.relative(projectRoot, targetDir).split(path.sep).join('/');
  const build = CloudBuild.parse({
    schemaVersion: '1.0',
    target: options.target,
    sourceRunId: options.runId,
    generationRef: manifest.generationRef,
    goldenCommit,
    frameworkCommit,
    suiteHash: hash,
    imageTag,
    createdAt: new Date().toISOString(),
    replace: cloud.replace,
    versions: replaceDeep(versionsFrom(variants, projectTargetDir), cloud.replace),
  });
  await writeFile(path.join(imageDir, 'build.json'), `${JSON.stringify(build, null, 2)}\n`);

  const template = (name: string) => readFile(path.join(TEMPLATE_DIR, name), 'utf8');
  await writeFile(
    path.join(outDir, 'Dockerfile'),
    fill(await template('Dockerfile'), {
      nodeVersion: process.versions.node,
      imageSetup: cloud.imageSetup || 'true',
      generationRef: manifest.generationRef,
      repoPath: config.repoPath,
      installServices: installLines(config),
    }),
  );
  await writeFile(path.join(imageDir, 'entrypoint.sh'), await renderEntrypoint(cloud), { mode: 0o755 });
  await cp(FALLBACK_STATUS_SCRIPT, path.join(imageDir, 'fallback-status.cjs'));
  await writeFile(path.join(outDir, '.dockerignore'), await template('dockerignore'));

  if (options.checkInstall ?? true) {
    log('Checking that the CLI loads with production dependencies only (npm ci --omit=dev in a temp folder)...');
    try {
      await checkProductionInstall(appDir);
    } catch (err) {
      await rm(outDir, { recursive: true, force: true });
      throw err;
    }
  }

  const secrets = await findSecrets(outDir);
  if (secrets.length > 0) {
    await rm(outDir, { recursive: true, force: true });
    throw new Error(`The build folder would contain secrets; nothing was written. Files: ${secrets.join(', ')}`);
  }
  log(`Wrote ${outDir}: ${build.versions.length} versions, image tag ${imageTag}`);
  return { outDir, build };
}
