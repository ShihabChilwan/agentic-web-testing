import { Command } from 'commander';
import { describeSummary, generatePrd } from './modules/prd-generator/index.js';
import { describeCasesSummary, generateTestCases } from './modules/test-case-generator/index.js';
import { inspectStage } from './modules/inspect.js';
import { describeScriptsSummary, generateScripts, SCRIPT_OUTCOMES } from './modules/script-generator/index.js';
import type { ScriptOutcome } from './modules/script-generator/index.js';
import { errorSummary, readRunManifest, setStage } from './shared/run-manifest.js';
import { runPaths } from './shared/paths.js';
import path from 'node:path';

// Thin entry point: parses arguments and calls functions exported
// from src/modules/* and src/eval/*. Commands are added as modules are built.

const program = new Command();

program.name('agentic-web-testing').description('Agentic web application testing and fault diagnosis');

const agent = program.command('agent').description('Pipeline stages: prd, cases, scripts, execute, analyze, all');

agent
  .command('prd')
  .description('Create a run and generate prd.json from the target source')
  .requiredOption('--target <name>', 'target under targets/<name>/')
  .option('--ref <ref>', 'generation ref (default: the target goldenRef)')
  .option('--max-explore-calls <n>', 'runaway ceiling for exploring tool calls (default 200)', (v) => Number.parseInt(v, 10))
  .action(async (opts: { target: string; ref?: string; maxExploreCalls?: number }) => {
    let runDir: string | undefined;
    process.once('SIGINT', () => {
      const done = runDir
        ? setStage(runDir, 'prd', { status: 'failed', finishedAt: new Date().toISOString(), error: 'Interrupted' })
        : Promise.resolve();
      void done.finally(() => process.exit(130));
    });
    try {
      const result = await generatePrd({
        target: opts.target,
        ...(opts.ref ? { ref: opts.ref } : {}),
        ...(opts.maxExploreCalls ? { maxExploreCalls: opts.maxExploreCalls } : {}),
        onRunCreated: (dir) => (runDir = dir),
        log: (m) => console.log(m),
      });
      const { prd } = result;
      console.log(`prd.json: ${result.prdFile}`);
      console.log(
        `${prd.features.length} features, ${prd.apiEndpoints.length} endpoints, ${prd.uiRoutes.length} UI routes, ${prd.requirements.length} requirements; ${Math.round(result.agent.durationMs / 1000)} s`,
      );
      for (const line of describeSummary(result.summary)) console.log(line);
    } catch (err) {
      console.error(`prd failed: ${errorSummary(err)}`);
      if (runDir) {
        const summary = (await readRunManifest(runPaths(path.basename(runDir), path.dirname(runDir)).runJson)).stages.prd?.agent;
        if (summary) for (const line of describeSummary(summary)) console.error(line);
        console.error(`Run folder: ${runDir}`);
      }
      process.exitCode = 1;
    }
  });

agent
  .command('cases')
  .description('Generate testcases.json from the run\'s prd.json')
  .option('--run <runId>', 'run to use (default: the newest run with a prd.json)')
  .action(async (opts: { run?: string }) => {
    try {
      const result = await generateTestCases({ ...(opts.run ? { runId: opts.run } : {}), log: (m) => console.log(m) });
      console.log(`testcases.json: ${result.file}`);
      for (const line of describeCasesSummary(result)) console.log(line);
    } catch (err) {
      console.error(`cases failed: ${errorSummary(err)}`);
      process.exitCode = 1;
    }
  });

agent
  .command('inspect')
  .description('List a stage\'s sessions with their rejected submits and tool calls (read-only)')
  .requiredOption('--stage <stage>', 'prd or cases')
  .option('--run <runId>', 'run to inspect (default: the newest run with transcripts for the stage)')
  .option('--session <n>', 'show one session in full, with the model\'s reasoning', (v) => Number.parseInt(v, 10))
  .option('--all', 'also list sessions from earlier runs of the stage')
  .action(async (opts: { stage: string; run?: string; session?: number; all?: boolean }) => {
    if (opts.stage !== 'prd' && opts.stage !== 'cases') {
      console.error('--stage must be prd or cases');
      process.exitCode = 1;
      return;
    }
    try {
      const lines = await inspectStage({
        stage: opts.stage,
        ...(opts.run ? { runId: opts.run } : {}),
        ...(opts.session !== undefined ? { session: opts.session } : {}),
        ...(opts.all ? { all: true } : {}),
      });
      for (const line of lines) console.log(line);
    } catch (err) {
      console.error(`inspect failed: ${errorSummary(err)}`);
      process.exitCode = 1;
    }
  });

agent
  .command('scripts')
  .description('Generate and dry-run a Playwright script per test case (starts the app at the generation ref)')
  .option('--run <runId>', 'run to use (default: the newest run with a testcases.json)')
  .option('--fresh', 'generate every script again, instead of keeping validated ones from an unfinished run')
  .option('--redo <outcomes>', `generate again only these outcomes, keep the rest (comma-separated: ${SCRIPT_OUTCOMES.join(', ')})`)
  .action(async (opts: { run?: string; fresh?: boolean; redo?: string }) => {
    const redo = opts.redo?.split(',').map((o) => o.trim()).filter(Boolean);
    const unknown = redo?.filter((o) => !(SCRIPT_OUTCOMES as readonly string[]).includes(o)) ?? [];
    if (unknown.length > 0) {
      console.error(`--redo: unknown outcome ${unknown.join(', ')}; use ${SCRIPT_OUTCOMES.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    // Ctrl+C or SIGTERM: write the manifest so far, mark the stage failed and stop the app before exiting.
    const controller = new AbortController();
    const onSignal = () => {
      console.error('\nStopping: saving the finished scripts and stopping the app...');
      controller.abort();
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
      const result = await generateScripts({
        ...(opts.run ? { runId: opts.run } : {}),
        ...(opts.fresh ? { fresh: true } : {}),
        ...(redo ? { redo: redo as ScriptOutcome[] } : {}),
        signal: controller.signal,
        log: (m) => console.log(m),
      });
      console.log(`manifest: ${result.manifestFile}`);
      for (const line of describeScriptsSummary(result.summary)) console.log(line);
    } catch (err) {
      console.error(`scripts failed: ${errorSummary(err)}`);
      if (controller.signal.aborted) {
        console.error('Finished scripts are in the manifest; run "agent scripts" again to continue.');
        process.exit(130); // sessions still waiting on the model are abandoned
      }
      process.exitCode = 1;
    }
  });

for (const stage of ['execute', 'analyze', 'all']) {
  agent
    .command(stage)
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      console.error(`agent ${stage}: not implemented yet`);
      process.exitCode = 1;
    });
}

program
  .command('eval')
  .description('Evaluation steps: variants, run, ablation, score, summary')
  .argument('<step>')
  .allowUnknownOption()
  .allowExcessArguments()
  .action((step: string) => {
    console.error(`eval ${step}: not implemented yet`);
    process.exitCode = 1;
  });

await program.parseAsync();
