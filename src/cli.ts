import { Command } from 'commander';

// Thin entry point: parses arguments and calls functions exported
// from src/modules/* and src/eval/*. Commands are added as modules are built.

const program = new Command();

program.name('agentic-web-testing').description('Agentic web application testing and fault diagnosis');

program
  .command('agent')
  .description('Pipeline stages: prd, cases, scripts, execute, analyze, all')
  .argument('<stage>')
  .allowUnknownOption()
  .allowExcessArguments()
  .action((stage: string) => {
    console.error(`agent ${stage}: not implemented yet`);
    process.exitCode = 1;
  });

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
