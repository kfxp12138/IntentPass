import {verifyTypedData,type Hex} from 'viem';
import {AdaptorCertificateSchema,adaptorCandidateHash,candidateRequestBinding,candidateTypedData,preSignatureHash,reviewEvaluationHash,releaseTypedData} from './adaptor-review.js';
import {ReviewRequestSchema} from './purchase-api.js';
import {verifyQuoteSignature} from './typed-data.js';
import {aggregateJev} from '../../adapters/src/jev-review.js';

export interface RecordingTrust {chainId:string;arbiter:string;modelId:string;questionConfigHash:string;preSigner:string;attestor:string;minConfidence:number;}
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
/** Browser inspection of a historical transcript's EIP-712 bindings only.
 * NOT an authorization verifier: it uses recorded time and does not verify the
 * native adaptor proof, provider execution, local consumption or current expiry.
 */
export async function inspectRecordedBindings(proof:unknown,request:unknown,trust:RecordingTrust):Promise<boolean>{
  try{
    const p=AdaptorCertificateSchema.parse(proof),q=ReviewRequestSchema.parse(request),c=p.candidate,r=p.release,e=p.evaluation;
    if(!Object.entries(candidateRequestBinding(q)).every(([key,value])=>eq(String(c[key as keyof typeof c]),value)))return false;
    if(!eq(c.chainId,trust.chainId)||!eq(c.arbiter,trust.arbiter)||!eq(c.preSigner,trust.preSigner)||!eq(c.attestor,trust.attestor)||c.modelId!==trust.modelId||!eq(c.questionConfigHash,trust.questionConfigHash))return false;
    if(e.source!=='JEV'||e.executable||e.code!==undefined||e.decision!=='PASS'||e.modelId!==trust.modelId||!eq(e.questionConfigHash,trust.questionConfigHash)||aggregateJev({model:e.modelId,answers:e.answers,usage:e.usage},trust.minConfidence)!=='PASS')return false;
    if(!eq(r.candidateHash,adaptorCandidateHash(c))||!eq(r.preSignatureHash,preSignatureHash(p.preSignature))||!eq(r.evaluationHash,reviewEvaluationHash(e))||r.expiresAt!==c.expiresAt)return false;
    if(BigInt(r.evaluatedAt)<BigInt(c.createdAt)||BigInt(r.evaluatedAt)>=BigInt(c.expiresAt)||BigInt(c.expiresAt)>BigInt(c.createdAt)+300n||BigInt(c.expiresAt)>BigInt(q.quote.expiresAt)||BigInt(c.expiresAt)>BigInt(q.intent.deliveryDeadline))return false;
    return await verifyQuoteSignature(q.quote,{chainId:c.chainId,arbiter:c.arbiter})
      &&await verifyTypedData({...candidateTypedData(c),address:trust.preSigner as Hex,signature:p.completedSignature as Hex})
      &&await verifyTypedData({...releaseTypedData(r,c),address:trust.attestor as Hex,signature:p.releaseSignature as Hex});
  }catch{return false;}
}
