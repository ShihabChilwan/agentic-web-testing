// Runs the Execution Engine lifecycle by hand: start the target, print the result, stop it.
// Usage: npm run target:up -- <target> [--ref <ref>] [--hold]
//   --hold keeps the app running and prints memory use every 30 s until Ctrl+C.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify, parseArgs } from 'node:util';
import { RUNS_DIR, makeRunId } from '../../shared/paths.js';
import { loadTargetConfig } from '../../shared/target-config.js';
import { startTarget, type RunningTarget } from './lifecycle.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { ref: { type: 'string' }, hold: { type: 'boolean', default: false } },
});
const name = positionals[0];
if (!name) {
  console.error('Usage: npm run target:up -- <target> [--ref <ref>] [--hold]');
  process.exit(1);
}

const { config, repoDir, targetDir } = await loadTargetConfig(name);
const ref = values.ref ?? config.goldenRef;
const logsDir = path.join(RUNS_DIR, `lifecycle-${makeRunId(name)}`, 'server');

// Ctrl+C during start-up aborts the current step; while holding, it ends the hold. Both lead to a clean stop.
const controller = new AbortController();
let releaseHold = () => {};
const onSignal = () => {
  console.log('\nStopping...');
  controller.abort();
  releaseHold();
};
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

const mb = (kb: number) => `${Math.round(kb / 1024)} MB`;

async function memoryLine(target: RunningTarget): Promise<string> {
  const { stdout } = await promisify(execFile)('ps', ['-eo', 'pgid=,rss=']);
  const rssByGroup = new Map<number, number>();
  for (const line of stdout.trim().split('\n')) {
    const [pgid, rss] = line.trim().split(/\s+/).map(Number);
    if (pgid !== undefined && rss !== undefined) rssByGroup.set(pgid, (rssByGroup.get(pgid) ?? 0) + rss);
  }
  const meminfo = await readFile('/proc/meminfo', 'utf8');
  const available = Number(/MemAvailable:\s+(\d+)/.exec(meminfo)?.[1] ?? 0);
  const groups = target.services.map((s) => `${s.name} ${mb(rssByGroup.get(s.pid) ?? 0)}`);
  return `[memory] ${groups.join(' · ')} · available ${mb(available)}`;
}

let target: RunningTarget | undefined;
try {
  console.log(`Target ${name}, ref ${ref}. Logs: ${logsDir}`);
  target = await startTarget(config, {
    ref,
    repoDir,
    targetDir,
    logsDir,
    signal: controller.signal,
    log: (message) => console.log(`- ${message}`),
  });

  console.log(`\nCommit ${target.commit}`);
  for (const check of target.healthChecks) {
    console.log(`health  ${check.ok ? 'ok  ' : 'FAIL'}  ${check.name.padEnd(9)} ${check.url}  (${check.elapsedMs} ms)`);
  }
  for (const seed of target.seed) {
    console.log(`seed    ${seed.ok ? 'ok  ' : 'FAIL'}  ${String(seed.status ?? 'no response').padEnd(9)} ${seed.request}`);
  }
  if (target.seedCheck) {
    const { ok, status, detail } = target.seedCheck;
    console.log(`check   ${ok ? 'ok  ' : 'FAIL'}  ${String(status ?? 'no response').padEnd(9)} seed check: ${detail}`);
  }
  const allOk =
    target.healthChecks.every((c) => c.ok) && target.seed.every((s) => s.ok) && target.seedCheck?.ok !== false;
  if (!allOk) process.exitCode = 1;

  if (values.hold && !controller.signal.aborted) {
    console.log(`\nApp is up: ${config.frontend ? `${config.frontend.baseUrl} and ${config.backend.baseUrl}` : config.backend.baseUrl}. Press Ctrl+C to stop.`);
    const running = target;
    const print = () => memoryLine(running).then(console.log, () => {});
    await print();
    const timer = setInterval(print, 30_000);
    await new Promise<void>((resolve) => (releaseHold = resolve));
    clearInterval(timer);
  }
} catch (err) {
  console.error(`\nFailed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (target) {
    await target.stop();
  }
  console.log('Target stopped.');
}
