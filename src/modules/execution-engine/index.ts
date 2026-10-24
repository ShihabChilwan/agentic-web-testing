export { checkoutRef, isCleanStart, startTarget, withTarget, type RestoreResult, type RunningTarget, type StartOptions } from './lifecycle.js';
export { stopProcessGroup, type ServiceProcess } from './processes.js';
export { observeFacts, readFacts, recordFacts } from './facts.js';
export { checkFixtureLogins, type FixtureGuardResult } from './guard.js';
export { describeExecution, executeRun, executeVersion, nextExecId, selectScripts, type ExecuteRunResult } from './execute.js';
export { buildSourceTree, resolveCommit, type SourceTree } from './source-tree.js';
export { observeApp, observePage, pageSnapshot, type AppObservation, type PageObservation, type PageSnapshot } from './probe.js';
