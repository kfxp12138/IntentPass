import {z} from 'zod';
import {keccak256,toHex} from 'viem';
import {WithdrawalRequestSchema,WithdrawalReconcileRequestSchema,WithdrawalPreparationSchema,WithdrawalReceiptSchema,withdrawalCalldata,allocatedAmount} from './withdrawal.js';
import {address,digest,positiveUint,uint} from './schemas.js';
export const WithdrawalReserveRequestSchema=WithdrawalRequestSchema.extend({confirm:z.literal(true),retryOf:digest.optional()}).strict();
export const WithdrawalQueryRequestSchema=WithdrawalRequestSchema.extend({attempt:positiveUint.optional()}).strict();
export const WithdrawalAttemptReconcileRequestSchema=WithdrawalReconcileRequestSchema.extend({attempt:positiveUint}).strict();
export const WithdrawalAnchorSchema=z.object({chainId:positiveUint,arbiter:address,asset:address,orderId:digest,contextHash:digest,beneficiary:address,buyer:address,payee:address,authorizationHash:digest,dataHash:digest,allocationState:z.enum(['ALLOCATED_PAID','ALLOCATED_REFUND','ALLOCATED_COMPENSATION']),amount:positiveUint}).strict();
const block=z.object({number:uint,hash:digest}).strict();
export const WithdrawalRecordSchema=WithdrawalAnchorSchema.extend({attempt:positiveUint,retryOf:digest.nullable(),status:z.enum(['RESERVED','CONFIRMED','REVERTED']),hash:digest.nullable(),receiptBlock:block.nullable()}).strict().superRefine((r,c)=>{if((r.status==='RESERVED')!==(r.hash===null)||(r.status==='RESERVED')!==(r.receiptBlock===null)||(r.attempt==='1')!==(r.retryOf===null)||r.hash&&r.retryOf&&r.hash.toLowerCase()===r.retryOf.toLowerCase())c.addIssue({code:'custom',message:'WITHDRAWAL_RECORD_INCONSISTENT'});});
export type WithdrawalRecord=z.infer<typeof WithdrawalRecordSchema>;
export function withdrawalAnchor(input:unknown,allocationState:WithdrawalRecord['allocationState']){const r=WithdrawalRequestSchema.parse(input),e=r.payload.intent;const amount=allocatedAmount({...e,state:allocationState},r.beneficiary);return WithdrawalAnchorSchema.parse({chainId:e.chainId,arbiter:e.arbiter,asset:e.asset,orderId:e.orderId,contextHash:r.payload.grant.contextHash,beneficiary:r.beneficiary,buyer:e.buyer,payee:e.payee,authorizationHash:keccak256(toHex(JSON.stringify(r.payload))),dataHash:keccak256(withdrawalCalldata(r)),allocationState,amount:String(amount)});}
export function checkWithdrawalRecord(input:unknown,record:unknown){const r=WithdrawalRecordSchema.parse(record),anchor=withdrawalAnchor(input,r.allocationState);for(const k of Object.keys(anchor) as (keyof typeof anchor)[])if(anchor[k].toLowerCase()!==r[k].toLowerCase())throw new Error('WITHDRAWAL_RECORD_CONFLICT');return r;}
const reject=z.object({status:z.literal('REJECT'),code:z.enum(['INPUT_INVALID','ROLE_MISMATCH','WITHDRAWAL_BLOCKED','WITHDRAWAL_ATTEMPT_REQUIRED','WITHDRAWAL_RECORD_CONFLICT','WITHDRAWAL_RETRY_NOT_ALLOWED'])}).strict();
export const WithdrawalPrepareResponseSchema=z.union([WithdrawalPreparationSchema,reject]);
export const WithdrawalReserveResponseSchema=z.union([z.object({created:z.boolean(),record:WithdrawalRecordSchema,canExecute:z.literal(false)}).strict().superRefine((r,c)=>{if(r.created&&r.record.status!=='RESERVED')c.addIssue({code:'custom',message:'WITHDRAWAL_RESERVATION_INCONSISTENT'});}),reject]);
export const WithdrawalQueryResponseSchema=z.union([z.object({record:WithdrawalRecordSchema.nullable(),canExecute:z.literal(false)}).strict(),reject]);
export const WithdrawalReconcileResponseSchema=z.union([z.object({record:WithdrawalRecordSchema,receipt:WithdrawalReceiptSchema,canExecute:z.literal(false)}).strict(),reject]);
