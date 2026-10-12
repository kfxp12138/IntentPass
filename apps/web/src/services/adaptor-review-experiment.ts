import {randomBytes} from 'node:crypto';
import {privateKeyToAccount} from 'viem/accounts';
import {verifyTypedData,type Hex} from 'viem';
import {ReviewService} from './review.js';
import {aggregateJev,questionConfigHash,type JevPort} from '../../../../packages/adapters/src/jev-review.js';
import {NativeEcdsaAdaptor} from '../../../../packages/adapters/src/ecdsa-adaptor.js';
import type {Principal} from '../../../../packages/adapters/src/privy-auth.js';
import type {EscrowDeployment} from '../../../../packages/protocol/src/escrow-read.js';
import {ReviewRequestSchema} from '../../../../packages/protocol/src/purchase-api.js';
import {verifyQuoteSignature} from '../../../../packages/protocol/src/typed-data.js';
import {AdaptorCertificateSchema,adaptorCandidateHash,candidateRequestBinding,candidateTypedData,preSignatureHash,reviewEvaluationHash,releaseTypedData,type AdaptorCertificate,type AdaptorCandidate} from '../../../../packages/protocol/src/adaptor-review.js';
import {AdaptorSessionStore,type AdaptorSession} from '../../../../packages/storage/src/adaptor-session-store.js';
import type {ReviewJournal} from '../../../../packages/storage/src/review-journal.js';

export interface AdaptorTrust {
  chainId:string;arbiter:string;modelId:string;questionConfigHash:string;minConfidence:number;
  preSigner:string;preSignerPublicKey:Hex;attestor:string;
}
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const randomHash=()=>('0x'+randomBytes(32).toString('hex')) as Hex;
function matchesRequest(c:AdaptorCandidate,input:unknown){const bound=candidateRequestBinding(input);return Object.entries(bound).every(([k,v])=>eq(String(c[k as keyof AdaptorCandidate]),v));}

/** Verifies BOTH signatures, the pre-signature, witness extractability and exact
 * recorded evaluation. Does not authorize funds or attest to model correctness.
 * Trust anchors must come from configuration, never from the certificate.
 */
export async function verifyAdaptorCertificate(input:unknown,request:unknown,trust:AdaptorTrust,native:NativeEcdsaAdaptor,now:bigint){
  try{
    const p=AdaptorCertificateSchema.parse(input),c=p.candidate,r=p.release,e=p.evaluation,q=ReviewRequestSchema.parse(request);
    if(!matchesRequest(c,q)||!eq(c.chainId,trust.chainId)||!eq(c.arbiter,trust.arbiter)||c.modelId!==trust.modelId||!eq(c.questionConfigHash,trust.questionConfigHash)||!eq(c.preSigner,trust.preSigner)||!eq(c.attestor,trust.attestor)
      ||now<BigInt(c.createdAt)||now>=BigInt(c.expiresAt)||BigInt(c.expiresAt)>BigInt(c.createdAt)+300n
      ||BigInt(c.expiresAt)>BigInt(q.quote.expiresAt)||BigInt(c.expiresAt)>BigInt(q.intent.deliveryDeadline))return false;
    if(e.source!=='JEV'||e.executable||e.code!==undefined||e.decision!=='PASS'||e.modelId!==c.modelId||!eq(e.questionConfigHash,c.questionConfigHash)
      ||aggregateJev({model:e.modelId,answers:e.answers,usage:e.usage},trust.minConfidence)!=='PASS')return false;
    if(!eq(r.candidateHash,adaptorCandidateHash(c))||!eq(r.preSignatureHash,preSignatureHash(p.preSignature))||!eq(r.evaluationHash,reviewEvaluationHash(e))||r.expiresAt!==c.expiresAt
      ||BigInt(r.evaluatedAt)<BigInt(c.createdAt)||BigInt(r.evaluatedAt)>now||BigInt(r.evaluatedAt)>=BigInt(c.expiresAt))return false;
    if(!await verifyQuoteSignature(q.quote,{chainId:c.chainId,arbiter:c.arbiter})||!native.verify(trust.preSignerPublicKey,adaptorCandidateHash(c),c.adaptorPoint,p.preSignature))return false;
    if(!await verifyTypedData({...candidateTypedData(c),address:trust.preSigner as Hex,signature:p.completedSignature as Hex})
      ||!await verifyTypedData({...releaseTypedData(r,c),address:trust.attestor as Hex,signature:p.releaseSignature as Hex}))return false;
    const witness=native.extract(c.adaptorPoint,p.preSignature,p.completedSignature);
    return eq(native.publicKey(witness),c.adaptorPoint);
  }catch{return false;}
}

/** Opt-in local laboratory, not wired into configured HTTP/Privy/checkout.
 * Reuses the real ReviewService hard-rule/aggregation/journal flow. A fixture
 * provider remains a fixture; a real provider is not implied by this class.
 */
export class AdaptorReviewExperiment {
  readonly trust:AdaptorTrust;
  private readonly review:ReviewService;
  private readonly witnesses=new Map<string,Buffer>();
  private readonly attestor;
  constructor(private readonly config:{preSignerKey:Hex;attestorKey:Hex;jev:JevPort;deployment:EscrowDeployment;minConfidence:number;reviewJournal:ReviewJournal;store:AdaptorSessionStore;native:NativeEcdsaAdaptor;clock:()=>bigint}){
    if(eq(config.preSignerKey,config.attestorKey))throw Error('ADAPTOR_ROLE_KEY_SEPARATION_REQUIRED');
    this.attestor=privateKeyToAccount(config.attestorKey);
    this.trust={chainId:config.deployment.chainId,arbiter:config.deployment.arbiter,modelId:config.jev.model,questionConfigHash:questionConfigHash(config.minConfidence,config.jev.questionVersion??1),minConfidence:config.minConfidence,preSigner:privateKeyToAccount(config.preSignerKey).address,preSignerPublicKey:config.native.publicKey(config.preSignerKey),attestor:this.attestor.address};
    // No conventional receipt signer: this experiment cannot issue a spendable receipt.
    this.review=new ReviewService(config.jev,config.deployment,config.minConfidence,undefined,config.clock,config.reviewJournal);
  }
  prepare(input:unknown,principal:Principal){
    const q=ReviewRequestSchema.parse(input),binding=candidateRequestBinding(q),now=this.config.clock();
    if(!principal.wallets.some(w=>eq(w,q.intent.buyer)))throw Error('ADAPTOR_OWNER_MISMATCH');
    if(!eq(binding.chainId,this.trust.chainId)||!eq(binding.arbiter,this.trust.arbiter))throw Error('ADAPTOR_DEPLOYMENT_MISMATCH');
    const expiresAt=[now+300n,BigInt(q.quote.expiresAt),BigInt(q.intent.deliveryDeadline)].reduce((a,b)=>a<b?a:b);
    if(now<0n||expiresAt<=now)throw Error('ADAPTOR_SESSION_EXPIRED');
    // Only new experiment keys. No .env, wallet key export or arbitrary RPC.
    let witness:Buffer,point:Hex;
    for(;;){witness=randomBytes(32);try{point=this.config.native.publicKey('0x'+witness.toString('hex'));break;}catch{witness.fill(0);throw Error('ADAPTOR_WITNESS_GENERATION_FAILED');}}
    try{
      const candidate:AdaptorCandidate={schemaVersion:1,sessionId:randomHash(),...binding,modelId:this.trust.modelId,questionConfigHash:this.trust.questionConfigHash,preSigner:this.trust.preSigner,attestor:this.trust.attestor,adaptorPoint:point,requiredDecision:'PASS',createdAt:String(now),expiresAt:String(expiresAt)};
      const preSignature=this.config.native.preSign(this.config.preSignerKey,adaptorCandidateHash(candidate),point);
      if(!this.config.native.verify(this.trust.preSignerPublicKey,adaptorCandidateHash(candidate),point,preSignature))throw Error('ADAPTOR_PRESIGNATURE_INVALID');
      const session:AdaptorSession={candidate,preSignature,state:'PREPARED'};this.config.store.reserve(session);
      this.witnesses.set(candidate.sessionId,witness);return structuredClone(session);
    }catch(error){witness.fill(0);throw error;}
  }
  async complete(id:string,input:unknown,principal:Principal){
    const q=ReviewRequestSchema.parse(input),s=this.config.store.get(id),now=this.config.clock();
    if(!s||!matchesRequest(s.candidate,q))throw Error('ADAPTOR_ORIGINAL_CONTEXT_REQUIRED');
    if(!principal.wallets.some(w=>eq(w,q.intent.buyer)))throw Error('ADAPTOR_OWNER_MISMATCH');
    if(now<BigInt(s.candidate.createdAt)||now>=BigInt(s.candidate.expiresAt))throw Error('ADAPTOR_SESSION_EXPIRED');
    if(s.state==='COMPLETE'){
      if(!await verifyAdaptorCertificate(s.certificate,q,this.trust,this.config.native,now))throw Error('ADAPTOR_RECORDED_CERTIFICATE_INVALID');
      return s;
    }
    if(s.state==='STOPPED')return s;
    const witness=this.witnesses.get(s.candidate.sessionId);
    if(s.state!=='PREPARED'||!witness)throw Error('ADAPTOR_ORIGINAL_SESSION_RECONCILIATION_REQUIRED');
    // Persist the lease before any provider call or release. A crash never retries it.
    this.config.store.claim(s.candidate.sessionId);
    try{
      const evaluation=await this.review.review(q,principal),at=this.config.clock();
      if(at<now||at>=BigInt(s.candidate.expiresAt))throw Error('ADAPTOR_SESSION_EXPIRED');
      if(evaluation.source!=='JEV'||evaluation.executable||evaluation.code!==undefined||evaluation.decision!=='PASS'){
        const stopped:AdaptorSession={...s,state:'STOPPED',review:evaluation};this.config.store.finish(s.candidate.sessionId,stopped);return stopped;
      }
      if(evaluation.modelId!==this.trust.modelId||!eq(evaluation.questionConfigHash,this.trust.questionConfigHash)||aggregateJev({model:evaluation.modelId,answers:evaluation.answers,usage:evaluation.usage},this.trust.minConfidence)!=='PASS')throw Error('ADAPTOR_REVIEW_BINDING_INVALID');
      const release={schemaVersion:1 as const,candidateHash:adaptorCandidateHash(s.candidate),preSignatureHash:preSignatureHash(s.preSignature),evaluationHash:reviewEvaluationHash(evaluation),decision:'PASS' as const,evaluatedAt:String(at),expiresAt:s.candidate.expiresAt};
      // This second signature binds previously unknown JEV answers to the PREPARED
      // session. It is required by the verifier; the completed signature alone
      // does not commit to the later result and is never accepted by this flow.
      const releaseSignature=await this.attestor.signTypedData(releaseTypedData(release,s.candidate));
      const completedSignature=this.config.native.complete(this.trust.preSignerPublicKey,release.candidateHash,s.candidate.adaptorPoint,s.preSignature,'0x'+witness.toString('hex'));
      const certificate:AdaptorCertificate={kind:'experimental-offchain-adaptor-review',candidate:s.candidate,preSignature:s.preSignature,completedSignature,release,releaseSignature,evaluation};
      if(!await verifyAdaptorCertificate(certificate,q,this.trust,this.config.native,this.config.clock()))throw Error('ADAPTOR_COMPLETED_CERTIFICATE_INVALID');
      const completed:AdaptorSession={...s,state:'COMPLETE',review:evaluation,certificate};this.config.store.finish(s.candidate.sessionId,completed);return completed;
    }finally{witness.fill(0);this.witnesses.delete(s.candidate.sessionId);}
  }
  async acceptOnce(id:string,input:unknown,principal:Principal){const session=await this.complete(id,input,principal);if(session.state!=='COMPLETE')throw Error('ADAPTOR_CERTIFICATE_REQUIRED');this.config.store.consume(session.candidate.sessionId);return session.certificate!;}
  dispose(){for(const w of this.witnesses.values())w.fill(0);this.witnesses.clear();}
}
