import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ScriptManifest, SuiteCases, TestCases } from '../../shared/schemas.js';
import type { ScenarioCase, ScriptManifestEntry } from '../../shared/schemas.js';

/** The combined suite's folder in the run: the original scripts and the kept scenario scripts. */
export const COMBINED_DIR = 'scripts-with-scenarios';

const withoutScenario = ({ scenario: _s, ...tc }: ScenarioCase) => tc;

/** `cases.json` content for a scripts folder: the cases its scripts were written from. */
export function suiteCases(testCases: readonly TestCases['testCases'][number][], scenarios: readonly ScenarioCase[]): SuiteCases {
  return SuiteCases.parse({ schemaVersion: '1.0', testCases: [...testCases, ...scenarios.map(withoutScenario)] });
}

/**
 * Writes `<run>/scripts-with-scenarios/` (SPEC §6.5): every file of scripts/ (the original suite, unchanged), the kept
 * scenario scripts, one manifest with both (the original entries first, file paths pointing into this folder) and
 * cases.json. The original scripts/ folder is never changed. Both sets must share the run's helpers.
 */
export async function combineSuite(input: {
  runDir: string;
  scenarioScriptsDir: string;
  kept: readonly ScenarioCase[];
  entries: ReadonlyMap<string, ScriptManifestEntry>;
}): Promise<{ scriptsDir: string; tc: number; sc: number }> {
  const scriptsDir = path.join(input.runDir, 'scripts');
  const dir = path.join(input.runDir, COMBINED_DIR);
  const helpers = await readFile(path.join(scriptsDir, '_helpers.ts'), 'utf8');
  if ((await readFile(path.join(input.scenarioScriptsDir, '_helpers.ts'), 'utf8')) !== helpers) {
    throw new Error('The scenario scripts were written against other helpers than the suite; generate them again');
  }
  const original = ScriptManifest.parse(JSON.parse(await readFile(path.join(scriptsDir, 'manifest.json'), 'utf8')));
  const testCases = TestCases.parse(JSON.parse(await readFile(path.join(input.runDir, 'testcases.json'), 'utf8'))).testCases;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const name of await readdir(scriptsDir)) {
    if (name === 'manifest.json' || !/\.(ts|json)$/.test(name)) continue;
    await copyFile(path.join(scriptsDir, name), path.join(dir, name));
  }
  const scenarioEntries: ScriptManifestEntry[] = [];
  for (const sc of input.kept) {
    const entry = input.entries.get(sc.id);
    if (!entry) throw new Error(`No manifest entry for ${sc.id}`);
    await copyFile(path.join(input.scenarioScriptsDir, `${sc.id}.spec.ts`), path.join(dir, `${sc.id}.spec.ts`));
    scenarioEntries.push({ ...entry, file: `${COMBINED_DIR}/${sc.id}.spec.ts` });
  }
  const manifest = ScriptManifest.parse({
    ...original,
    scripts: [...original.scripts.map((e) => ({ ...e, file: `${COMBINED_DIR}/${e.testCaseId}.spec.ts` })), ...scenarioEntries],
  });
  await writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(dir, 'cases.json'), `${JSON.stringify(suiteCases(testCases, input.kept), null, 2)}\n`);
  return { scriptsDir: COMBINED_DIR, tc: original.scripts.length, sc: scenarioEntries.length };
}
