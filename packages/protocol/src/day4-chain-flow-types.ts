import {z} from 'zod';
import type {Address,Hex,Transaction,TransactionReceipt} from 'viem';
import {address,digest,uint} from './schemas.js';
import {AuthorizationPayloadSchema} from '../../capsule/src/format.js';
import {OriginalOrderReadDeploymentSchema} from './original-order-read.js';
import {datasetSchema,reportSchema} from './report.js';
import {OrderSnapshotSchema,type OrderSnapshot} from './escrow-read.js';

const nonzero=address.refine(value=>!/^0x0{40}$/i.test(value));
export const Day4ChainFlowDeploymentSchema=OriginalOrderReadDeploymentSchema.extend({chainId:z.literal('10143'),gate:nonzero}).strict()
  .superRefine((value,context)=>{
    if([value.arbiter,value.asset,value.reviewer,value.executor,...value.committee].some(value=>/^0x0{40}$/i.test(value))
      ||new Set(value.committee.map(value=>value.toLowerCase())).size!==3)
      context.addIssue({code:'custom',message:'NONZERO_UNIQUE_DEPLOYMENT_ROLES_REQUIRED'});
  });
export const Day4ChainFlowRequestSchema=z.object({schemaVersion:z.literal(1),payload:AuthorizationPayloadSchema,dataset:datasetSchema,report:reportSchema,
  transactions:z.object({funding:digest,allocation:digest,withdrawal:digest}).strict()}).strict().superRefine((value,context)=>{
    if(value.payload.intent.chainId!=='10143'||value.payload.intent.price==='0'
      ||new Set(Object.values(value.transactions).map(value=>value.toLowerCase())).size!==3)
      context.addIssue({code:'custom',message:'POSITIVE_PAID_TESTNET_FLOW_WITH_DISTINCT_TRANSACTIONS_REQUIRED'});
  });
export type Day4ChainFlowDeployment=z.infer<typeof Day4ChainFlowDeploymentSchema>;
export type Day4ChainFlowRequest=z.infer<typeof Day4ChainFlowRequestSchema>;
export type Day4ChainTransaction=Pick<Transaction,'hash'|'from'|'to'|'input'|'value'|'blockNumber'|'blockHash'|'transactionIndex'>&{chainId?:number};
export type Day4ChainReceipt=Pick<TransactionReceipt,'transactionHash'|'from'|'to'|'status'|'blockNumber'|'blockHash'|'transactionIndex'|'logs'>;
export interface Day4ChainFlowPort{
  blockTag:'finalized';chainId():Promise<number>;
  block(number?:bigint):Promise<{number:bigint|null;hash:Hex|null;timestamp:bigint}>;
  transaction(hash:Hex):Promise<Day4ChainTransaction|null>;
  receipt(hash:Hex):Promise<Day4ChainReceipt|null>;
  orderAt(orderId:Hex,blockNumber:bigint):Promise<OrderSnapshot>;
  balance(asset:Address,owner:Address,blockNumber:bigint):Promise<bigint>;
}
export const Day4ChainBlockSchema=z.object({number:uint,hash:digest,timestamp:uint}).strict();
const transactionProof=z.object({hash:digest,from:nonzero,to:nonzero,calldataHash:digest,block:Day4ChainBlockSchema,transactionIndex:z.number().int().nonnegative(),
  status:z.literal('success'),amount:uint}).strict();
const balances=z.object({buyer:uint,payee:uint,escrow:uint}).strict();
const balanceObservation=z.object({scope:z.literal('WHOLE_BLOCK_ENDPOINT_BALANCES_NOT_TRANSACTION_LEVEL_DELTAS'),
  before:Day4ChainBlockSchema,after:Day4ChainBlockSchema,beforeBalances:balances,afterBalances:balances,
  wholeBlockNetChange:z.object({buyer:z.string().max(79).regex(/^(?:0|-?[1-9][0-9]*)$/),payee:z.string().max(79).regex(/^(?:0|-?[1-9][0-9]*)$/),escrow:z.string().max(79).regex(/^(?:0|-?[1-9][0-9]*)$/)}).strict()
}).strict();
export const Day4ChainFlowProofSchema=z.object({schemaVersion:z.literal(1),scope:z.literal('FINALIZED_CONFIGURED_ORIGINAL_PAID_CHAIN_FLOW_NOT_OFFICIAL_OR_PROVIDER_PROVENANCE'),
  status:z.literal('CHAIN_FLOW_VERIFIED'),chainId:z.literal('10143'),arbiter:nonzero,asset:nonzero,orderId:digest,contextHash:digest,deliveryEvidenceHash:digest,
  finalizedAnchor:Day4ChainBlockSchema,transactions:z.object({funding:transactionProof,allocation:transactionProof,withdrawal:transactionProof}).strict(),
  balanceObservations:z.object({funding:balanceObservation,withdrawal:balanceObservation}).strict(),finalOrder:OrderSnapshotSchema,
  originalAuthorizationVerified:z.literal(true),reportRecomputed:z.literal(true),canExecute:z.literal(false),signaturesRequested:z.literal(0),transactionsSent:z.literal(0),
  officialIntegrationVerified:z.literal(false),privyOriginVerified:z.literal(false),deploymentCreationVerified:z.literal(false),financialAcceptanceStatus:z.literal('BLOCKED'),limits:z.array(z.string())
}).strict().superRefine((proof,context)=>{
  const equal=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase(),o=proof.finalOrder,t=proof.transactions,a=proof.finalizedAnchor;
  const integers=[o.price,o.bond,...Object.values(t).flatMap(value=>[value.amount,value.block.number,value.block.timestamp]),a.number,a.timestamp,
    ...Object.values(proof.balanceObservations).flatMap(value=>[value.before.number,value.after.number,...Object.values(value.beforeBalances),...Object.values(value.afterBalances)])];
  if(integers.some(value=>!uint.safeParse(value).success))return;
  const invalid=()=>context.addIssue({code:'custom',message:'CHAIN_FLOW_PROOF_BINDING_INVALID'});
  if(o.chainId!==proof.chainId||!equal(o.arbiter,proof.arbiter)||!equal(o.asset,proof.asset)||!equal(o.orderId,proof.orderId)
    ||!equal(o.contextHash,proof.contextHash)||!equal(o.evidenceHash,proof.deliveryEvidenceHash)||o.state!=='ALLOCATED_PAID'
    ||o.block.number!==a.number||!equal(o.block.hash,a.hash)||o.block.timestamp!==a.timestamp
    ||Object.values(t).some(value=>!equal(value.to,proof.arbiter)||BigInt(value.block.number)>BigInt(a.number))
    ||!equal(t.funding.from,t.allocation.from)||!equal(t.withdrawal.from,o.payee)
    ||BigInt(t.funding.amount)!==BigInt(o.price)+BigInt(o.bond)||t.allocation.amount!==o.price
    ||BigInt(t.withdrawal.amount)!==BigInt(o.price)+(equal(o.buyer,o.payee)?BigInt(o.bond):0n)
    ||new Set(Object.values(t).map(value=>value.hash.toLowerCase())).size!==3){invalid();return;}
  const ordered=[t.funding,t.allocation,t.withdrawal];
  if(ordered.some((value,index)=>index>0&&(BigInt(value.block.number)<BigInt(ordered[index-1].block.number)
    ||value.block.number===ordered[index-1].block.number&&value.transactionIndex<=ordered[index-1].transactionIndex))){invalid();return;}
  for(const step of ['funding','withdrawal'] as const){
    const value=proof.balanceObservations[step],after=t[step].block;
    if(value.after.number!==after.number||!equal(value.after.hash,after.hash)||value.after.timestamp!==after.timestamp
      ||BigInt(value.before.number)+1n!==BigInt(after.number)
      ||(['buyer','payee','escrow'] as const).some(role=>!/^[-]?(?:0|[1-9][0-9]*)$/.test(value.wholeBlockNetChange[role])
        ||BigInt(value.wholeBlockNetChange[role])!==BigInt(value.afterBalances[role])-BigInt(value.beforeBalances[role]))
      ||equal(o.buyer,o.payee)&&(value.beforeBalances.buyer!==value.beforeBalances.payee||value.afterBalances.buyer!==value.afterBalances.payee)){invalid();return;}
  }
});
export type Day4ChainFlowProof=z.infer<typeof Day4ChainFlowProofSchema>;
