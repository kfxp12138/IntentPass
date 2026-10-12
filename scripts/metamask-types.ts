import {z} from 'zod';
import {keccak256,toBytes,encodeAbiParameters,getContractAddress,type Address} from 'viem';
import {DeploymentConfigSchema,deploymentDraft} from '../packages/protocol/src/deployment.js';
import {cleanverseBootstrapDraft} from '../packages/protocol/src/cleanverse-bootstrap.js';
const address=z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(v=>BigInt(v)!==0n);
const hash=z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const quantity=z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]*)$/).refine(v=>BigInt(v)<2n**256n);
export const MetaMaskPlanSchema=z.object({planId:hash,sourceCommit:z.string().regex(/^[0-9a-f]{40}$/),chainId:z.literal('10143'),deployer:address,asset:address,gate:address,reviewer:address,committee:z.tuple([address,address,address]),data:z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/).max(98306),initCodeHash:hash}).strict().superRefine((p,c)=>{
  const id=keccak256(toBytes(JSON.stringify([p.chainId,p.deployer.toLowerCase(),p.initCodeHash.toLowerCase()]))),args=encodeAbiParameters([{type:'address'},{type:'address'},{type:'address'},{type:'address[3]'}],[p.asset as Address,p.gate as Address,p.reviewer as Address,p.committee as [Address,Address,Address]]);
  if(p.planId.toLowerCase()!==id||keccak256(p.data as `0x${string}`).toLowerCase()!==p.initCodeHash.toLowerCase()||!p.data.toLowerCase().endsWith(args.slice(2).toLowerCase())||new Set(p.committee.map(v=>v.toLowerCase())).size!==3)c.addIssue({code:'custom',message:'METAMASK_PLAN_MISMATCH'});
});
export type MetaMaskPlan=z.infer<typeof MetaMaskPlanSchema>;
export const MetaMaskGatePlanSchema=z.object({kind:z.literal('CLEANVERSE_GATE'),planId:hash,sourceCommit:z.string().regex(/^[0-9a-f]{40}$/),
  chainId:z.literal('10143'),deployer:address,asset:address,validator:address,policy:address,pool:address,gateNonce:quantity,
  reviewer:address,committee:z.tuple([address,address,address]),escrowInitCodeHash:hash,escrowData:z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/).max(98306),
  data:z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/).max(98306),initCodeHash:hash}).strict().superRefine((plan,context)=>{
  const nonce=BigInt(plan.gateNonce),identity=keccak256(toBytes(JSON.stringify([plan.chainId,plan.deployer.toLowerCase(),plan.initCodeHash.toLowerCase()])));
  if(nonce>=BigInt(Number.MAX_SAFE_INTEGER)){context.addIssue({code:'custom',message:'METAMASK_GATE_NONCE_INVALID'});return;}
  const args=encodeAbiParameters([{type:'address'},{type:'address'},{type:'address'},{type:'address'}],
    [plan.asset as Address,plan.validator as Address,plan.policy as Address,plan.pool as Address]);
  const gate=getContractAddress({from:plan.deployer as Address,nonce}),pool=getContractAddress({from:plan.deployer as Address,nonce:nonce+1n});
  const escrowArgs=encodeAbiParameters([{type:'address'},{type:'address'},{type:'address'},{type:'address[3]'}],
    [plan.asset as Address,gate,plan.reviewer as Address,plan.committee as [Address,Address,Address]]);
  if(plan.planId.toLowerCase()!==identity||keccak256(plan.data as `0x${string}`).toLowerCase()!==plan.initCodeHash.toLowerCase()
    ||keccak256(plan.escrowData as `0x${string}`).toLowerCase()!==plan.escrowInitCodeHash.toLowerCase()||!plan.escrowData.toLowerCase().endsWith(escrowArgs.slice(2).toLowerCase())
    ||!plan.data.toLowerCase().endsWith(args.slice(2).toLowerCase())||pool.toLowerCase()!==plan.pool.toLowerCase()
    ||[plan.deployer,plan.asset,plan.validator,plan.policy,plan.reviewer,...plan.committee].some(value=>[gate,pool].some(future=>future.toLowerCase()===value.toLowerCase()))
    ||new Set(plan.committee.map(value=>value.toLowerCase())).size!==3)context.addIssue({code:'custom',message:'METAMASK_GATE_PLAN_MISMATCH'});
});
export type MetaMaskGatePlan=z.infer<typeof MetaMaskGatePlanSchema>;
export const MetaMaskDemoDependencyPlanSchema=z.object({kind:z.literal('DEMO_DEPENDENCY'),dependency:z.enum(['ASSET','GATE']),planId:hash,sourceCommit:z.string().regex(/^[0-9a-f]{40}$/),chainId:z.literal('10143'),deployer:address,asset:address.nullable(),recipient:address.nullable(),data:z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/).max(98306),initCodeHash:hash}).strict().superRefine((p,c)=>{
  const parameter=p.dependency==='ASSET'?p.recipient:p.asset;
  if(!parameter||p.dependency==='ASSET'&&(p.asset!==null||parameter.toLowerCase()!==p.deployer.toLowerCase())||p.dependency==='GATE'&&p.recipient!==null){c.addIssue({code:'custom',message:'METAMASK_DEMO_PARAMETER_INVALID'});return;}
  const args=encodeAbiParameters([{type:'address'}],[parameter as Address]);
  const identity=keccak256(toBytes(JSON.stringify([p.chainId,p.deployer.toLowerCase(),p.initCodeHash.toLowerCase()])));
  if(p.planId.toLowerCase()!==identity||keccak256(p.data as `0x${string}`).toLowerCase()!==p.initCodeHash.toLowerCase()||!p.data.toLowerCase().endsWith(args.slice(2).toLowerCase()))c.addIssue({code:'custom',message:'METAMASK_DEMO_PLAN_MISMATCH'});
});
export type MetaMaskDemoDependencyPlan=z.infer<typeof MetaMaskDemoDependencyPlanSchema>;
export const MetaMaskWalletPlanSchema=z.union([MetaMaskPlanSchema,MetaMaskGatePlanSchema,MetaMaskDemoDependencyPlanSchema]);
export type MetaMaskWalletPlan=z.infer<typeof MetaMaskWalletPlanSchema>;
export function metamaskGatePlan(input:unknown,gateArtifact:unknown,escrowArtifact:unknown,nonce:bigint,sourceCommit:string):MetaMaskGatePlan{
  const draft=cleanverseBootstrapDraft(input,gateArtifact,escrowArtifact,nonce),identity=[draft.config.chainId,draft.config.deployer.toLowerCase(),draft.gate.initCodeHash.toLowerCase()];
  return MetaMaskGatePlanSchema.parse({kind:'CLEANVERSE_GATE',planId:keccak256(toBytes(JSON.stringify(identity))),sourceCommit,...draft.config,
    pool:draft.escrow.predictedAddress,gateNonce:`0x${nonce.toString(16)}`,escrowInitCodeHash:draft.escrow.initCodeHash,escrowData:draft.escrow.transaction.data,
    data:draft.gate.transaction.data,initCodeHash:draft.gate.initCodeHash});
}
export const MetaMaskPreflightSchema=z.object({planId:hash,checkId:z.string().uuid(),checkedAt:z.iso.datetime(),predictedAddress:address,balance:z.string().regex(/^(0|[1-9][0-9]*)$/),estimatedMaxCost:z.string().regex(/^[1-9][0-9]*$/),transaction:z.object({from:address,chainId:z.literal('0x279f'),data:z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/).max(130000),value:z.literal('0x0'),nonce:quantity,gas:quantity,maxFeePerGas:quantity,maxPriorityFeePerGas:quantity}).strict()}).strict();
export type MetaMaskPreflight=z.infer<typeof MetaMaskPreflightSchema>;
export type MetaMaskAttempt={attemptId:string;planId:string;sourceCommit:string;chainId:'10143';deployer:string;initCodeHash:string;nonce:string;gas:string;maxFeePerGas:string;maxPriorityFeePerGas:string;status:'RESERVED'|'SUBMITTED'|'CONFIRMED'|'REVERTED';transactionHash:string|null;contractAddress:string|null;createdAt:string;updatedAt:string};
export type MetaMaskStatus={scope:'LOCAL_OPERATOR_METAMASK_DEPLOYMENT_HANDOFF';ready:boolean;blockers:string[];plan:MetaMaskPlan|MetaMaskDemoDependencyPlan|null;attempt:MetaMaskAttempt|null;officialIntegrationVerified:false;transactionsSentByServer:0};
export type MetaMaskGateStatus={scope:'LOCAL_OPERATOR_CLEANVERSE_GATE_HANDOFF';ready:boolean;blockers:string[];plan:MetaMaskGatePlan|null;attempt:MetaMaskAttempt|null;officialIntegrationVerified:false;transactionsSentByServer:0};
// The identity includes the fixed bytes and sender, rather than a new source
// commit, so changing documentation cannot create another send opportunity.
export function metamaskPlan(input:unknown,artifact:unknown,sourceCommit:string):MetaMaskPlan{
  const config=DeploymentConfigSchema.parse(input);if(config.chainId!=='10143')throw new Error('METAMASK_TESTNET_REQUIRED');
  const draft=deploymentDraft(config,artifact),identity=[config.chainId,config.deployer.toLowerCase(),draft.initCodeHash.toLowerCase()];
  return MetaMaskPlanSchema.parse({planId:keccak256(toBytes(JSON.stringify(identity))),sourceCommit,chainId:config.chainId,deployer:config.deployer,asset:config.asset,gate:config.gate,reviewer:config.reviewer,committee:config.committee,data:draft.transaction.data,initCodeHash:draft.initCodeHash});
}
export function validateMetaMaskPreflight(plan:MetaMaskWalletPlan,input:unknown):MetaMaskPreflight{
  const checked=MetaMaskPreflightSchema.parse(input),tx=checked.transaction;
  if(checked.planId.toLowerCase()!==plan.planId.toLowerCase()||tx.from.toLowerCase()!==plan.deployer.toLowerCase()||tx.data.toLowerCase()!==plan.data.toLowerCase()||keccak256(tx.data as `0x${string}`).toLowerCase()!==plan.initCodeHash.toLowerCase()||getContractAddress({from:plan.deployer as Address,nonce:BigInt(tx.nonce)}).toLowerCase()!==checked.predictedAddress.toLowerCase())throw new Error('METAMASK_PLAN_MISMATCH');
  if(BigInt(tx.gas)===0n||BigInt(tx.maxFeePerGas)===0n||BigInt(tx.maxPriorityFeePerGas)>BigInt(tx.maxFeePerGas)||BigInt(checked.estimatedMaxCost)!==BigInt(tx.gas)*BigInt(tx.maxFeePerGas)||BigInt(checked.balance)<BigInt(checked.estimatedMaxCost))throw new Error('METAMASK_FEE_OR_BALANCE_INVALID');
  if('kind' in plan&&plan.kind==='CLEANVERSE_GATE'&&(tx.nonce!==plan.gateNonce
    ||getContractAddress({from:plan.deployer as Address,nonce:BigInt(tx.nonce)+1n}).toLowerCase()!==plan.pool.toLowerCase()))throw new Error('METAMASK_GATE_NONCE_OR_POOL_MISMATCH');
  return checked;
}
