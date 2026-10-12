import {z} from 'zod';
import {hashTypedData,keccak256,verifyTypedData,type Hex,type Address} from 'viem';
import {AcceptancePrepareRequestSchema,reportDelivery} from './fulfillment.js';
import {address,digest,positiveUint} from './schemas.js';
import {acceptanceTypedData,committeeHash} from './escrow.js';
const committee=z.tuple([address,address,address]),signature=z.string().regex(/^0x[0-9a-fA-F]{130}$/);
export const AcceptanceReserveRequestSchema=AcceptancePrepareRequestSchema;
export const AcceptanceSignatureRequestSchema=AcceptancePrepareRequestSchema.extend({signature}).strict();
export const AcceptanceRecordSchema=z.object({chainId:positiveUint,arbiter:address,asset:address,orderId:digest,contextHash:digest,datasetHash:digest,reportHash:digest,serviceTermsHash:digest,evidenceHash:digest,committee,committeeHash:digest,memberIndex:z.number().int().min(0).max(2),signer:address,expiresAt:positiveUint,voteDigest:digest,status:z.enum(['RESERVED','SIGNED']),signatureHash:digest.nullable()}).strict().superRefine((r,c)=>{if((r.status==='RESERVED')!==(r.signatureHash===null))c.addIssue({code:'custom',message:'ACCEPTANCE_RECORD_INCONSISTENT'});});
export type AcceptanceRecord=z.infer<typeof AcceptanceRecordSchema>;
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export function acceptanceRecord(input:unknown,members:unknown):AcceptanceRecord{
  const request=z.union([AcceptanceReserveRequestSchema,AcceptanceSignatureRequestSchema]).parse(input),p=request.payload,group=committee.parse(members),result=reportDelivery(p,request.dataset,request.report),ch=committeeHash(group);
  if(!eq(ch,p.intent.committeeHash)||BigInt(request.expiresAt)>BigInt(p.intent.settlementDeadline))throw new Error('ACCEPTANCE_INPUT_MISMATCH');
  const message={orderId:p.intent.orderId,contextHash:p.grant.contextHash,evidenceHash:result.evidenceHash,committeeHash:ch,expiresAt:request.expiresAt};
  return AcceptanceRecordSchema.parse({chainId:p.intent.chainId,arbiter:p.intent.arbiter,asset:p.intent.asset,orderId:p.intent.orderId,contextHash:p.grant.contextHash,datasetHash:p.intent.datasetHash,reportHash:result.delivery.reportHash,serviceTermsHash:p.intent.serviceTermsHash,evidenceHash:result.evidenceHash,committee:group,committeeHash:ch,memberIndex:request.memberIndex,signer:group[request.memberIndex],expiresAt:request.expiresAt,voteDigest:hashTypedData(acceptanceTypedData(message,p.intent)),status:'RESERVED',signatureHash:null});
}
export function checkAcceptanceRecord(input:unknown,record:unknown){const r=AcceptanceRecordSchema.parse(record),expected=acceptanceRecord(input,r.committee);for(const k of Object.keys(expected) as (keyof AcceptanceRecord)[])if(k!=='status'&&k!=='signatureHash'&&!eq(JSON.stringify(expected[k]),JSON.stringify(r[k])))throw new Error('ACCEPTANCE_RESPONSE_MISMATCH');return r;}
/** Historical public signature verification; no new signing or transaction permission. */
export async function verifyAcceptanceSignature(input:unknown,members:unknown){const request=AcceptanceSignatureRequestSchema.parse(input),r=acceptanceRecord(request,members),typed=acceptanceTypedData({orderId:r.orderId,contextHash:r.contextHash,evidenceHash:r.evidenceHash,committeeHash:r.committeeHash,expiresAt:r.expiresAt},r);
  let valid=false;try{valid=await verifyTypedData({...typed,address:r.signer as Address,signature:request.signature as Hex});}catch{/* Fixed rejection, never provider/library internals. */}
  if(!valid)throw new Error('ACCEPTANCE_SIGNATURE_INVALID');return {...r,status:'SIGNED' as const,signatureHash:keccak256(request.signature as Hex)};
}
const reject=z.object({status:z.literal('REJECT'),code:z.enum(['INPUT_INVALID','ROLE_MISMATCH','ACCEPTANCE_BLOCKED','ACCEPTANCE_ATTEMPT_REQUIRED','ACCEPTANCE_RECORD_CONFLICT','ACCEPTANCE_SIGNATURE_INVALID'])}).strict();
export const AcceptanceReserveResponseSchema=z.union([z.object({created:z.boolean(),record:AcceptanceRecordSchema,canExecute:z.literal(false)}).strict().superRefine((r,c)=>{if(r.created&&r.record.status!=='RESERVED')c.addIssue({code:'custom',message:'ACCEPTANCE_RESERVATION_INCONSISTENT'});}),reject]);
export const AcceptanceQueryResponseSchema=z.union([z.object({record:AcceptanceRecordSchema.nullable(),canExecute:z.literal(false)}).strict(),reject]);
export const AcceptanceSignatureResponseSchema=z.union([z.object({record:AcceptanceRecordSchema,canExecute:z.literal(false)}).strict().superRefine((r,c)=>{if(r.record.status!=='SIGNED')c.addIssue({code:'custom',message:'ACCEPTANCE_SIGNATURE_UNPROVEN'});}),reject]);
