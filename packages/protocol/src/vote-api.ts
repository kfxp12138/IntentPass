import {z} from 'zod';
import {keccak256} from 'viem';
import {AcceptanceRecordSchema,verifyAcceptanceSignature} from './acceptance-api.js';
import {VoteRequestSchema,VoteReconcileRequestSchema,VoteReceiptSchema,VotePreparationSchema,encodedVote} from './vote.js';
import {digest} from './schemas.js';
export const VoteRecordSchema=z.object({...AcceptanceRecordSchema.shape,status:z.enum(['RESERVED','CONFIRMED','REVERTED']),signatureHash:digest,dataHash:digest,hash:digest.nullable()}).strict().superRefine((r,c)=>{if((r.status==='RESERVED')!==(r.hash===null))c.addIssue({code:'custom',message:'VOTE_RECORD_INCONSISTENT'});});
export type VoteRecord=z.infer<typeof VoteRecordSchema>;
export async function voteRecord(input:unknown,committee:unknown):Promise<VoteRecord>{const parsed=z.union([VoteRequestSchema,VoteReconcileRequestSchema]).parse(input),r='hash'in parsed?(({hash:_hash,...vote})=>vote)(parsed):parsed,signed=await verifyAcceptanceSignature(r,committee);return VoteRecordSchema.parse({...signed,status:'RESERVED',dataHash:keccak256(encodedVote(r,signed)),hash:null});}
export async function checkVoteRecord(input:unknown,record:unknown){const r=VoteRecordSchema.parse(record),expected=await voteRecord(input,r.committee);for(const k of Object.keys(expected) as (keyof VoteRecord)[])if(k!=='status'&&k!=='hash'&&JSON.stringify(expected[k]).toLowerCase()!==JSON.stringify(r[k]).toLowerCase())throw new Error('VOTE_RESPONSE_MISMATCH');return r;}
const reject=z.object({status:z.literal('REJECT'),code:z.enum(['INPUT_INVALID','ROLE_MISMATCH','VOTE_BLOCKED','SIGNATURE_RECORD_REQUIRED','VOTE_ATTEMPT_REQUIRED','VOTE_RECORD_CONFLICT'])}).strict();
export const VotePrepareResponseSchema=z.union([VotePreparationSchema,reject]);
export const VoteReserveResponseSchema=z.union([z.object({created:z.boolean(),record:VoteRecordSchema,canExecute:z.literal(false)}).strict().superRefine((r,c)=>{if(r.created&&r.record.status!=='RESERVED')c.addIssue({code:'custom',message:'VOTE_RESERVATION_INCONSISTENT'});}),reject]);
export const VoteQueryResponseSchema=z.union([z.object({record:VoteRecordSchema.nullable(),canExecute:z.literal(false)}).strict(),reject]);
export const VoteReconcileResponseSchema=z.union([z.object({record:VoteRecordSchema,receipt:VoteReceiptSchema,canExecute:z.literal(false)}).strict(),reject]);
