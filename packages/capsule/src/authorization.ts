import {z} from 'zod';
import type {Hex} from 'viem';
import {ReviewRequestSchema,ReviewResultSchema} from '../../protocol/src/purchase-api.js';
import {address,digest} from '../../protocol/src/schemas.js';
import {compileGrant,grantTypedData,purchaseEvidenceHash,verifyGrantSignature} from '../../protocol/src/index.js';
import {aggregateJev,questionConfigHash} from '../../adapters/src/jev-review.js';
import {RecoveryDeploymentSchema,type RecoveryDeployment} from './recovery.js';
import {AuthorizationPayloadSchema} from './format.js';

export const AuthorizationRuleSchema=z.object({model:z.string().regex(/^jev-\d+\.\d+\.\d+$/),minConfidence:z.number().min(0).max(1),questionConfigHash:digest,questionVersion:z.union([z.literal(1),z.literal(2)]).optional()}).strict();
const UnsignedAuthorizationSchema=AuthorizationPayloadSchema.omit({ownerSignature:true});
export type UnsignedAuthorization=z.infer<typeof UnsignedAuthorizationSchema>;
export interface AuthorizationContext {
  authenticatedWallets:readonly string[];
  deployment:RecoveryDeployment;
  rule:z.infer<typeof AuthorizationRuleSchema>;
  now:bigint;
}
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
function freeze<T>(value:T):T {
  if(value&&typeof value==='object') {for(const item of Object.values(value))freeze(item);Object.freeze(value);}
  return value;
}
async function validateUnsigned(input:unknown,context:AuthorizationContext) {
  const p=UnsignedAuthorizationSchema.parse(input),d=RecoveryDeploymentSchema.parse(context.deployment),rule=AuthorizationRuleSchema.parse(context.rule);
  if(rule.questionConfigHash!==questionConfigHash(rule.minConfidence,rule.questionVersion??1)||p.receipt.modelId!==rule.model||p.receipt.questionConfigHash!==rule.questionConfigHash)throw new Error('AUTHORIZATION_RULE_MISMATCH');
  if(!context.authenticatedWallets.some(w=>eq(address.parse(w),p.intent.buyer)))throw new Error('AUTHORIZATION_OWNER_MISMATCH');
  if(!eq(p.intent.asset,d.asset)||!eq(purchaseEvidenceHash(p.evidence),p.intent.purchaseEvidenceCommitment))throw new Error('AUTHORIZATION_CONTEXT_MISMATCH');
  if(BigInt(p.receipt.expiresAt)>BigInt(p.quote.expiresAt)||BigInt(p.receipt.expiresAt)>BigInt(p.intent.deliveryDeadline))throw new Error('AUTHORIZATION_RECEIPT_BOUNDS_INVALID');
  // Equality at expiry is too late for a new permission, unlike historical recovery.
  if(context.now<0n||BigInt(p.grant.deadline)<=context.now||BigInt(p.quote.expiresAt)<=context.now||BigInt(p.receipt.expiresAt)<=context.now)throw new Error('AUTHORIZATION_EXPIRED');
  const expected=await compileGrant({policy:p.policy,intent:p.intent,quote:p.quote,receipt:p.receipt,authenticatedOwner:p.intent.buyer,
    deployment:{chainId:d.chainId,arbiter:d.arbiter,reviewer:d.reviewer,committee:d.committee},executor:d.executor,nonce:p.grant.nonce,deadline:p.grant.deadline,now:context.now});
  for(const key of Object.keys(expected) as (keyof typeof expected)[]) {
    const actual=p.grant[key],value=expected[key];
    if(typeof value==='string'&&typeof actual==='string'?!eq(actual,value):actual!==value)throw new Error('AUTHORIZATION_GRANT_MISMATCH');
  }
  if(!eq(p.preparationHash,expected.preparationHash))throw new Error('AUTHORIZATION_PREPARATION_MISMATCH');
  return p;
}

/** Pure permission preparation. Nonce is a candidate, not an issued or reserved nonce.
 * No chain read, signer, allowance, transaction sender or secret persistence here.
 */
export async function prepareAuthorization(input:{request:unknown;review:unknown;nonce:string;deadline:string},context:AuthorizationContext) {
  const request=ReviewRequestSchema.parse(input.request),review=ReviewResultSchema.parse(input.review),rule=AuthorizationRuleSchema.parse(context.rule);
  if(review.source!=='JEV'||review.decision!=='PASS'||!review.executable)throw new Error('EXECUTABLE_PASS_REQUIRED');
  if(review.modelId!==rule.model||review.questionConfigHash!==rule.questionConfigHash||aggregateJev({model:review.modelId,answers:review.answers,usage:review.usage},rule.minConfidence)!=='PASS')throw new Error('AUTHORIZATION_RULE_MISMATCH');
  const d=RecoveryDeploymentSchema.parse(context.deployment);
  const grant=await compileGrant({...request,receipt:review.receipt,authenticatedOwner:request.intent.buyer,
    deployment:{chainId:d.chainId,arbiter:d.arbiter,reviewer:d.reviewer,committee:d.committee},executor:d.executor,nonce:input.nonce,deadline:input.deadline,now:context.now});
  const payload=await validateUnsigned({schemaVersion:1,kind:'authorization',...request,receipt:review.receipt,grant,preparationHash:grant.preparationHash},context);
  return freeze({payload,typedData:grantTypedData(payload.grant),chainStatusChecked:false as const,canSubmitPayment:false as const});
}

/** Verify a wallet-returned signature and recheck expiry/account/config before encryption.
 * Success does not prove nonce availability, registration, eligibility or allowance.
 */
export async function finalizeAuthorization(input:unknown,ownerSignature:string,context:AuthorizationContext) {
  // Parse into a private copy before any asynchronous signature verification.
  const signed=AuthorizationPayloadSchema.parse({...UnsignedAuthorizationSchema.parse(input),ownerSignature});
  const {ownerSignature:signature,...unsigned}=signed;
  await validateUnsigned(unsigned,context);
  if(!await verifyGrantSignature(signed.grant,signature as Hex))throw new Error('AUTHORIZATION_OWNER_SIGNATURE_INVALID');
  return freeze({payload:signed,chainStatusChecked:false as const,canSubmitPayment:false as const});
}
