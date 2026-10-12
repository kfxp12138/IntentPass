import type {PurchaseFlow} from './purchase-flow.js';
import {authorizationDeadline,candidateNonce} from './authorization-preview.js';
import type {AssetApprovalFlow} from './asset-approval-flow.js';
import type {OriginalFundingFlow} from './original-funding-flow.js';
import {AuthorizationPayloadSchema} from '../../../packages/capsule/src/format.js';
import {PreflightResultSchema} from '../../../packages/protocol/src/purchase-preflight.js';

export type PreparationPhase='CANDIDATE'|'DEVICE'|'REVIEW'|'RECEIPT'|'PERMISSION'|'PREFLIGHT';
/** Uses the original flow and its persistent server review journal. An expired
 * receipt is renewed only with explicit readiness. No user signer, task revision,
 * allowance or payment is available here. */
export class AutomaticPreparation {
  private running:Promise<'READY'|'REVIEW_STOPPED'|'CHAIN_BLOCKED'|'RECEIPT_EXPIRED'>|undefined;
  private proposalUnknown=false;
  constructor(private flow:PurchaseFlow,private clock=()=>BigInt(Math.floor(Date.now()/1000)),private beforeReview?:()=>Promise<void>){}
  run(refs:string[],seconds:string,progress:(phase:PreparationPhase)=>void=()=>{},renewReceipt=false){
    if(this.running)return this.running;
    if(this.proposalUnknown)return Promise.reject(Error('PROPOSAL_OUTCOME_RECONCILIATION_REQUIRED'));
    const operation=this.prepare(refs,seconds,progress,renewReceipt);this.running=operation;
    void operation.catch(()=>{if(!this.flow.draft)this.proposalUnknown=true;});
    void operation.finally(()=>{if(this.running===operation)this.running=undefined;}).catch(()=>{});return operation;
  }
  private async prepare(refs:string[],seconds:string,progress:(phase:PreparationPhase)=>void,renewReceipt:boolean){
    if(this.flow.authorizationLocked)throw Error('ORIGINAL_AUTHORIZATION_ALREADY_SIGNED');
    if(!this.flow.draft){progress('CANDIDATE');const catalog=await this.flow.catalog();const proposed=await this.flow.propose(refs.length?refs:catalog.entries.slice(0,5).map(x=>x.quote.quoteId));if(proposed.status!=='DRAFT')return 'REVIEW_STOPPED' as const;}
    if(this.beforeReview){progress('DEVICE');await this.beforeReview();}
    if(!this.flow.reviewResult){progress('REVIEW');if(this.flow.canReview)await this.flow.review();else await this.flow.recoverReceipt(false);}
    let review=this.flow.reviewResult;
    if(!review||review.source!=='JEV'||review.decision!=='PASS'||!review.executable)return 'REVIEW_STOPPED' as const;
    if(this.clock()>=BigInt(review.receipt.expiresAt)){
      if(!renewReceipt||!this.flow.draft||this.clock()>=BigInt(this.flow.draft.intent.deliveryDeadline))return 'RECEIPT_EXPIRED' as const;
      progress('RECEIPT');const result=await this.flow.recoverReceipt(true);review=this.flow.reviewResult;
      if(result.status!=='SIGNED'||!review||review.source!=='JEV'||!review.executable||this.clock()>=BigInt(review.receipt.expiresAt))return 'RECEIPT_EXPIRED' as const;
    }
    progress('PERMISSION');
    if(!this.flow.authorization)await this.flow.prepare(candidateNonce(),authorizationDeadline(this.flow.draft,this.flow.reviewResult,seconds,this.clock()));
    progress('PREFLIGHT');const observed=await this.flow.preflight();
    return 'status'in observed||observed.blockers.some(x=>x!=='EXACT_ALLOWANCE_REQUIRED')?'CHAIN_BLOCKED' as const:'READY' as const;
  }
}

export type PaymentPhase='CHECKING'|'APPROVING'|'APPROVAL_CONFIRMATION'|'FUNDING'|'FUNDING_CONFIRMATION';
export type AutomaticPaymentResult={status:'CONFIRMED'|'ATTENTION'|'EXPIRED'|'BLOCKED';funding?:Awaited<ReturnType<OriginalFundingFlow['reconcile']>>;};
/** One explicit payment action. Sends each original step at most once; waiting
 * only reconciles the original hashes. Unknown outcomes never acquire a new slot. */
export class AutomaticPayment {
  private started=false;
  private running:Promise<AutomaticPaymentResult>|undefined;
  constructor(private input:unknown,private approval:AssetApprovalFlow,private funding:OriginalFundingFlow,
    private preflight:()=>Promise<unknown>,private clock=()=>BigInt(Math.floor(Date.now()/1000)),
    private wait:()=>Promise<void>=()=>new Promise(resolve=>setTimeout(resolve,2500)),private maxQueries=20){if(!Number.isSafeInteger(maxQueries)||maxQueries<1||maxQueries>40)throw Error('AUTOMATION_QUERY_LIMIT_INVALID');}
  get hasStarted(){return this.started;}
  run(confirmation:boolean,active:()=>void=()=>{},progress:(phase:PaymentPhase)=>void=()=>{}){
    if(!confirmation)return Promise.reject(Error('AUTOMATIC_PAYMENT_CONFIRMATION_REQUIRED'));
    if(this.running)return this.running;
    if(this.started)return Promise.resolve({status:'ATTENTION'} as AutomaticPaymentResult);
    this.started=true;const operation=this.pay(active,progress);this.running=operation;
    void operation.finally(()=>{if(this.running===operation)this.running=undefined;}).catch(()=>{});return operation;
  }
  private async pay(active:()=>void,progress:(phase:PaymentPhase)=>void):Promise<AutomaticPaymentResult>{
    const p=AuthorizationPayloadSchema.parse(this.input),g=p.grant,current=()=>{active();return this.clock()<BigInt(g.deadline);};
    if(!current())return {status:'EXPIRED'};progress('CHECKING');
    const s=PreflightResultSchema.parse(await this.preflight());active();if('status'in s)return {status:'BLOCKED'};
    if(s.chainId!==g.chainId||s.nonce!==g.nonce||s.amount!==g.amount||s.deadline!==g.deadline||s.block.finality!=='finalized'||
      ([['arbiter',g.arbiter],['asset',g.asset],['buyer',g.owner],['orderId',g.orderId],['contextHash',g.contextHash]] as const).some(([k,v])=>s[k].toLowerCase()!==v.toLowerCase()))throw Error('PREFLIGHT_RESPONSE_MISMATCH');
    if(s.blockers.some(x=>x!=='EXACT_ALLOWANCE_REQUIRED')||s.allowance!=='0'&&s.allowance!==g.amount)return {status:'BLOCKED'};
    if(s.allowance!==g.amount){
      if(!current())return {status:'EXPIRED'};progress('APPROVING');const sent=await this.approval.approve('SET',active);active();
      const hash='record'in sent?sent.record.hash:sent.hash;if(!hash)return {status:'ATTENTION'};
      let confirmed=false;progress('APPROVAL_CONFIRMATION');
      for(let query=0;query<this.maxQueries;query++){
        const result=await this.approval.reconcile('SET',hash,active);active();
        if(result.receipt.status==='REVERTED')return {status:'ATTENTION'};
        if(result.receipt.status==='CONFIRMED'){if(!result.receipt.exactAllowance)return {status:'ATTENTION'};confirmed=true;break;}
        if(!current())return {status:'EXPIRED'};await this.wait();active();
      }
      if(!confirmed)return {status:'ATTENTION'};
    }
    if(!current())return {status:'EXPIRED'};progress('FUNDING');let result=await this.funding.submit(true,active);active();
    progress('FUNDING_CONFIRMATION');
    for(let query=0;query<this.maxQueries;query++){
      if(result.error||['UNKNOWN','IN_FLIGHT','BLOCKED','REVERTED','IDLE'].includes(result.record.status))return {status:'ATTENTION',funding:result};
      if(result.record.status==='CONFIRMED')return {status:'CONFIRMED',funding:result};
      if(!result.record.hash)return {status:'ATTENTION',funding:result};
      await this.wait();active();result=await this.funding.reconcile(result.record.hash,active);active();
    }
    return {status:'ATTENTION',funding:result};
  }
}
