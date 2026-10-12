import {z} from 'zod';
import {address,digest,uint,positiveUint} from './schemas.js';
import {encodeFunctionData,keccak256,toHex,type Hex} from 'viem';
import {AuthorizationPayloadSchema} from '../../capsule/src/format.js';
import {intentMessage} from './index.js';
import {grantTypedData} from './typed-data.js';
import {escrowAbi} from './escrow-abi.js';
export const FundingAnchorSchema=z.object({chainId:positiveUint,arbiter:address,asset:address,owner:address,executor:address,orderId:digest,contextHash:digest,nonce:uint,amount:positiveUint,calldataHash:digest}).strict();
export type FundingAnchor=z.infer<typeof FundingAnchorSchema>;
/** Canonical submit only. All signatures/evidence must be verified by the worker first. */
export function fundingCalldata(input:unknown):Hex {
  const p=AuthorizationPayloadSchema.parse(input),r=p.receipt,q=p.quote;
  const receipt={schemaVersion:BigInt(r.schemaVersion),contextHash:r.contextHash,purchaseEvidenceCommitment:r.purchaseEvidenceCommitment,policyHash:r.policyHash,reviewer:r.reviewer,
    modelIdHash:keccak256(toHex(r.modelId)),questionConfigHash:r.questionConfigHash,decisionHash:keccak256(toHex(r.decision)),expiresAt:BigInt(r.expiresAt)};
  const quote={schemaVersion:BigInt(q.schemaVersion),quoteId:q.quoteId,serviceHash:keccak256(toHex(q.service)),seller:q.seller,payee:q.payee,asset:q.asset,amount:BigInt(q.amount),serviceTermsHash:q.serviceTermsHash,expiresAt:BigInt(q.expiresAt)};
  return encodeFunctionData({abi:escrowAbi,functionName:'submit',args:[intentMessage(p.intent),receipt,r.signature,grantTypedData(p.grant).message,p.ownerSignature,quote,q.signature] as never});
}
