import {z} from 'zod';
import {keccak256,type Hex} from 'viem';
import {address,digest,positiveUint} from './schemas.js';
import {ProviderIdSchema} from './day4-origin-types.js';

/** Only the original optional ID returned by the SDK for this exact broadcast.
 * A stored acknowledgement is neither finality nor historical policy provenance. */
export const ProviderSubmissionSchema=z.object({provider:z.literal('PRIVY'),
  scope:z.literal('SDK_SEND_RESPONSE_ASSOCIATION_NOT_FINALIZED_OR_POLICY_PROVENANCE'),
  transactionId:ProviderIdSchema,walletId:ProviderIdSchema,chainId:positiveUint,
  from:address,to:address,calldataHash:digest}).strict();
export type ProviderSubmission=z.infer<typeof ProviderSubmissionSchema>;
export const RecordedBroadcastSchema=z.object({hash:digest,providerSubmission:ProviderSubmissionSchema.nullable()}).strict();
export type RecordedBroadcast=z.infer<typeof RecordedBroadcastSchema>;
export type BroadcastResult=Hex|RecordedBroadcast;
/** IDs are opaque and case sensitive; addresses and digests are hexadecimal. */
export function sameProviderSubmission(a:ProviderSubmission,b:ProviderSubmission):boolean{
  return a.provider===b.provider&&a.scope===b.scope&&a.transactionId===b.transactionId&&a.walletId===b.walletId&&a.chainId===b.chainId
    &&(['from','to','calldataHash'] as const).every(k=>a[k].toLowerCase()===b[k].toLowerCase());
}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
export function recordedBroadcast(input:unknown):RecordedBroadcast{
  try{return freeze(RecordedBroadcastSchema.parse(typeof input==='string'?{hash:input,providerSubmission:null}:structuredClone(input)));}
  catch{throw Error('SUBMISSION_OUTCOME_UNKNOWN');}
}
export function checkProviderSubmission(input:unknown,expected:{chainId:string;to:string;from?:string;calldataHash:string}):ProviderSubmission{
  let value;try{value=freeze(ProviderSubmissionSchema.parse(structuredClone(input)));}catch{throw Error('PROVIDER_SUBMISSION_INVALID');}
  const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
  if(value.chainId!==expected.chainId||!eq(value.to,expected.to)||!eq(value.calldataHash,expected.calldataHash)||expected.from&&!eq(value.from,expected.from))throw Error('PROVIDER_SUBMISSION_MISMATCH');
  return value;
}
export function checkBroadcastResult(input:unknown,expected:{chainId:string;to:string;from:string;data:Hex}):RecordedBroadcast{
  const result=recordedBroadcast(input);
  if(result.providerSubmission)checkProviderSubmission(result.providerSubmission,{...expected,calldataHash:keccak256(expected.data)});
  return result;
}
