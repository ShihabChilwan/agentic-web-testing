import { Command } from 'commander';
import { describeSummary, generatePrd } from './modules/prd-generator/index.js';
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

for (const stage of ['cases', 'scripts', 'execute', 'analyze', 'all']) {
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
