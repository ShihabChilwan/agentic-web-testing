import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Variants } from '../src/shared/schemas.js';
import { aggregate } from './src/aggregate.js';
import { loadSuite } from './src/load.js';
import { renderMarkdown } from './src/report.js';
import { scoreSuite } from './src/score.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** SHA-256 of PROTOCOL.md and of the scoring code (every .ts file outside tests and out, sorted by path). */
export async function hashes(root = here): Promise<{ protocol: string; code: string }> {
  const protocol = sha256(await readFile(path.join(root, 'PROTOCOL.md')));
  const files: string[] = [];
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!['tests', 'out', 'node_modules'].includes(e.name)) await walk(p);
      } else if (e.name.endsWith('.ts')) files.push(p);
    }
  };
  await walk(root);
  const parts: string[] = [];
  for (const f of files.sort()) parts.push(`${path.relative(root, f)}\n${sha256(await readFile(f))}`);
  return { protocol, code: sha256(parts.join('\n')) };
}

export interface ScoringOptions {
  suites: string[];
  variantsFile: string;
  equivalentsFile: string;
  out: string;
  /** Score only these kinds (the development repeat has code variants only). Default: all. */
  kinds?: Array<'code' | 'environment'>;
}

/** Scores the suites (imported run folders) against the variant list; writes scores.json and scores.md into `out`. */
export async function runScoring(options: ScoringOptions, root = here) {
  const all = Variants.parse(JSON.parse(await readFile(options.variantsFile, 'utf8')));
  const variants = options.kinds ? { ...all, variants: all.variants.filter((v) => options.kinds!.includes(v.kind)) } : all;
  const equivalents = (JSON.parse(await readFile(options.equivalentsFile, 'utf8')) as { equivalents: Array<string | { id: string }> }).equivalents.map((e) => (typeof e === 'string' ? e : e.id));
  const scores = [];
  for (const dir of options.suites) scores.push(scoreSuite(await loadSuite(path.resolve(dir)), variants, equivalents));
  const aggregated = aggregate(scores, equivalents);
  const out = path.resolve(options.out);
  await mkdir(out, { recursive: true });
  const h = await hashes(root);
  const markdown = renderMarkdown(aggregated, h.protocol);
  await writeFile(path.join(out, 'scores.json'), `${JSON.stringify({ protocolSha256: h.protocol, codeSha256: h.code, suites: scores, aggregate: aggregated }, null, 2)}\n`, 'utf8');
  await writeFile(path.join(out, 'scores.md'), markdown, 'utf8');
  return { scores, aggregated, markdown, protocolSha256: h.protocol };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      suite: { type: 'string', multiple: true },
      variants: { type: 'string' },
      equivalents: { type: 'string', default: path.join(here, 'equivalents.json') },
      out: { type: 'string', default: path.join(here, 'out') },
      kind: { type: 'string', multiple: true },
    },
  });
  if (positionals[0] === 'hash') {
    const h = await hashes();
    console.log(`PROTOCOL.md sha256 ${h.protocol}\nscoring code sha256 ${h.code}`);
    return;
  }
  if (!values.suite?.length || !values.variants) {
    console.error('usage: npx tsx scoring/cli.ts --suite <imported run folder> [--suite ...] --variants <variants.json> [--equivalents <file>] [--out <dir>] [--kind code|environment]\n       npx tsx scoring/cli.ts hash');
    process.exitCode = 1;
    return;
  }
  const result = await runScoring({ suites: values.suite, variantsFile: values.variants, equivalentsFile: values.equivalents!, out: values.out!, ...(values.kind?.length ? { kinds: values.kind as Array<'code' | 'environment'> } : {}) });
  console.log(result.markdown);
  console.log(`written: ${path.join(path.resolve(values.out!), 'scores.json')} and scores.md`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`score failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
