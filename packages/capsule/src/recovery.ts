import {z} from 'zod';
import type {Hex} from 'viem';
import {AuthorizationPayloadSchema} from './format.js';
import {CapsuleError} from './crypto.js';
import {compileGrant,contextHash,preparationHash,purchaseEvidenceHash,verifyGrantSignature,address,committeeHash,OriginalOrderReadDeploymentSchema,OriginalOrderReadProofSchema,checkOriginalOrderReadSnapshot} from '../../protocol/src/index.js';
import {OrderSnapshotSchema,type OrderSnapshot} from '../../protocol/src/escrow-read.js';

export const RecoveryDeploymentSchema=OriginalOrderReadDeploymentSchema;
export type RecoveryDeployment=z.infer<typeof RecoveryDeploymentSchema>;
export interface RecoveryReader {read:(originalOrderId:string)=>Promise<OrderSnapshot>;}
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export function originalOrderReadProof(input:unknown){const p=AuthorizationPayloadSchema.parse(input);return OriginalOrderReadProofSchema.parse({intent:p.intent,grant:p.grant,ownerSignature:p.ownerSignature});}

/** Historical verification only. This function has no signer, sender, nonce issuer or payment API. */
export async function verifyOriginalAuthorization(input:unknown,authenticatedWallets:readonly string[],deployment:RecoveryDeployment) {
  const p=AuthorizationPayloadSchema.parse(input),d=RecoveryDeploymentSchema.parse(deployment),e=p.intent;
  if(!authenticatedWallets.some(wallet=>eq(address.parse(wallet),e.buyer)))throw new CapsuleError('RECOVERY_OWNER_MISMATCH');
  if(!eq(e.asset,d.asset))throw new CapsuleError('RECOVERY_DEPLOYMENT_MISMATCH');
  const context=contextHash(e),preparation=preparationHash(context,committeeHash(d.committee));
  if(!eq(purchaseEvidenceHash(p.evidence),e.purchaseEvidenceCommitment)||!eq(p.preparationHash,preparation))throw new CapsuleError('RECOVERY_CONTEXT_MISMATCH');
  // Time zero checks the original permission's structural deadline bounds, without
  // rejecting funded/paid historical orders just because their signatures expired.
  // It never re-enables submission, even for an unregistered order.
  let expected;
  try {
    expected=await compileGrant({policy:p.policy,intent:e,quote:p.quote,receipt:p.receipt,authenticatedOwner:e.buyer,
      deployment:{chainId:d.chainId,arbiter:d.arbiter,reviewer:d.reviewer,committee:d.committee},
      executor:d.executor,nonce:p.grant.nonce,deadline:p.grant.deadline,now:0n});
  }catch{throw new CapsuleError('RECOVERY_AUTHORIZATION_INVALID');}
  for(const key of Object.keys(expected) as (keyof typeof expected)[]) {
    const actual=p.grant[key],value=expected[key];
    if(typeof value==='string'&&typeof actual==='string'? !eq(actual,value):actual!==value)throw new CapsuleError('RECOVERY_GRANT_MISMATCH');
  }
  if(!await verifyGrantSignature(p.grant,p.ownerSignature as Hex))throw new CapsuleError('RECOVERY_OWNER_SIGNATURE_INVALID');
  return p;
}
export async function recoverAuthorization(input:unknown,authenticatedWallets:readonly string[],deployment:RecoveryDeployment,reader:RecoveryReader) {
  const d=RecoveryDeploymentSchema.parse(deployment),p=await verifyOriginalAuthorization(input,authenticatedWallets,d),e=p.intent,context=contextHash(e);
  let order:OrderSnapshot;
  try{order=OrderSnapshotSchema.parse(await reader.read(e.orderId)) as OrderSnapshot;}catch{throw new CapsuleError('RECOVERY_CHAIN_UNAVAILABLE');}
  try{order=checkOriginalOrderReadSnapshot(originalOrderReadProof(p),order);}catch{throw new CapsuleError('RECOVERY_CHAIN_MISMATCH');}
  return {orderId:e.orderId,contextHash:context,order,
    continuation:order.state==='UNREGISTERED'?'NOT_FUNDED':order.state.startsWith('ALLOCATED_')?'VIEW_ALLOCATION':'CONTINUE_ORIGINAL_ORDER',
    canSubmitPayment:false as const};
}
