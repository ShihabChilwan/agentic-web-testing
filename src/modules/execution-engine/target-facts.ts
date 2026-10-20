// Records what the golden app answers to the target's fact requests, into targets/<name>/facts.json.
// Usage: npm run target:facts -- <target>
import { parseArgs } from 'node:util';
import { recordFacts } from './facts.js';

const { positionals } = parseArgs({ allowPositionals: true, options: {} });
const name = positionals[0];
if (!name) {
  console.error('Usage: npm run target:facts -- <target>');
  process.exit(1);
}
try {
  const { file, facts } = await recordFacts(name, { log: (m) => console.log(`- ${m}`) });
  for (const f of facts.facts) {
    console.log(`${String(f.status).padEnd(4)} ${f.request.method.padEnd(6)} ${f.request.path}${f.request.as ? `  (as ${f.request.as})` : ''}${f.truncated ? '  [trimmed]' : ''}`);
  }
  console.log(`Wrote ${file}. Review it before committing.`);
} catch (err) {
  console.error(`target:facts failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
