// One-off: eval import of the Kutt repeat with the every-line leak check (scratch copy of src/eval/cloud/import.ts,
// identical except the leak module); same freeze guard as the CLI.
import path from 'node:path';
import { requireFrozen } from '/workspaces/agentic-web-testing/src/shared/freeze.js';
import { importRepeat } from './import.mjs';
const frozen = await requireFrozen({ tag: 'scenarios-v1', log: (m) => console.log(m) });
const { runId, mapping } = await importRepeat({ from: path.resolve(process.argv[2]!), ...(frozen ? { frozenCommit: frozen.commit } : {}), log: (m) => console.log(m) });
console.log(`run: ${runId} (${mapping.versions.length} executions)`);
