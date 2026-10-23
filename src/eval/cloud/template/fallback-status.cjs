// Writes <results>/<repeat>/<version>/status.json for a task that stopped before writing its own: the target's
// services did not start, or `eval cloud-task` crashed (e.g. a missing package while modules were loading).
// Plain Node with no packages, so it still works when the framework cannot load. Run by entrypoint.sh (SPEC §11.7).
// Usage: node image/fallback-status.cjs <resultsDir> <startedAt> <exitCode> <message> [serviceLog...]
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const [resultsDir, startedAt, exitCode, message, ...serviceLogs] = process.argv.slice(2);
const env = process.env;

function number(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return /^\d+$/.test(text) ? Number(text) : null;
  } catch {
    return null;
  }
}

const build = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'image', 'build.json'), 'utf8'));
const index = /^\d+$/.test(env.CLOUD_RUN_TASK_INDEX || '') ? Number(env.CLOUD_RUN_TASK_INDEX) : NaN;
const version = build.versions[index];
const repeatId = env.CLOUD_RUN_EXECUTION || '';
if (!version || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(repeatId)) {
  console.error(`fallback-status: no version for CLOUD_RUN_TASK_INDEX=${env.CLOUD_RUN_TASK_INDEX} / CLOUD_RUN_EXECUTION=${repeatId}; nothing written`);
  process.exit(0);
}
const outDir = path.join(resultsDir, repeatId, version.version);
if (fs.existsSync(path.join(outDir, 'status.json'))) process.exit(0); // the task wrote its own
fs.mkdirSync(outDir, { recursive: true });
for (const file of serviceLogs) {
  try {
    fs.copyFileSync(file, path.join(outDir, path.basename(file)));
  } catch {
    // a service that never started has no log
  }
}

const cgroup = env.CGROUP_DIR || '/sys/fs/cgroup';
let oomKills = null;
try {
  const m = /^oom_kill (\d+)$/m.exec(fs.readFileSync(path.join(cgroup, 'memory.events'), 'utf8'));
  oomKills = m ? Number(m[1]) : null;
} catch {
  // not readable here
}
const finished = new Date();
const started = new Date(startedAt);
const status = {
  schemaVersion: '1.0',
  repeatId,
  taskIndex: index,
  version: version.version,
  execId: null,
  imageTag: build.imageTag,
  sourceRunId: build.sourceRunId,
  suiteHash: build.suiteHash,
  startedAt: started.toISOString(),
  finishedAt: finished.toISOString(),
  durationMs: Math.max(0, finished.getTime() - started.getTime()),
  outcome: 'failed',
  error: `${message} (exit code ${exitCode})`,
  execution: {
    ref: build.generationRef,
    ...(version.patch ? { patch: version.patch } : {}),
    ...(version.configOverride ? { configOverride: version.configOverride } : {}),
    ...(version.skipSeed ? { skipSeed: true } : {}),
  },
  memory: { peakBytes: number(path.join(cgroup, 'memory.peak')), limitBytes: number(path.join(cgroup, 'memory.max')), oomKills },
};
fs.writeFileSync(path.join(outDir, 'status.json'), `${JSON.stringify(status, null, 2)}\n`);
console.error(`fallback-status: wrote ${path.join(outDir, 'status.json')}: ${status.error}`);
