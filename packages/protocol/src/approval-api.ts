import {z} from 'zod';
import {address,digest,uint,positiveUint} from './schemas.js';
import {AuthorizationPayloadSchema} from '../../capsule/src/format.js';
export const ApprovalStepSchema=z.enum(['RESET','SET']);
export const ApprovalReserveRequestSchema=z.object({payload:AuthorizationPayloadSchema,step:ApprovalStepSchema}).strict();
export const ApprovalReconcileRequestSchema=ApprovalReserveRequestSchema.extend({hash:digest}).strict();
export const ApprovalRecordSchema=z.object({orderId:digest,contextHash:digest,nonce:uint,chainId:positiveUint,asset:address,owner:address,spender:address,amount:uint,step:ApprovalStepSchema,
  status:z.enum(['RESERVED','CONFIRMED','REVERTED']),hash:digest.nullable()}).strict().superRefine((r,ctx)=>{if((r.status==='RESERVED')!==(r.hash===null))ctx.addIssue({code:'custom',message:'APPROVAL_RECORD_INCONSISTENT'});});
export type ApprovalRecord=z.infer<typeof ApprovalRecordSchema>;
export const ApprovalReceiptSchema=z.union([
  z.object({status:z.literal('PENDING'),hash:digest,canSubmitPayment:z.literal(false)}).strict(),
  z.object({status:z.enum(['CONFIRMED','REVERTED']),hash:digest,orderId:digest,step:ApprovalStepSchema,approvedAmount:uint,currentAllowance:uint,exactAllowance:z.boolean(),block:z.object({number:uint,hash:digest}).strict(),canSubmitPayment:z.literal(false)}).strict(),
]);
export const ApprovalRejectSchema=z.object({status:z.literal('REJECT'),code:z.enum(['INPUT_INVALID','OWNER_MISMATCH','APPROVAL_BLOCKED','APPROVAL_ATTEMPT_REQUIRED','APPROVAL_RECORD_CONFLICT'])}).strict();
export const ApprovalReserveResponseSchema=z.union([z.object({created:z.boolean(),record:ApprovalRecordSchema}).strict().superRefine((r,ctx)=>{if(r.created&&r.record.status!=='RESERVED')ctx.addIssue({code:'custom',message:'APPROVAL_RESERVATION_INCONSISTENT'});}),ApprovalRejectSchema]);
export const ApprovalReconcileResponseSchema=z.union([z.object({record:ApprovalRecordSchema,receipt:ApprovalReceiptSchema}).strict(),ApprovalRejectSchema]);
