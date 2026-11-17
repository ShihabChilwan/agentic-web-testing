/* global console, process */
// Checks the pre-registered hashes of the main scoring (scoring/PROTOCOL.md and its code) on today's tree:
//   node scoring/hash-check.mjs
// `npx tsx scoring/cli.ts hash` hashes every .ts file under scoring/, so since the later measurements added their
// own folders (each with its own protocol and hashes) it no longer prints the registered code hash. This script
// applies the same rule (sha256 of "<relative path>\n<sha256 of file>" lines, sorted by path, outside tests, out
// and node_modules) but also leaves out those folders. It is a .mjs file, so it is not part of the hashed code
// itself, and scoring/cli.ts stays byte for byte the registered version.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
/** Folders the hash of scoring/cli.ts leaves out (as in cli.ts), plus the later, separately registered measurements. */
const SKIP = ['tests', 'out', 'node_modules', 'differential', 'differential-kutt', 'scenarios'];
/** Pre-registered 30 Oct 2026 17:03 UTC. */
const REGISTERED = {
  protocol: '554b1969f726ea6617786a7bf9de360862413cacb3612814cd86a040de504142',
  code: '4f305962e4f0097f63a8debce8252a9f4da7a0ef69175e417dfac56cfabc5bff',
};

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

async function walk(dir, files) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP.includes(e.name)) await walk(p, files);
    } else if (e.name.endsWith('.ts')) files.push(p);
  }
  return files;
}

const protocol = sha256(await readFile(path.join(root, 'PROTOCOL.md')));
const files = (await walk(root, [])).sort();
const parts = [];
for (const f of files) parts.push(`${path.relative(root, f)}\n${sha256(await readFile(f))}`);
const code = sha256(parts.join('\n'));

console.log(`files hashed: ${files.map((f) => path.relative(root, f)).join(', ')}`);
console.log(`PROTOCOL.md sha256 ${protocol} ${protocol === REGISTERED.protocol ? '(matches the registered hash)' : '(DIFFERS from the registered hash)'}`);
console.log(`scoring code sha256 ${code} ${code === REGISTERED.code ? '(matches the registered hash)' : '(DIFFERS from the registered hash)'}`);
if (protocol !== REGISTERED.protocol || code !== REGISTERED.code) process.exitCode = 1;
