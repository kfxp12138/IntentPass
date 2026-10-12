import {z} from 'zod';
import {hashStruct,hashTypedData,keccak256,type Hex} from 'viem';
import {address,digest,uint,positiveUint} from './schemas.js';
import {ReviewRequestSchema,ReviewResultSchema} from './purchase-api.js';
import {contextHash} from './index.js';
import {policyHash,quoteSigningHash} from './typed-data.js';
import {purchaseEvidenceHash} from './review-evidence.js';

export const AdaptorPointSchema=z.string().regex(/^0x0[23][a-fA-F0-9]{64}$/);
export const PreSignatureSchema=z.string().regex(/^0x[a-fA-F0-9]{324}$/);
const signature=z.string().regex(/^0x[a-fA-F0-9]{128}(1b|1c)$/);
/** A separate domain: this certificate cannot serve as an escrow Receipt or Grant. */
export const AdaptorCandidateSchema=z.object({
  schemaVersion:z.literal(1),sessionId:digest,chainId:positiveUint,arbiter:address,
  orderId:digest,contextHash:digest,policyHash:digest,evidenceCommitment:digest,quoteHash:digest,
  modelId:z.string().min(1).max(128),questionConfigHash:digest,
  preSigner:address,attestor:address,adaptorPoint:AdaptorPointSchema,
  requiredDecision:z.literal('PASS'),createdAt:uint,expiresAt:positiveUint,
}).strict();
export type AdaptorCandidate=z.infer<typeof AdaptorCandidateSchema>;
export const AdaptorReleaseSchema=z.object({schemaVersion:z.literal(1),candidateHash:digest,
  preSignatureHash:digest,evaluationHash:digest,decision:z.literal('PASS'),evaluatedAt:uint,expiresAt:positiveUint,
}).strict();
export const AdaptorCertificateSchema=z.object({
  kind:z.literal('experimental-offchain-adaptor-review'),candidate:AdaptorCandidateSchema,
  preSignature:PreSignatureSchema,completedSignature:signature,release:AdaptorReleaseSchema,
  releaseSignature:signature,evaluation:ReviewResultSchema,
}).strict();
export type AdaptorCertificate=z.infer<typeof AdaptorCertificateSchema>;
const fields=(pairs:[string,string][])=>pairs.map(([name,type])=>({name,type}));
const candidateTypes={AdaptorCandidate:fields([
  ['schemaVersion','uint256'],['sessionId','bytes32'],['orderId','bytes32'],['contextHash','bytes32'],
  ['policyHash','bytes32'],['evidenceCommitment','bytes32'],['quoteHash','bytes32'],['modelId','string'],
  ['questionConfigHash','bytes32'],['preSigner','address'],['attestor','address'],['adaptorPoint','bytes'],
  ['requiredDecision','string'],['createdAt','uint256'],['expiresAt','uint256'],
])};
const releaseTypes={AdaptorRelease:fields([
  ['schemaVersion','uint256'],['candidateHash','bytes32'],['preSignatureHash','bytes32'],
  ['evaluationHash','bytes32'],['decision','string'],['evaluatedAt','uint256'],['expiresAt','uint256'],
])};
function message(value:Record<string,unknown>,members:{name:string;type:string}[]){return Object.fromEntries(members.map(({name,type})=>[name,type==='uint256'?BigInt(String(value[name])):value[name]]));}
function domain(name:string,c:AdaptorCandidate){return {name:`IntentPass.${name}`,version:'1',chainId:BigInt(c.chainId),verifyingContract:c.arbiter as Hex};}
export function candidateTypedData(input:unknown){const c=AdaptorCandidateSchema.parse(input);return {domain:domain('AdaptorCandidate',c),types:candidateTypes,primaryType:'AdaptorCandidate' as const,message:message(c,candidateTypes.AdaptorCandidate)};}
export function adaptorCandidateHash(input:unknown){return hashTypedData(candidateTypedData(input));}
export function releaseTypedData(input:unknown,candidate:unknown){const r=AdaptorReleaseSchema.parse(input),c=AdaptorCandidateSchema.parse(candidate);return {domain:domain('AdaptorRelease',c),types:releaseTypes,primaryType:'AdaptorRelease' as const,message:message(r,releaseTypes.AdaptorRelease)};}
export function candidateRequestBinding(input:unknown){
  const r=ReviewRequestSchema.parse(input),e=r.intent;
  const {signature:_signature,...unsignedQuote}=r.quote;
  if(r.evidence.schemaVersion!==2||e.policyHash.toLowerCase()!==policyHash(r.policy).toLowerCase()||e.purchaseEvidenceCommitment.toLowerCase()!==purchaseEvidenceHash(r.evidence).toLowerCase())throw Error('ADAPTOR_INPUT_COMMITMENT_MISMATCH');
  return {chainId:e.chainId,arbiter:e.arbiter,orderId:e.orderId,contextHash:contextHash(e),policyHash:policyHash(r.policy),evidenceCommitment:purchaseEvidenceHash(r.evidence),quoteHash:quoteSigningHash(unsignedQuote,{chainId:e.chainId,arbiter:e.arbiter})};
}
/** Exact binary64, network byte order, normalized zero. No decimal rounding. */
function float(value:number):Hex{const b=new Uint8Array(8);new DataView(b.buffer).setFloat64(0,value===0?0:value,false);return ('0x'+Array.from(b,n=>n.toString(16).padStart(2,'0')).join('')) as Hex;}
export function reviewEvaluationHash(input:unknown):Hex{
  const r=ReviewResultSchema.parse(input);if(r.source!=='JEV'||r.executable||r.code!==undefined)throw Error('ADAPTOR_EVALUATION_INVALID');
  const answerTypes={ReviewAnswer:fields([['type','string'],['choice','string'],['confidence','bytes8'],['supported','bytes8'],['contradicted','bytes8'],['insufficient','bytes8']])};
  const hashes=(['service','purpose','provenance'] as const).map(k=>{const a=r.answers[k];return hashStruct({types:answerTypes,primaryType:'ReviewAnswer',data:{type:a.type,choice:a.choice,confidence:float(a.confidence),supported:float(a.probabilities.SUPPORTED),contradicted:float(a.probabilities.CONTRADICTED),insufficient:float(a.probabilities.INSUFFICIENT)}});});
  return hashStruct({types:{ReviewEvaluation:fields([['schemaVersion','uint256'],['modelId','string'],['questionConfigHash','bytes32'],['decision','string'],['service','bytes32'],['purpose','bytes32'],['provenance','bytes32'],['inputTokens','uint256'],['outputTokens','uint256']])},primaryType:'ReviewEvaluation',data:{schemaVersion:1n,modelId:r.modelId,questionConfigHash:r.questionConfigHash,decision:r.decision,service:hashes[0],purpose:hashes[1],provenance:hashes[2],inputTokens:BigInt(r.usage.input_tokens),outputTokens:BigInt(r.usage.output_tokens)}});
}
export function preSignatureHash(pre:unknown){return keccak256(PreSignatureSchema.parse(pre) as Hex);}
