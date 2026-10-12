import {z} from 'zod';
import {encodeFunctionData,encodeFunctionResult,keccak256,toHex,type Hex} from 'viem';
import {address,digest} from './schemas.js';
import {Day4ChainBlockSchema} from './day4-chain-flow-types.js';
import {ProviderIdSchema,Day4OriginsProofSchema,type PrivyOriginPort} from './day4-origin-types.js';
import {escrowAbi} from './escrow-abi.js';
import {OrderSnapshotSchema,orderStates} from './escrow-read.js';

export const day4PolicyProbeGas=5_000_000n;
const nonzero=address.refine(value=>!/^0x0{40}$/i.test(value));
/** This is derived from independently inspected original records, never an
 * arbitrary transaction accepted from a browser or private evidence file. */
export const Day4PolicyProbeCallSchema=z.object({chainId:z.literal('10143'),walletId:ProviderIdSchema,
  policyId:ProviderIdSchema,signerId:ProviderIdSchema,executor:nonzero,arbiter:nonzero,orderId:digest,contextHash:digest,
  block:Day4ChainBlockSchema,data:z.string().regex(/^0x[0-9a-fA-F]{72}$/),value:z.literal('0'),gas:z.literal('5000000'),
}).strict().superRefine((value,context)=>{
  if(!digest.safeParse(value.orderId).success)return;
  const expected=encodeFunctionData({abi:escrowAbi,functionName:'orders',args:[value.orderId as Hex]});
  if(value.data.toLowerCase()!==expected.toLowerCase())context.addIssue({code:'custom',message:'FIXED_ORIGINAL_ORDER_VIEW_REQUIRED'});
});
export type Day4PolicyProbeCall=z.infer<typeof Day4PolicyProbeCallSchema>;
export function day4PolicyProbeOrderResult(input:unknown):Hex{
  const o=OrderSnapshotSchema.parse(input);
  return encodeFunctionResult({abi:escrowAbi,functionName:'orders',result:[o.contextHash as Hex,o.buyer as Hex,o.seller as Hex,o.payee as Hex,
    BigInt(o.price),BigInt(o.bond),BigInt(o.deliveryDeadline),BigInt(o.settlementDeadline),o.datasetHash as Hex,o.serviceTermsHash as Hex,
    o.evidenceHash as Hex,o.voteMask,orderStates.indexOf(o.state)]});
}
/** A changed policy, signer, gas, source or height cannot unlock this same
 * wallet/order again in the configured durable journal. */
export function day4PolicyProbeKey(input:Day4PolicyProbeCall):Hex{
  const call=Day4PolicyProbeCallSchema.parse(input);
  return keccak256(toHex(JSON.stringify(['intentpass-d4-policy-probe-v1',call.chainId,call.walletId,
    call.arbiter.toLowerCase(),call.orderId.toLowerCase()])));
}
export const Day4PolicyProbeAttemptSchema=z.object({key:digest,attemptId:z.uuid(),call:Day4PolicyProbeCallSchema,
  createdAt:z.iso.datetime(),updatedAt:z.iso.datetime(),status:z.enum(['RESERVED','HTTP_CAPTURED','OUTCOME_UNKNOWN','UNEXPECTED_BROADCAST']),
  httpStatus:z.number().int().min(100).max(599).nullable(),rawResponseStored:z.boolean(),transactionHash:digest.nullable(),transactionHashStored:z.boolean(),
}).strict().superRefine((value,context)=>{
  if(!Day4PolicyProbeCallSchema.safeParse(value.call).success)return;
  if(value.key.toLowerCase()!==day4PolicyProbeKey(value.call).toLowerCase()||Date.parse(value.updatedAt)<Date.parse(value.createdAt)
    ||value.rawResponseStored&&value.httpStatus===null
    ||value.transactionHashStored&&value.transactionHash===null
    ||value.status==='RESERVED'&&(value.httpStatus!==null||value.rawResponseStored||value.transactionHash!==null||value.transactionHashStored)
    ||value.status==='HTTP_CAPTURED'&&(!value.rawResponseStored||value.transactionHash!==null)
    ||value.status==='UNEXPECTED_BROADCAST'&&value.transactionHash===null
    ||value.status!=='UNEXPECTED_BROADCAST'&&value.transactionHash!==null)
    context.addIssue({code:'custom',message:'POLICY_PROBE_ATTEMPT_BINDING_INVALID'});
});
export type Day4PolicyProbeAttempt=z.infer<typeof Day4PolicyProbeAttemptSchema>;
export interface Day4PolicyProbeJournal{
  get(key:string):Day4PolicyProbeAttempt|null;
  reserve(call:Day4PolicyProbeCall):Day4PolicyProbeAttempt;
  /** Original bounded HTTP bytes/response headers are private, never returned
   * by get(). No request headers, authorization signatures or key are stored. */
  recordResponse(key:string,attemptId:string,status:number,body:Uint8Array,headers:readonly (readonly [string,string])[]):Day4PolicyProbeAttempt;
  markUnknown(key:string,attemptId:string):Day4PolicyProbeAttempt;
  recordUnexpectedHash(key:string,attemptId:string,hash:string):Day4PolicyProbeAttempt;
}
export interface Day4PolicyProbeProvider{
  origins:PrivyOriginPort;
  /** Independent counters remain available when a later check or journal write
   * fails; a possible forwarded send is never reported as zero transactions. */
  /** priorAttempt also covers unavailable history: an original send cannot be
   * ruled out. walletRpcAttempts counts only this adapter instance. */
  snapshot():{attempt:Day4PolicyProbeAttempt|null;walletRpcAttempts:0|1;priorAttempt:boolean};
  /** The dedicated adapter reserves permanently before generating its SDK
   * authorization request; it permits at most one forwarded fixed wallet POST. */
  capture(call:Day4PolicyProbeCall):Promise<{attempt:Day4PolicyProbeAttempt;walletRpcAttempts:0|1}>;
}
export const Day4PolicyProbeProofSchema=z.object({schemaVersion:z.literal(1),
  scope:z.literal('FIXED_ORIGINAL_ORDER_VIEW_AND_SINGLE_PRIVY_RESPONSE_CAPTURE_NOT_CONFIRMED_POLICY_DENIAL'),
  status:z.enum(['READY','CAPTURED_UNCLASSIFIED','OUTCOME_UNKNOWN','UNEXPECTED_BROADCAST']),
  origins:Day4OriginsProofSchema,call:Day4PolicyProbeCallSchema,simulationReturnHash:digest,
  originalOrderViewVerified:z.literal(true),currentWalletPolicyStable:z.literal(true),snapshotVerified:z.literal(true),
  attempt:Day4PolicyProbeAttemptSchema.nullable(),walletRpcAttempts:z.union([z.literal(0),z.literal(1)]),
  broadcastOutcome:z.enum(['NOT_ATTEMPTED','UNKNOWN','HASH_OBSERVED']),transactionsSent:z.literal(0).nullable(),
  policyDenialVerified:z.literal(false),serverRequestId:z.null(),historicalPolicyAtSendVerified:z.literal(false),
  officialIntegrationVerified:z.literal(false),financialAcceptanceStatus:z.literal('BLOCKED'),canPassD4:z.literal(false),
  canExecute:z.literal(false),limits:z.array(z.string()),
}).strict().superRefine((value,context)=>{
  const equal=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase(),f=value.origins.flow,p=value.origins.privy,c=value.call;
  if(!Day4PolicyProbeCallSchema.safeParse(c).success||value.attempt&&!Day4PolicyProbeAttemptSchema.safeParse(value.attempt).success)return;
  if(!equal(c.executor,p.executor)||!equal(c.arbiter,f.arbiter)||!equal(c.orderId,f.orderId)||!equal(c.contextHash,f.contextHash)
    ||c.walletId!==p.walletId||c.policyId!==p.policyId||c.signerId!==p.signerId
    ||JSON.stringify(c.block)!==JSON.stringify(f.finalizedAnchor)
    ||value.simulationReturnHash.toLowerCase()!==keccak256(day4PolicyProbeOrderResult(f.finalOrder)).toLowerCase()
    ||value.attempt&&JSON.stringify(value.attempt.call)!==JSON.stringify(c)
    ||value.status==='READY'&&(value.attempt!==null||value.walletRpcAttempts!==0)
    ||value.status!=='READY'&&value.attempt===null
    ||value.status==='UNEXPECTED_BROADCAST'&&value.walletRpcAttempts!==1
    ||value.status==='CAPTURED_UNCLASSIFIED'&&value.walletRpcAttempts!==1
    ||value.status==='CAPTURED_UNCLASSIFIED'&&value.attempt?.status!=='HTTP_CAPTURED'
    ||value.status==='UNEXPECTED_BROADCAST'&&value.attempt?.status!=='UNEXPECTED_BROADCAST'
    ||value.status==='OUTCOME_UNKNOWN'&&value.attempt?.status!=='OUTCOME_UNKNOWN'
    ||value.walletRpcAttempts===0&&(value.broadcastOutcome!=='NOT_ATTEMPTED'||value.transactionsSent!==0)
    ||value.walletRpcAttempts===1&&(value.transactionsSent!==null||value.broadcastOutcome!==(value.status==='UNEXPECTED_BROADCAST'?'HASH_OBSERVED':'UNKNOWN')))
    context.addIssue({code:'custom',message:'POLICY_PROBE_PROOF_BINDING_INVALID'});
});
export type Day4PolicyProbeProof=z.infer<typeof Day4PolicyProbeProofSchema>;
