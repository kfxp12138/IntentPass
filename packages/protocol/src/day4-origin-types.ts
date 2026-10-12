import {z} from 'zod';
import {getContractAddress,type Address,type Hex,type Transaction,type TransactionReceipt} from 'viem';
import {address,digest,uint} from './schemas.js';
import {Day4ChainBlockSchema,Day4ChainFlowRequestSchema,Day4ChainFlowProofSchema} from './day4-chain-flow-types.js';
const nonzero=address.refine(value=>!/^0x0{40}$/i.test(value));
export const ProviderIdSchema=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/).refine(value=>!/^apikey_|^sk-/i.test(value),'PROVIDER_ID_REQUIRED');
export const Day4CreationPairConfigSchema=z.object({chainId:z.literal('10143'),deployer:nonzero,asset:nonzero,validator:nonzero,policy:nonzero,
  gate:nonzero,pool:nonzero,reviewer:nonzero,committee:z.tuple([nonzero,nonzero,nonzero]),gateNonce:uint}).strict().superRefine((value,context)=>{
  if(!uint.safeParse(value.gateNonce).success||![value.deployer,value.asset,value.validator,value.policy,value.gate,value.pool,value.reviewer,...value.committee].every(value=>address.safeParse(value).success))return;
  const nonce=BigInt(value.gateNonce);
  if(nonce>BigInt(Number.MAX_SAFE_INTEGER)-1n||new Set(value.committee.map(value=>value.toLowerCase())).size!==3
    ||getContractAddress({from:value.deployer as Address,nonce}).toLowerCase()!==value.gate.toLowerCase()
    ||getContractAddress({from:value.deployer as Address,nonce:nonce+1n}).toLowerCase()!==value.pool.toLowerCase())
    context.addIssue({code:'custom',message:'ORIGINAL_CREATION_PAIR_ADDRESSES_REQUIRED'});
});
export const Day4CreationPairRequestSchema=z.object({schemaVersion:z.literal(1),gateTransaction:digest,escrowTransaction:digest}).strict()
  .refine(value=>value.gateTransaction.toLowerCase()!==value.escrowTransaction.toLowerCase(),'DISTINCT_ORIGINAL_CREATIONS_REQUIRED');
export type Day4CreationPairConfig=z.infer<typeof Day4CreationPairConfigSchema>;
export interface Day4CreationPairPort{
  blockTag:'finalized';chainId():Promise<number>;
  block(number?:bigint):Promise<{number:bigint|null;hash:Hex|null;timestamp:bigint}>;
  transaction(hash:Hex):Promise<(Pick<Transaction,'hash'|'from'|'to'|'input'|'value'|'nonce'|'blockNumber'|'blockHash'|'transactionIndex'>&{chainId?:number})|null>;
  receipt(hash:Hex):Promise<Pick<TransactionReceipt,'transactionHash'|'from'|'to'|'status'|'contractAddress'|'blockNumber'|'blockHash'|'transactionIndex'>|null>;
  code(address:Address,blockNumber:bigint):Promise<Hex|undefined>;
  gateConfiguration(address:Address,blockNumber:bigint):Promise<{asset:string;validator:string;policy:string;pool:string}>;
  escrowConfiguration(address:Address,blockNumber:bigint):Promise<{asset:string;gate:string;reviewer:string;committee:string[];committeeHash:string;allocationPolicy:string;releasePolicy:string;deliverySchema:string}>;
}
const originalCreation=z.object({hash:digest,nonce:uint,address:nonzero,creationBytecodeHash:digest,initCodeHash:digest,runtimeCodeHash:digest,
  receiptBlock:Day4ChainBlockSchema,transactionIndex:z.number().int().nonnegative()}).strict();
export const Day4CreationPairProofSchema=z.object({schemaVersion:z.literal(1),scope:z.literal('FINALIZED_ORIGINAL_GATE_AND_ESCROW_CREATIONS_CONFIGURED_SOURCE_NOT_OFFICIAL_PROVENANCE'),
  status:z.literal('CREATIONS_VERIFIED'),config:Day4CreationPairConfigSchema,finalizedAnchor:Day4ChainBlockSchema,
  gate:originalCreation,escrow:originalCreation,configuredCreationPairVerified:z.literal(true),officialIntegrationVerified:z.literal(false),
  canExecute:z.literal(false),signaturesRequested:z.literal(0),transactionsSent:z.literal(0),financialAcceptanceStatus:z.literal('BLOCKED'),limits:z.array(z.string())}).strict().superRefine((value,context)=>{
  if(![value.config.gateNonce,value.gate.nonce,value.escrow.nonce,value.gate.receiptBlock.number,value.escrow.receiptBlock.number,value.finalizedAnchor.number].every(number=>uint.safeParse(number).success))return;
  const gate=value.gate,escrow=value.escrow;
  if(gate.nonce!==value.config.gateNonce||BigInt(escrow.nonce)!==BigInt(gate.nonce)+1n
    ||gate.address.toLowerCase()!==value.config.gate.toLowerCase()||escrow.address.toLowerCase()!==value.config.pool.toLowerCase()
    ||gate.hash.toLowerCase()===escrow.hash.toLowerCase()||BigInt(gate.receiptBlock.number)>BigInt(escrow.receiptBlock.number)
    ||BigInt(escrow.receiptBlock.number)>BigInt(value.finalizedAnchor.number)
    ||gate.receiptBlock.number===escrow.receiptBlock.number&&gate.transactionIndex>=escrow.transactionIndex)
    context.addIssue({code:'custom',message:'CREATION_PAIR_PROOF_BINDING_INVALID'});
});
export type Day4CreationPairProof=z.infer<typeof Day4CreationPairProofSchema>;

export const PrivyOriginConfigSchema=z.object({chainId:z.literal('10143'),arbiter:nonzero,address:nonzero,walletId:ProviderIdSchema,
  policyId:ProviderIdSchema,signerId:ProviderIdSchema}).strict();
const originalProviderTransaction=z.object({recordId:ProviderIdSchema,hash:digest}).strict();
export const PrivyOriginRequestSchema=z.object({schemaVersion:z.literal(1),transactions:z.object({funding:originalProviderTransaction,allocation:originalProviderTransaction}).strict()}).strict()
  .refine(value=>value.transactions.funding.recordId!==value.transactions.allocation.recordId
    &&value.transactions.funding.hash.toLowerCase()!==value.transactions.allocation.hash.toLowerCase(),'DISTINCT_ORIGINAL_PROVIDER_RECORDS_REQUIRED');
export type PrivyOriginConfig=z.infer<typeof PrivyOriginConfigSchema>;
export type PrivyOriginRequest=z.infer<typeof PrivyOriginRequestSchema>;
export interface PrivyOriginPort{
  transaction(id:string):Promise<unknown>;
  wallet(id:string):Promise<unknown>;
  policy(id:string):Promise<unknown>;
}
const providerRecord=z.object({id:ProviderIdSchema,caip2:z.literal('eip155:10143'),createdAt:z.number().int().positive().safe(),
  status:z.literal('finalized'),hash:digest,walletId:ProviderIdSchema}).strict();
export const PrivyOriginProofSchema=z.object({schemaVersion:z.literal(1),scope:z.literal('LIVE_PRIVY_ORIGINAL_RECORD_ASSOCIATIONS_AND_CURRENT_POLICY_NOT_HISTORICAL_POLICY_AT_SEND'),
  status:z.literal('PROVIDER_RECORDS_VERIFIED'),chainId:z.literal('10143'),executor:nonzero,arbiter:nonzero,walletId:ProviderIdSchema,policyId:ProviderIdSchema,
  observedAtUnixMs:z.number().int().positive().safe(),providerTimestampUnitVerified:z.literal(false),
  signerId:ProviderIdSchema,signerRole:z.enum(['OWNER','DELEGATED']),policyRulesHash:digest,records:z.object({funding:providerRecord,allocation:providerRecord}).strict(),
  providerTransactionRecordsVerified:z.literal(true),currentWalletPolicyVerified:z.literal(true),historicalPolicyAtSendVerified:z.literal(false),
  withdrawalProviderOriginVerified:z.literal(false),canExecute:z.literal(false),signaturesRequested:z.literal(0),transactionsSent:z.literal(0),
  financialAcceptanceStatus:z.literal('BLOCKED'),limits:z.array(z.string())}).strict().superRefine((value,context)=>{
  if(Object.values(value.records).some(record=>record.walletId!==value.walletId)||value.records.funding.id===value.records.allocation.id
    ||value.records.funding.hash.toLowerCase()===value.records.allocation.hash.toLowerCase())context.addIssue({code:'custom',message:'PROVIDER_RECORD_BINDING_INVALID'});
});
export type PrivyOriginProof=z.infer<typeof PrivyOriginProofSchema>;
export const Day4OriginsRequestSchema=z.object({schemaVersion:z.literal(1),flow:Day4ChainFlowRequestSchema,
  creations:Day4CreationPairRequestSchema,privy:PrivyOriginRequestSchema}).strict().superRefine((value,context)=>{
  for(const step of ['funding','allocation'] as const)if(value.flow.transactions[step].toLowerCase()!==value.privy.transactions[step].hash.toLowerCase())
    context.addIssue({code:'custom',message:'SAME_ORIGINAL_FLOW_PROVIDER_HASHES_REQUIRED'});
  if(new Set([...Object.values(value.flow.transactions),value.creations.gateTransaction,value.creations.escrowTransaction].map(hash=>hash.toLowerCase())).size!==5)
    context.addIssue({code:'custom',message:'DISTINCT_ORIGINAL_FLOW_AND_CREATION_HASHES_REQUIRED'});
});
export const Day4OriginsProofSchema=z.object({schemaVersion:z.literal(1),scope:z.literal('FINALIZED_ORIGINAL_FLOW_CREATIONS_AND_LIVE_PRIVY_ASSOCIATIONS_NOT_FULL_D4_ACCEPTANCE'),
  status:z.literal('ORIGINS_VERIFIED'),chainId:z.literal('10143'),orderId:digest,contextHash:digest,
  flow:Day4ChainFlowProofSchema,creations:Day4CreationPairProofSchema,privy:PrivyOriginProofSchema,
  deploymentCreationVerified:z.literal(true),providerTransactionRecordsVerified:z.literal(true),currentWalletPolicyVerified:z.literal(true),
  officialIntegrationVerified:z.literal(false),historicalPolicyAtSendVerified:z.literal(false),withdrawalProviderOriginVerified:z.literal(false),
  financialAcceptanceStatus:z.literal('BLOCKED'),canExecute:z.literal(false),signaturesRequested:z.literal(0),transactionsSent:z.literal(0),limits:z.array(z.string())}).strict().superRefine((value,context)=>{
  const f=value.flow,c=value.creations,p=value.privy,equal=(left:string,right:string)=>left.toLowerCase()===right.toLowerCase();
  const funding=f.transactions.funding.block,escrow=c.escrow.receiptBlock;
  if(![funding.number,escrow.number].every(number=>uint.safeParse(number).success))return;
  if(!equal(value.orderId,f.orderId)||!equal(value.contextHash,f.contextHash)||!equal(c.config.pool,f.arbiter)||!equal(c.config.asset,f.asset)
    ||!equal(p.arbiter,f.arbiter)||!equal(p.executor,f.transactions.funding.from)||!equal(p.executor,f.transactions.allocation.from)
    ||f.finalizedAnchor.number!==c.finalizedAnchor.number||!equal(f.finalizedAnchor.hash,c.finalizedAnchor.hash)||f.finalizedAnchor.timestamp!==c.finalizedAnchor.timestamp
    ||(['funding','allocation'] as const).some(step=>!equal(p.records[step].hash,f.transactions[step].hash))
    ||BigInt(escrow.number)>BigInt(funding.number)||escrow.number===funding.number&&c.escrow.transactionIndex>=f.transactions.funding.transactionIndex)
    context.addIssue({code:'custom',message:'ORIGINAL_FLOW_CREATION_PROVIDER_BINDING_INVALID'});
});
export type Day4OriginsProof=z.infer<typeof Day4OriginsProofSchema>;
