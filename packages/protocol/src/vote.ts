import {z} from 'zod';
import {encodeFunctionData,keccak256,type Hex} from 'viem';
import {AcceptanceSignatureRequestSchema,AcceptanceRecordSchema,verifyAcceptanceSignature,checkAcceptanceRecord} from './acceptance-api.js';
import {prepareAcceptance,assertFulfillmentOrder} from './fulfillment.js';
import {OrderSnapshotSchema} from './escrow-read.js';
import {address,digest,positiveUint,uint} from './schemas.js';
import {escrowAbi} from './escrow-abi.js';
import {verifyOriginalAuthorization,type RecoveryDeployment} from '../../capsule/src/recovery.js';
export const VoteRequestSchema=AcceptanceSignatureRequestSchema;
export const VoteReconcileRequestSchema=VoteRequestSchema.extend({hash:digest}).strict();
function request(input:unknown){return z.union([VoteRequestSchema,VoteReconcileRequestSchema]).parse(input);}
function signatureInput(input:unknown){const r=request(input);return 'hash'in r?(({hash:_hash,...vote})=>vote)(r):r;}
/** Compile exclusively from the original verified vote anchors and signature. */
export function encodedVote(input:unknown,record:unknown):Hex{const r=signatureInput(input),v=checkAcceptanceRecord(r,record);if(v.status!=='SIGNED'||v.signatureHash?.toLowerCase()!==keccak256(r.signature as Hex).toLowerCase())throw new Error('VOTE_SIGNATURE_REQUIRED');return encodeFunctionData({abi:escrowAbi,functionName:'accept',args:[v.orderId as Hex,v.evidenceHash as Hex,BigInt(v.expiresAt),BigInt(v.memberIndex),r.signature as Hex]});}
export const VotePreparationSchema=z.object({kind:z.literal('VOTE_PREPARED'),order:OrderSnapshotSchema,finality:z.literal('finalized'),record:AcceptanceRecordSchema,actor:address,chainId:positiveUint,target:address,data:z.string().regex(/^0x[0-9a-fA-F]+$/),value:z.literal('0'),canExecute:z.literal(false)}).strict();
export async function prepareVote(input:unknown,wallets:readonly string[],deployment:RecoveryDeployment,read:(id:string)=>Promise<unknown>,clock=()=>BigInt(Math.floor(Date.now()/1000)),allowLocalLatest=false){const r=VoteRequestSchema.parse(input);await verifyOriginalAuthorization(r.payload,[r.payload.intent.buyer],deployment);const record=await verifyAcceptanceSignature(r,deployment.committee),{signature:_signature,...original}=r;
  const p=await prepareAcceptance(original,wallets,deployment,read,clock,allowLocalLatest);return {kind:'VOTE_PREPARED' as const,order:p.order,finality:p.finality,record,actor:record.signer,chainId:record.chainId,target:record.arbiter,data:encodedVote(r,record),value:'0' as const,canExecute:false as const};
}
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export async function checkVotePreparation(input:unknown,response:unknown){const r=VoteRequestSchema.parse(input),p=VotePreparationSchema.parse(response),record=checkAcceptanceRecord(r,p.record),verified=await verifyAcceptanceSignature(r,record.committee);assertFulfillmentOrder(r.payload,p.order);
  if(record.status!=='SIGNED'||!eq(record.signatureHash!,verified.signatureHash)||!eq(p.actor,record.signer)||p.chainId!==record.chainId||!eq(p.target,record.arbiter)||!eq(p.data,encodedVote(r,record))||p.order.state!=='EVIDENCE_FROZEN'||![0,1,2,4].includes(p.order.voteMask)||!!(p.order.voteMask&(1<<record.memberIndex))||!eq(p.order.evidenceHash,record.evidenceHash)||BigInt(record.expiresAt)>BigInt(p.order.settlementDeadline)||BigInt(record.expiresAt)<BigInt(p.order.block.timestamp))throw new Error('VOTE_RESPONSE_MISMATCH');return p;
}
export const VoteReceiptSchema=z.union([
  z.object({status:z.literal('PENDING'),hash:digest,canSubmitPayment:z.literal(false)}).strict(),
  z.object({status:z.enum(['CONFIRMED','REVERTED']),hash:digest,order:OrderSnapshotSchema,receiptBlock:z.object({number:uint,hash:digest}).strict(),certifiedInReceipt:z.boolean(),quorumReached:z.boolean(),finality:z.literal('finalized'),canSubmitPayment:z.literal(false)}).strict(),
]);
export function checkVoteReceipt(input:unknown,receipt:unknown,record:unknown){const r=VoteReconcileRequestSchema.parse(input),v=checkAcceptanceRecord(signatureInput(r),record),p=VoteReceiptSchema.parse(receipt);encodedVote(r,v);if(!eq(p.hash,r.hash))throw new Error('VOTE_RESPONSE_MISMATCH');if(p.status==='PENDING')return p;assertFulfillmentOrder(r.payload,p.order);
  const quorum=[3,5,6].includes(p.order.voteMask);if(BigInt(p.receiptBlock.number)>BigInt(p.order.block.number)||p.receiptBlock.number===p.order.block.number&&!eq(p.receiptBlock.hash,p.order.block.hash)||p.quorumReached!==quorum||p.certifiedInReceipt&&!quorum||p.status==='REVERTED'&&p.certifiedInReceipt)throw new Error('VOTE_RESPONSE_MISMATCH');
  if(p.status==='CONFIRMED'&&(!eq(p.order.evidenceHash,v.evidenceHash)||![1,2,4,3,5,6].includes(p.order.voteMask)||!(p.order.voteMask&(1<<v.memberIndex))||['UNREGISTERED','FUNDED','ALLOCATED_REFUND'].includes(p.order.state)||quorum&&p.order.state==='EVIDENCE_FROZEN'||!quorum&&['CERTIFIED','ALLOCATED_PAID'].includes(p.order.state)))throw new Error('VOTE_EFFECT_UNPROVEN');return p;
}
