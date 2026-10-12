import {z} from 'zod';
import {ReceiptRecoveryRequestSchema,ReceiptRecoveryResponseSchema} from '../../../../packages/protocol/src/receipt-recovery.js';
import {ReviewRequestSchema} from '../../../../packages/protocol/src/draft.js';
import {contextHash,policyHash,termsHash,verifyQuoteSignature,verifyReceiptSignature} from '../../../../packages/protocol/src/index.js';
import {purchaseEvidenceHash} from '../../../../packages/protocol/src/review-evidence.js';
import {aggregateJev,questionConfigHash,type ReviewQuestionVersion} from '../../../../packages/adapters/src/jev-review.js';
import type {Principal} from '../../../../packages/adapters/src/privy-auth.js';
import type {ReviewJournal} from '../../../../packages/storage/src/review-journal.js';
import type {ReceiptStore} from '../../../../packages/storage/src/receipt-store.js';
import type {PrivyReceiptSigner} from '../../../../packages/adapters/src/privy-receipt-signer.js';
import type {EscrowDeployment} from '../../../../packages/protocol/src/escrow-read.js';
import {reviewSemanticInput} from './review-key.js';
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export type ReceiptRecoveryGuard=(request:z.infer<typeof ReviewRequestSchema>,expiredAt:bigint)=>Promise<void>;
/** No model port: this service cannot re-evaluate the recorded material. */
export class ReceiptRecoveryService {
  constructor(private journal:ReviewJournal,private store:ReceiptStore,private signer:Pick<PrivyReceiptSigner,'renew'>,private deployment:EscrowDeployment,private rule:{model:string;minConfidence:number;questionConfigHash:string;questionVersion?:ReviewQuestionVersion},private guard:ReceiptRecoveryGuard,private clock=()=>BigInt(Math.floor(Date.now()/1000))){}
  async recover(input:unknown,principal:Principal):Promise<z.infer<typeof ReceiptRecoveryResponseSchema>>{
    const blocked=(code:string)=>({status:'BLOCKED' as const,code}),parsed=ReceiptRecoveryRequestSchema.safeParse(input);if(!parsed.success)return blocked('INPUT_INVALID');
    const r=parsed.data.request,e=r.intent,q=r.quote,p=r.policy,d=this.deployment,now=this.clock(),domain={chainId:d.chainId,arbiter:d.arbiter};
    if(!principal.wallets.some(w=>eq(w,e.buyer)))return blocked('OWNER_MISMATCH');
    if(now<0n||this.rule.questionConfigHash!==questionConfigHash(this.rule.minConfidence,this.rule.questionVersion??1)||e.chainId!==d.chainId||!eq(e.arbiter,d.arbiter))return blocked('RECEIPT_RECOVERY_SCOPE_INVALID');
    if(!eq(policyHash(p),e.policyHash)||!eq(p.taskId,e.taskId)||!eq(p.datasetHash,e.datasetHash)||!eq(p.allowedAsset,e.asset)||!eq(e.asset,d.asset)||!eq(e.reviewer,d.reviewer)||!eq(e.committeeHash,d.committeeHash)||BigInt(e.price)+BigInt(e.bond)>BigInt(p.budget))return blocked('RECEIPT_RECOVERY_CONTEXT_INVALID');
    if(r.evidence.schemaVersion!==2||!eq(purchaseEvidenceHash(r.evidence),e.purchaseEvidenceCommitment)||!eq(q.serviceTermsHash,e.serviceTermsHash)||!eq(termsHash(q.serviceTerms),q.serviceTermsHash)||!eq(q.seller,e.seller)||!eq(q.payee,e.payee)||!eq(q.asset,e.asset)||q.amount!==e.price||!await verifyQuoteSignature(q,domain))return blocked('RECEIPT_RECOVERY_CONTEXT_INVALID');
    const record=this.journal.get(this.journal.key(reviewSemanticInput(r,this.rule.model,this.rule.questionConfigHash))),evaluation=record?.evaluation,result=record?.result;
    if(!record||record.status!=='COMPLETE'||record.contextHash!==contextHash(e)||!evaluation||evaluation.source!=='JEV'||evaluation.decision!=='PASS'||evaluation.modelId!==this.rule.model||evaluation.questionConfigHash!==this.rule.questionConfigHash||aggregateJev({model:evaluation.modelId,answers:evaluation.answers,usage:evaluation.usage},this.rule.minConfidence)!=='PASS'||!result||result.source!=='JEV'||!result.executable)return blocked('RECORDED_EXECUTABLE_PASS_REQUIRED');
    const root=result.receipt;
    if(root.contextHash!==record.contextHash||!eq(root.policyHash,e.policyHash)||!eq(root.purchaseEvidenceCommitment,e.purchaseEvidenceCommitment)||!eq(root.reviewer,d.reviewer)||root.modelId!==this.rule.model||root.questionConfigHash!==this.rule.questionConfigHash||BigInt(root.expiresAt)>BigInt(q.expiresAt)||BigInt(root.expiresAt)>BigInt(e.deliveryDeadline)||!await verifyReceiptSignature(root,domain))return blocked('RECEIPT_RECOVERY_RECORD_INVALID');
    const observe=async()=>{
      const latest=this.store.latestRenewal(domain,root);
      if(latest.status!=='SIGNED')return {status:latest.status==='RESERVED'?'PENDING' as const:'UNKNOWN' as const,code:'RECEIPT_RENEWAL_SIGNING_UNRESOLVED'};
      const receipt=latest.receipt as typeof root;
      if(!await verifyReceiptSignature(receipt,domain))throw Error('RECEIPT_RENEWAL_SIGNATURE_INVALID');
      return ReceiptRecoveryResponseSchema.parse({status:'SIGNED',evaluation,originalReceipt:root,reviewStartedAt:record.startedAt,reviewFinishedAt:record.finishedAt,receipt,receiptHash:latest.receiptHash});
    };
    const current=await observe();if(current.status!=='SIGNED'||!parsed.data.confirmation)return current;
    if(parsed.data.previousReceiptHash!==current.receiptHash)return current; // An acknowledged successor is replayed, never replaced.
    if(now<BigInt(current.receipt.expiresAt))return current;
    if(parsed.data.reschedule){
      if(now<BigInt(e.deliveryDeadline))return blocked('ORIGINAL_DELIVERY_WINDOW_STILL_OPEN');
      if(now>=BigInt(q.expiresAt))return blocked('ORIGINAL_QUOTE_EXPIRED');
      try{await this.guard(r,BigInt(current.receipt.expiresAt));}catch{return blocked('RECEIPT_RENEWAL_CHAIN_OR_SUBMISSION_BLOCKED');}
      if(this.clock()<now||this.clock()>=BigInt(q.expiresAt))return blocked('ORIGINAL_QUOTE_EXPIRED');
      return {...current,canReschedule:true}; // Eligibility only: no receipt, grant or transaction is issued.
    }
    if(now>=BigInt(q.expiresAt)||now>=BigInt(e.deliveryDeadline))return blocked('ORIGINAL_QUOTE_OR_DELIVERY_EXPIRED');
    try{await this.guard(r,BigInt(current.receipt.expiresAt));}catch{return blocked('RECEIPT_RENEWAL_CHAIN_OR_SUBMISSION_BLOCKED');}
    const after=this.clock();if(after<now||after>=BigInt(q.expiresAt)||after>=BigInt(e.deliveryDeadline))return blocked('ORIGINAL_QUOTE_OR_DELIVERY_EXPIRED');
    const {signature:_signature,...old}=current.receipt,next={...old,expiresAt:String([after+300n,BigInt(q.expiresAt),BigInt(e.deliveryDeadline)].reduce((a,b)=>a<b?a:b))};
    try{await this.signer.renew(next,domain,root,current.receipt);}catch{const observed=await observe();return observed.status==='SIGNED'&&observed.receiptHash===current.receiptHash?blocked('RECEIPT_RENEWAL_NOT_SIGNED'):observed;}
    return await observe();
  }
}
