import {z} from 'zod';
import {keccak256} from 'viem';
import {AuthorizationPayloadSchema} from '../../capsule/src/format.js';
import {digest} from './schemas.js';
import {FundingAnchorSchema,fundingCalldata} from './funding.js';
import {OrderSnapshotSchema} from './escrow-read.js';
import {ProviderSubmissionSchema,checkProviderSubmission} from './provider-submission.js';
export const FundingSubmitRequestSchema=z.object({payload:AuthorizationPayloadSchema,confirm:z.literal(true)}).strict();
export const FundingReconcileRequestSchema=z.object({payload:AuthorizationPayloadSchema,hash:digest.optional()}).strict();
export const FundingRecordSchema=z.object({key:z.string().max(200),anchor:FundingAnchorSchema,status:z.enum(['IDLE','IN_FLIGHT','SUBMITTED','UNKNOWN','CONFIRMED','RECONCILED','REVERTED','BLOCKED']),attempt:z.uuid().nullable(),hash:digest.nullable(),leaseUntil:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),providerSubmission:ProviderSubmissionSchema.optional()}).strict().superRefine((r,ctx)=>{
  if(r.key!==`${r.anchor.chainId}:${r.anchor.arbiter.toLowerCase()}:${r.anchor.orderId.toLowerCase()}`||r.status==='IDLE'&&(r.attempt!==null||r.hash!==null||r.leaseUntil!==null)||r.status==='IN_FLIGHT'&&(!r.attempt||r.hash!==null||r.leaseUntil===null)||r.status!=='IN_FLIGHT'&&r.leaseUntil!==null||['SUBMITTED','CONFIRMED','REVERTED'].includes(r.status)&&!r.hash||['UNKNOWN','BLOCKED'].includes(r.status)&&(!r.attempt||r.hash!==null)||r.status==='RECONCILED'&&r.hash!==null)ctx.addIssue({code:'custom',message:'FUNDING_RECORD_INCONSISTENT'});
  if(r.providerSubmission){try{if(!r.attempt||!r.hash)throw Error();checkProviderSubmission(r.providerSubmission,{chainId:r.anchor.chainId,to:r.anchor.arbiter,from:r.anchor.executor,calldataHash:r.anchor.calldataHash});}catch{ctx.addIssue({code:'custom',message:'FUNDING_PROVIDER_SUBMISSION_MISMATCH'});}}
});
export const FundingResultSchema=z.object({record:FundingRecordSchema,snapshot:OrderSnapshotSchema.optional(),error:z.enum(['CHAIN_MISMATCH','DEPLOYMENT_MISMATCH','CHAIN_SNAPSHOT_CHANGED','ESCROW_INSOLVENT','FUNDING_CONTEXT_MISMATCH','FUNDING_EFFECT_MISMATCH','FUNDING_TRANSACTION_MISMATCH','FUNDING_SERVICE_UNAVAILABLE','CONFIRMATION_LOST','FUNDING_PREFLIGHT_BLOCKED','TRANSACTION_SCOPE_REJECTED','SUBMISSION_OUTCOME_UNKNOWN']).optional(),canSubmitPayment:z.literal(false)}).strict().superRefine((r,ctx)=>{
  if(!r.error&&['CONFIRMED','RECONCILED'].includes(r.record.status)&&(!r.snapshot||r.snapshot.state==='UNREGISTERED'))ctx.addIssue({code:'custom',message:'FUNDING_EFFECT_UNPROVEN'});
});
export const FundingResponseSchema=z.union([FundingResultSchema,z.object({status:z.literal('REJECT'),code:z.enum(['INPUT_INVALID','OWNER_MISMATCH'])}).strict()]);
export const OrderSubmissionResponseSchema=z.union([FundingResultSchema.safeExtend({submissionId:z.uuid().nullable(),txHash:digest.nullable()}).strict().superRefine((r,ctx)=>{if(r.submissionId!==r.record.attempt||r.txHash!==r.record.hash)ctx.addIssue({code:'custom',message:'SUBMISSION_IDENTIFIER_MISMATCH'});}),z.object({status:z.literal('REJECT'),code:z.enum(['INPUT_INVALID','OWNER_MISMATCH'])}).strict()]);
export function checkOrderSubmissionResponse(input:unknown,response:unknown){const r=OrderSubmissionResponseSchema.parse(response);if('status'in r)return r;const {submissionId,txHash,...funding}=r;const checked=checkFundingResponse(input,funding);if('status'in checked)throw new Error('SUBMISSION_IDENTIFIER_MISMATCH');return checked;}
export type FundingResult=z.infer<typeof FundingResultSchema>;
/** Recheck every original anchor even when an injected client bypasses the SDK. */
export function checkFundingResponse(input:unknown,response:unknown){
  const p=AuthorizationPayloadSchema.parse(input),r=FundingResponseSchema.parse(response);if('status'in r)return r;const g=p.grant,a=r.record.anchor;
  if(a.chainId!==g.chainId||a.nonce!==g.nonce||a.amount!==g.amount||a.calldataHash.toLowerCase()!==keccak256(fundingCalldata(p)).toLowerCase()||([['arbiter',g.arbiter],['asset',g.asset],['owner',g.owner],['executor',g.executor],['orderId',g.orderId],['contextHash',g.contextHash]] as const).some(([k,v])=>a[k].toLowerCase()!==v.toLowerCase()))throw new Error('FUNDING_RESPONSE_MISMATCH');
  const s=r.snapshot,e=p.intent;if(s){if(s.chainId!==g.chainId||s.arbiter.toLowerCase()!==g.arbiter.toLowerCase()||s.asset.toLowerCase()!==g.asset.toLowerCase()||s.orderId.toLowerCase()!==g.orderId.toLowerCase())throw new Error('FUNDING_RESPONSE_MISMATCH');
    if(s.state!=='UNREGISTERED'&&((['buyer','seller','payee','datasetHash','serviceTermsHash'] as const).some(k=>s[k].toLowerCase()!==e[k].toLowerCase())||s.contextHash.toLowerCase()!==g.contextHash.toLowerCase()||(['price','bond','deliveryDeadline','settlementDeadline'] as const).some(k=>s[k]!==e[k])))throw new Error('FUNDING_RESPONSE_MISMATCH');}
  return r;
}
