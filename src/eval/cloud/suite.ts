import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

async function filesUnder(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await filesUnder(path.join(dir, entry.name), rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/** sha256 over testcases.json and every file in scripts/ (paths and contents, sorted): what the image executes. */
export async function suiteHash(runDir: string): Promise<string> {
  const hash = createHash('sha256');
  const files = ['testcases.json', ...(await filesUnder(path.join(runDir, 'scripts'), 'scripts'))].sort();
  for (const rel of files) {
    hash.update(`${rel}\0`);
    hash.update(await readFile(path.join(runDir, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export { filesUnder };
