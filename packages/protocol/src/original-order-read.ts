import {z} from 'zod';
import type {Hex} from 'viem';
import {IntentEnvelopeSchema,CapabilityGrantSchema,address,positiveUint} from './schemas.js';
import {contextHash} from './index.js';
import {committeeHash,preparationHash,ALLOCATION_POLICY,RELEASE_POLICY,DELIVERY_SCHEMA,ZERO_HASH} from './escrow.js';
import {verifyGrantSignature} from './typed-data.js';
import {OrderSnapshotSchema,type OrderSnapshot} from './escrow-read.js';

/** Original public fields only; no task/evidence text, Capsule or PRF material. */
export const OriginalOrderReadProofSchema=z.object({intent:IntentEnvelopeSchema,grant:CapabilityGrantSchema,ownerSignature:z.string().regex(/^0x[0-9a-fA-F]{130}$/)}).strict();
export type OriginalOrderReadProof=z.infer<typeof OriginalOrderReadProofSchema>;
export const OriginalOrderReadDeploymentSchema=z.object({chainId:positiveUint,arbiter:address,asset:address,reviewer:address,committee:z.tuple([address,address,address]),executor:address}).strict();
export type OriginalOrderReadDeployment=z.infer<typeof OriginalOrderReadDeploymentSchema>;
export const OriginalOrderReadResponseSchema=z.union([OrderSnapshotSchema,z.object({status:z.literal('REJECT'),code:z.enum(['ORDER_ID_INVALID','ORDER_ID_MISMATCH','ORDER_ACCESS_DENIED','ORDER_READ_PROOF_INVALID'])}).strict()]);
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();

/** Verify historical owner proof. No expiry revival, signer, nonce or payment API. */
export async function verifyOriginalOrderReadProof(input:unknown,deployment:OriginalOrderReadDeployment) {
  const p=OriginalOrderReadProofSchema.parse(input),d=OriginalOrderReadDeploymentSchema.parse(deployment),e=p.intent,g=p.grant,c=contextHash(e),members=committeeHash(d.committee);
  if(e.chainId!==d.chainId||!eq(e.arbiter,d.arbiter)||!eq(e.asset,d.asset)||!eq(e.reviewer,d.reviewer)||!eq(e.committeeHash,members)
    ||!eq(e.allocationPolicyHash,ALLOCATION_POLICY)||!eq(e.intentReleasePolicyHash,RELEASE_POLICY)||!eq(e.deliverySchemaHash,DELIVERY_SCHEMA)||!eq(e.pactPaymentPublicKeyHash,ZERO_HASH)
    ||eq(e.orderId,ZERO_HASH)||[e.buyer,e.seller,e.payee].some(actor=>BigInt(actor)===0n||eq(actor,d.arbiter)))throw new Error('ORDER_READ_PROOF_INVALID');
  if(g.chainId!==d.chainId||!eq(g.arbiter,d.arbiter)||!eq(g.owner,e.buyer)||!eq(g.executor,d.executor)||!eq(g.orderId,e.orderId)||!eq(g.asset,d.asset)
    ||g.amount!==(BigInt(e.price)+BigInt(e.bond)).toString()||!eq(g.contextHash,c)||!eq(g.preparationHash,preparationHash(c,members))||eq(g.receiptHash,ZERO_HASH)
    ||BigInt(g.deadline)>BigInt(e.deliveryDeadline)||!await verifyGrantSignature(g,p.ownerSignature as Hex))throw new Error('ORDER_READ_PROOF_INVALID');
  return p;
}

/** A 404/transport failure is never converted into an unregistered order. */
export function checkOriginalOrderReadSnapshot(input:unknown,snapshot:unknown):OrderSnapshot {
  const p=OriginalOrderReadProofSchema.parse(input),e=p.intent,o=OrderSnapshotSchema.parse(snapshot) as OrderSnapshot;
  if(o.chainId!==e.chainId||!eq(o.arbiter,e.arbiter)||!eq(o.asset,e.asset)||!eq(o.orderId,e.orderId)
    ||BigInt(o.accounting.balance)<BigInt(o.accounting.locked)+BigInt(o.accounting.outstanding))throw new Error('ORDER_READ_RESPONSE_MISMATCH');
  if(o.state==='UNREGISTERED') {
    // Solidity's empty mapping record has no participants, credits or commitments.
    if((['contextHash','datasetHash','serviceTermsHash','evidenceHash'] as const).some(key=>!eq(o[key],ZERO_HASH))
      ||(['buyer','seller','payee'] as const).some(key=>BigInt(o[key])!==0n)
      ||(['price','bond','deliveryDeadline','settlementDeadline'] as const).some(key=>o[key]!=='0')||o.voteMask!==0
      ||Object.values(o.credits).some(value=>value!=='0')||Object.values(o.withdrawn).some(value=>value!=='0'))throw new Error('ORDER_READ_RESPONSE_MISMATCH');
  }else if(!eq(o.contextHash,p.grant.contextHash)||(['buyer','seller','payee','datasetHash','serviceTermsHash'] as const).some(key=>!eq(o[key],e[key]))
    ||(['price','bond','deliveryDeadline','settlementDeadline'] as const).some(key=>o[key]!==e[key]))throw new Error('ORDER_READ_RESPONSE_MISMATCH');
  return o;
}
