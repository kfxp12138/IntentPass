import { encodeAbiParameters, hashStruct, keccak256, toHex, type Address, type Hex } from 'viem';
import { TaskPolicySchema, IntentEnvelopeSchema, DecisionReceiptSchema, SignedQuoteSchema, CapabilityGrantSchema, DeliveryRecordSchema, address, digest, uint, positiveUint } from './schemas.js';
import { contextHash } from './index.js';
import { policyHash, receiptHash, verifyQuoteSignature, verifyReceiptSignature } from './typed-data.js';
export const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex;
export const ALLOCATION_POLICY = keccak256(toHex('intentpass.context-vote-escrow.allocation.v1'));
export const RELEASE_POLICY = keccak256(toHex('intentpass.context-vote-escrow.release.v1'));
export const DELIVERY_SCHEMA = keccak256(toHex('DeliveryRecord(uint256 schemaVersion,bytes32 orderId,bytes32 datasetHash,bytes32 reportHash,bytes32 serviceTermsHash)'));
const PREPARATION_TAG = keccak256(toHex('IntentPass.ContextVotePreparation.v1'));
export function committeeHash(members: string[]): Hex {
  if(members.length!==3 || new Set(members.map(v=>v.toLowerCase())).size!==3) throw new Error('COMMITTEE_INVALID');
  const parsed=members.map(v=>address.parse(v) as Address);
  if(parsed.some(v=>BigInt(v)===0n)) throw new Error('COMMITTEE_INVALID');
  return keccak256(encodeAbiParameters([{type:'address[3]'}],[parsed as [Address,Address,Address]]));
}
export function preparationHash(context: string, membersHash: string): Hex {
  return keccak256(encodeAbiParameters([{type:'bytes32'},{type:'bytes32'},{type:'bytes32'},{type:'uint256'}],
    [PREPARATION_TAG,digest.parse(context) as Hex,digest.parse(membersHash) as Hex,2n]));
}
export function deliveryHash(input: unknown): Hex {
  const d=DeliveryRecordSchema.parse(input);
  return hashStruct({primaryType:'DeliveryRecord',types:{DeliveryRecord:[
    {name:'schemaVersion',type:'uint256'},{name:'orderId',type:'bytes32'},{name:'datasetHash',type:'bytes32'},
    {name:'reportHash',type:'bytes32'},{name:'serviceTermsHash',type:'bytes32'},
  ]},data:{schemaVersion:BigInt(d.schemaVersion),orderId:d.orderId as Hex,datasetHash:d.datasetHash as Hex,reportHash:d.reportHash as Hex,serviceTermsHash:d.serviceTermsHash as Hex}});
}
export function acceptanceTypedData(input: {orderId:string;contextHash:string;evidenceHash:string;committeeHash:string;expiresAt:string}, deployment:{chainId:string;arbiter:string}) {
  const message={orderId:digest.parse(input.orderId),contextHash:digest.parse(input.contextHash),evidenceHash:digest.parse(input.evidenceHash),committeeHash:digest.parse(input.committeeHash),expiresAt:BigInt(positiveUint.parse(input.expiresAt))};
  return {domain:{name:'IntentPass.Acceptance',version:'1',chainId:BigInt(positiveUint.parse(deployment.chainId)),verifyingContract:address.parse(deployment.arbiter) as Address},
    types:{AcceptanceVote:[{name:'orderId',type:'bytes32'},{name:'contextHash',type:'bytes32'},{name:'evidenceHash',type:'bytes32'},{name:'committeeHash',type:'bytes32'},{name:'expiresAt',type:'uint256'}]},primaryType:'AcceptanceVote' as const,message};
}
/** Builds a single unsigned permission after verifying a fixed policy and signed inputs.
 * Caller supplies authenticated owner and trusted deployment/reviewer/committee.
 * No private key, remote model, signing, transaction submission or nonce consumption here.
 */
export async function compileGrant(input: {
  policy:unknown;intent:unknown;receipt:unknown;quote:unknown;authenticatedOwner:string;
  deployment:{chainId:string;arbiter:string;reviewer:string;committee:string[]};
  executor:string;nonce:string;deadline:string;now:bigint;
}) {
  const p=TaskPolicySchema.parse(input.policy),e=IntentEnvelopeSchema.parse(input.intent);
  const r=DecisionReceiptSchema.parse(input.receipt),q=SignedQuoteSchema.parse(input.quote);
  const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
  const c=contextHash(e);
  const domain={chainId:input.deployment.chainId,arbiter:input.deployment.arbiter};
  const {signature: receiptSignature,...unsignedReceipt}=r;
  if(!eq(e.buyer,address.parse(input.authenticatedOwner))) throw new Error('AUTH_REQUIRED');
  if(e.chainId!==positiveUint.parse(input.deployment.chainId)||!eq(e.arbiter,address.parse(input.deployment.arbiter))
    ||!eq(e.reviewer,address.parse(input.deployment.reviewer))||!eq(e.committeeHash,committeeHash(input.deployment.committee))) throw new Error('CONTEXT_MISMATCH');
  if(!eq(e.policyHash,policyHash(p))||!eq(e.taskId,p.taskId)||!eq(e.datasetHash,p.datasetHash)||!eq(e.asset,p.allowedAsset)
    ||BigInt(e.price)+BigInt(e.bond)>BigInt(p.budget)) throw new Error('POLICY_CONTRADICTED');
  if(!eq(e.allocationPolicyHash,ALLOCATION_POLICY)||!eq(e.intentReleasePolicyHash,RELEASE_POLICY)
    ||!eq(e.deliverySchemaHash,DELIVERY_SCHEMA)||!eq(e.pactPaymentPublicKeyHash,ZERO_HASH)) throw new Error('CONTEXT_MISMATCH');
  if(!eq(q.seller,e.seller)||!eq(q.payee,e.payee)||!eq(q.asset,e.asset)||q.amount!==e.price||!eq(q.serviceTermsHash,e.serviceTermsHash)
    ||!await verifyQuoteSignature(q,domain)) throw new Error('QUOTE_INVALID');
  if(!eq(r.contextHash,c)||!eq(r.policyHash,e.policyHash)||!eq(r.purchaseEvidenceCommitment,e.purchaseEvidenceCommitment)
    ||!eq(r.reviewer,e.reviewer)||!await verifyReceiptSignature(r,domain)) throw new Error('CONTEXT_MISMATCH');
  const deadline=BigInt(positiveUint.parse(input.deadline));
  if(input.now<0n||deadline<input.now||deadline>BigInt(e.deliveryDeadline)||deadline>BigInt(q.expiresAt)||deadline>BigInt(r.expiresAt)
    ||BigInt(e.deliveryDeadline)<=input.now) throw new Error('AUTH_EXPIRED');
  return CapabilityGrantSchema.parse({schemaVersion:1,owner:e.buyer,executor:address.parse(input.executor),chainId:e.chainId,
    arbiter:e.arbiter,orderId:e.orderId,asset:e.asset,amount:(BigInt(e.price)+BigInt(e.bond)).toString(),contextHash:c,
    preparationHash:preparationHash(c,e.committeeHash),receiptHash:receiptHash(unsignedReceipt,domain),nonce:uint.parse(input.nonce),deadline:input.deadline,maxUses:1});
}
