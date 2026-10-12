import {z} from 'zod';
import {encodeFunctionData,keccak256,type Hex} from 'viem';
import {escrowAbi} from './escrow-abi.js';
import {ProviderSubmissionSchema,checkProviderSubmission} from './provider-submission.js';
import {address,digest,positiveUint} from './schemas.js';
import {OrderSnapshotSchema} from './escrow-read.js';
import {AllocationRequestSchema,AllocationPreparationSchema,AllocationReceiptSchema,checkAllocationPreparation,checkAllocationReceipt,allocationOrder} from './allocation.js';
export const AllocationTriggerRequestSchema=AllocationRequestSchema.extend({confirm:z.literal(true),action:z.enum(['settle','timeout'])}).strict();
export const AllocationAttemptReconcileRequestSchema=AllocationRequestSchema.extend({hash:digest}).strict();
const status=z.enum(['IDLE','IN_FLIGHT','SUBMITTED','UNKNOWN','CONFIRMED','RECONCILED','REVERTED','BLOCKED']);
const order=z.object({chainId:positiveUint,arbiter:address,orderId:digest,contextHash:digest,buyer:address,seller:address,payee:address}).strict();
export const AllocationRecordSchema=z.object({key:z.string().max(160),order,status,attempt:z.uuid().nullable(),action:z.enum(['settle','timeout']).nullable(),leaseUntil:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),txHash:digest.nullable(),error:z.string().regex(/^[A-Z0-9_]{1,80}$/).nullable(),providerSubmission:ProviderSubmissionSchema.optional()}).strict().superRefine((r,ctx)=>{
  if(r.providerSubmission){try{if(!r.attempt||!r.txHash||!r.action)throw Error();checkProviderSubmission(r.providerSubmission,{chainId:r.order.chainId,to:r.order.arbiter,calldataHash:keccak256(encodeFunctionData({abi:escrowAbi,functionName:r.action,args:[r.order.orderId as Hex]}))});}catch{ctx.addIssue({code:'custom',message:'ALLOCATION_PROVIDER_SUBMISSION_MISMATCH'});}}
});
const reject=z.object({status:z.literal('REJECT'),code:z.enum(['INPUT_INVALID','ALLOCATION_BLOCKED','ALLOCATION_ATTEMPT_REQUIRED','ALLOCATION_RECORD_CONFLICT'])}).strict();
export const AllocationPrepareResponseSchema=z.union([AllocationPreparationSchema,reject]);
const observation=z.object({status:z.union([status,z.enum(['WAITING','UNAVAILABLE'])]),snapshot:OrderSnapshotSchema.optional(),txHash:digest.optional(),error:z.string().regex(/^[A-Z0-9_]{1,80}$/).optional()}).strict();
export const AllocationResponseSchema=z.union([z.object({record:AllocationRecordSchema.nullable(),preparation:AllocationPreparationSchema,receipt:AllocationReceiptSchema.nullable(),observation:observation.optional(),canExecute:z.literal(false)}).strict(),reject]);
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export function checkAllocationResponse(input:unknown,response:unknown,requestedHash?:string){const r=AllocationRequestSchema.parse(input),v=AllocationResponseSchema.parse(response);if('status'in v)return v;checkAllocationPreparation(r,v.preparation);const record=v.record;
  if(!record){if(v.receipt||v.observation)throw new Error('ALLOCATION_RESPONSE_MISMATCH');return v;}
  const e=r.payload.intent,g=r.payload.grant,expected={chainId:e.chainId,arbiter:e.arbiter,orderId:e.orderId,contextHash:g.contextHash,buyer:e.buyer,seller:e.seller,payee:e.payee};
  if(record.key!==`${e.chainId}:${e.arbiter.toLowerCase()}:${e.orderId.toLowerCase()}`||Object.entries(expected).some(([k,value])=>!eq(record.order[k as keyof typeof expected],value))||Boolean(record.attempt)!==Boolean(record.action)||record.status==='IDLE'&&(record.attempt!==null||record.txHash!==null||record.leaseUntil!==null)||record.status==='IN_FLIGHT'&&(!record.attempt||record.leaseUntil===null)||record.status!=='IN_FLIGHT'&&record.leaseUntil!==null||['SUBMITTED','CONFIRMED','REVERTED'].includes(record.status)&&(!record.attempt||!record.txHash)||['UNKNOWN','BLOCKED'].includes(record.status)&&(!record.attempt||record.txHash!==null))throw new Error('ALLOCATION_RESPONSE_MISMATCH');
  if(record.providerSubmission&&!eq(record.providerSubmission.from,g.executor))throw new Error('ALLOCATION_RESPONSE_MISMATCH');
  if(v.observation?.snapshot)allocationOrder(r,v.observation.snapshot);if(v.observation?.txHash&&(!record.txHash||!eq(v.observation.txHash,record.txHash)))throw new Error('ALLOCATION_RESPONSE_MISMATCH');
  if(v.receipt){const hash=requestedHash??record.txHash;if(!hash||!record.action||record.txHash&&!eq(record.txHash,hash))throw new Error('ALLOCATION_RESPONSE_MISMATCH');checkAllocationReceipt({...r,action:record.action,hash},v.receipt);}
  if(record.status==='CONFIRMED'&&v.receipt?.status!=='CONFIRMED'||record.status==='REVERTED'&&v.receipt?.status!=='REVERTED')throw new Error('ALLOCATION_RESPONSE_MISMATCH');return v;
}
