import { Command } from 'commander';
import { describeSummary, generatePrd } from './modules/prd-generator/index.js';
import { describeCasesSummary, generateTestCases } from './modules/test-case-generator/index.js';
import { inspectStage } from './modules/inspect.js';
import { describeExecution, executeRun } from './modules/execution-engine/index.js';
import { analyzeExecution, describeAnalysis } from './modules/failure-analyzer/index.js';
import { describeRunAll, markInterrupted, runAll, type PipelineStage } from './modules/pipeline.js';
import { writeReport } from './modules/report/index.js';
import { createCloudContext, createVariants, importRepeat, runCloudTask } from './eval/index.js';
import { describeScriptsSummary, describeSuspectedDefects, generateScripts, SCRIPT_OUTCOMES } from './modules/script-generator/index.js';
import type { ScriptOutcome } from './modules/script-generator/index.js';
import { errorSummary, readRunManifest, setStage } from './shared/run-manifest.js';
import { runPaths } from './shared/paths.js';
import path from 'node:path';

// Thin entry point: parses arguments and calls functions exported
// from src/modules/* and src/eval/*. Commands are added as modules are built.

const program = new Command();

program.name('agentic-web-testing').description('Agentic web application testing and fault diagnosis');

const agent = program.command('agent').description('Pipeline stages: prd, cases, scripts, execute, analyze, all, report');

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
      for (const line of describeSuspectedDefects(result.suspectedDefects)) console.log(line);
    } catch (err) {
      console.error(`scripts failed: ${errorSummary(err)}`);
      if (controller.signal.aborted) {
        console.error('Finished scripts are in the manifest; run "agent scripts" again to continue.');
        process.exit(130); // sessions still waiting on the model are abandoned
      }
      process.exitCode = 1;
    }
  });

agent
  .command('execute')
  .description('Run the scripts that passed their dry run against one version of the app (data restored before every test)')
  .option('--run <runId>', 'run to use (default: the newest run with a scripts/manifest.json)')
  .option('--ref <ref>', 'version to execute (default: the run\'s generation ref)')
  .option('--patch <file>', 'a unified diff applied on top of the ref, for this execution only (the target repo never changes)')
  .option('--skip-seed', 'start without the seed command and seed requests')
  .option('--exec-id <id>', 'execution id (default: the next x-NN)')
  .action(async (opts: { run?: string; ref?: string; patch?: string; skipSeed?: boolean; execId?: string }) => {
    // Ctrl+C or SIGTERM: stop Playwright and the app, mark the execution failed.
    const controller = new AbortController();
    const onSignal = () => {
      console.error('\nStopping Playwright and the app...');
      controller.abort();
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
      const result = await executeRun({
        ...(opts.run ? { runId: opts.run } : {}),
        ...(opts.ref ? { ref: opts.ref } : {}),
        ...(opts.patch ? { patch: opts.patch } : {}),
        ...(opts.skipSeed ? { skipSeed: true } : {}),
        ...(opts.execId ? { execId: opts.execId } : {}),
        signal: controller.signal,
        log: (m) => console.log(m),
      });
      console.log(`results.json: ${result.resultsFile}`);
      for (const line of describeExecution(result)) console.log(line);
    } catch (err) {
      console.error(`execute failed: ${errorSummary(err)}`);
      process.exitCode = controller.signal.aborted ? 130 : 1;
    }
  });

agent
  .command('analyze')
  .description('Diagnose the failures of one execution (one agent session per group of failures)')
  .option('--run <runId>', 'run to use (default: the newest run with a scripts/manifest.json)')
  .option('--exec <id>', 'execution to analyse (default: the run\'s last finished execution)')
  .option('--no-tools', 'ablation: only the failing tests\' titles and errors, no tools (writes diagnoses.no-tools.json)')
  .action(async (opts: { run?: string; exec?: string; tools: boolean }) => {
    try {
      const result = await analyzeExecution({
        ...(opts.run ? { runId: opts.run } : {}),
        ...(opts.exec ? { execId: opts.exec } : {}),
        noTools: !opts.tools,
        log: (m) => console.log(m),
      });
      console.log(`diagnoses: ${result.file}`);
      for (const line of describeAnalysis(result)) console.log(line);
    } catch (err) {
      console.error(`analyze failed: ${errorSummary(err)}`);
      process.exitCode = 1;
    }
  });

agent
  .command('all')
  .description('prd → cases → scripts → execute → analyze, reusing the stages that are done and still valid')
  .option('--target <name>', 'target for a new run (default: the target of the run being continued)')
  .option('--run <runId>', 'run to continue (default: the newest run of --target, else the newest run)')
  .option('--fresh', 'start a new run and redo every stage')
  .action(async (opts: { target?: string; run?: string; fresh?: boolean }) => {
    // Ctrl+C or SIGTERM: scripts and execute stop themselves; the other stages are marked interrupted here.
    const controller = new AbortController();
    let current: { stage: PipelineStage; at: { runDir: string | null; execId: string | null } } | null = null;
    const onSignal = () => {
      console.error('\nStopping...');
      controller.abort();
      if (current && current.stage !== 'scripts' && current.stage !== 'execute') {
        void markInterrupted(current.stage, current.at).finally(() => process.exit(130));
      }
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
      const result = await runAll({
        ...(opts.target ? { target: opts.target } : {}),
        ...(opts.run ? { runId: opts.run } : {}),
        ...(opts.fresh ? { fresh: true } : {}),
        signal: controller.signal,
        log: (m) => console.log(m),
        onStage: (stage, at) => {
          current = { stage, at };
          console.log(`== ${stage}`);
        },
      });
      for (const line of describeRunAll(result)) console.log(line);
      if (result.failure) process.exitCode = controller.signal.aborted ? 130 : 1;
    } catch (err) {
      console.error(`all failed: ${errorSummary(err)}`);
      process.exitCode = 1;
    }
  });

agent
  .command('report')
  .description('Write runs/<runId>/report.html: one self-contained page (reads files only, no model calls)')
  .option('--run <runId>', 'run to report (default: the newest run)')
  .action(async (opts: { run?: string }) => {
    try {
      const { file, bytes } = await writeReport(opts.run ? { runId: opts.run } : {});
      console.log(`report: ${file} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
    } catch (err) {
      console.error(`report failed: ${errorSummary(err)}`);
      process.exitCode = 1;
    }
  });

const evaluation = program.command('eval').description('Evaluation steps: variants, cloud-context, cloud-task, import (run, ablation, score, summary come later)');

evaluation
  .command('variants')
  .description('Create the code variants (Stryker mutants) and check the environment faults; writes targets/<name>/variants.json')
  .requiredOption('--target <name>', 'target under targets/<name>/')
  .option('--seed <n>', "sampling seed (default: evaluation.json's seed)", (v) => Number.parseInt(v, 10))
  .option('--list-only', 'stop after listing the candidate mutants')
  .option('--env-only', 'only check the environment faults (writes nothing to targets/)')
  .option('--force', 'replace an existing variants.json')
  .action(async (opts: { target: string; seed?: number; listOnly?: boolean; envOnly?: boolean; force?: boolean }) => {
    const controller = new AbortController();
    const onSignal = () => {
      console.error('\nStopping the app...');
      controller.abort();
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
      const result = await createVariants({
        target: opts.target,
        ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
        ...(opts.listOnly ? { listOnly: true } : {}),
        ...(opts.envOnly ? { envOnly: true } : {}),
        ...(opts.force ? { force: true } : {}),
        signal: controller.signal,
        log: (m) => console.log(m),
      });
      console.log(`work folder: ${result.workDir}`);
    } catch (err) {
      console.error(`eval variants failed: ${errorSummary(err)}`);
      process.exitCode = controller.signal.aborted ? 130 : 1;
    }
  });

evaluation
  .command('cloud-context')
  .description('Write build/cloud/: the Docker build folder for the executor image (one target, one run\'s suite)')
  .requiredOption('--target <name>', 'target under targets/<name>/')
  .requiredOption('--run <runId>', 'run whose scripts the image executes')
  .option('--variants <file>', 'variant list relative to targets/<name>/ (default variants.json; e.g. dev-bugs/trial-20261022/variants.json)')
  .action(async (opts: { target: string; run: string; variants?: string }) => {
    try {
      const { outDir, build } = await createCloudContext({
        target: opts.target,
        runId: opts.run,
        ...(opts.variants ? { variantsFile: opts.variants } : {}),
        log: (m) => console.log(m),
      });
      console.log(`build folder: ${outDir}`);
      console.log(`image tag: ${build.imageTag} (${build.versions.length} versions: task index 0 = ${build.versions[0]!.version})`);
    } catch (err) {
      console.error(`eval cloud-context failed: ${errorSummary(err)}`);
      process.exitCode = 1;
    }
  });

evaluation
  .command('cloud-task')
  .description('Inside the executor image: run the version of CLOUD_RUN_TASK_INDEX and save its results')
  .option('--results <dir>', 'results folder (the bucket mount)', '/mnt/results')
  .option('--service-log <file...>', 'service logs to save next to status.json')
  .action(async (opts: { results: string; serviceLog?: string[] }) => {
    try {
      process.exitCode = await runCloudTask({ resultsDir: opts.results, serviceLogs: opts.serviceLog ?? [] });
    } catch (err) {
      console.error(`eval cloud-task failed: ${errorSummary(err)}`);
      process.exitCode = 1;
    }
  });

evaluation
  .command('import')
  .description('Turn one repeat\'s downloaded task results into a new local run (executions with opaque ids)')
  .requiredOption('--from <dir>', 'the repeat\'s folder, e.g. runs/cloud/<repeat-id>')
  .action(async (opts: { from: string }) => {
    try {
      const { runId, mapping } = await importRepeat({ from: path.resolve(opts.from), log: (m) => console.log(m) });
      console.log(`run: ${runId} (${mapping.versions.length} executions; mapping in runs/${runId}/eval/mapping.json)`);
    } catch (err) {
      console.error(`eval import failed: ${errorSummary(err)}`);
      process.exitCode = 1;
    }
  });

await program.parseAsync();
