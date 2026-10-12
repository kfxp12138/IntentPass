export {SettlementWorker} from './settlement.js';
export {viemSettlementPort} from './viem-port.js';
// Production startup must verify real wallet policy and sponsor integration evidence.
// No background process is automatically started or unlocked by these exports.

export {FundingWorker} from './funding.js';
export {viemFundingPort} from './funding-port.js';
export {BackgroundProcurement} from './background-procurement.js';
export type {BackgroundActivation,BackgroundPorts} from './background-procurement.js';

export {WorkflowWorker,WorkflowRegistry} from './workflow-worker.js';
export {EncryptedWorkflowVault} from './workflow-vault.js';
