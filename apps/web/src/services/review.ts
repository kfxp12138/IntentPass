import {z} from 'zod';
import type {Hex} from 'viem';
import {DecisionReceiptSchema} from '../../../../packages/protocol/src/schemas.js';
import {purchaseEvidenceHash} from '../../../../packages/protocol/src/review-evidence.js';
import {contextHash} from '../../../../packages/protocol/src/index.js';
import {policyHash,termsHash,verifyQuoteSignature,verifyReceiptSignature} from '../../../../packages/protocol/src/typed-data.js';
import {ALLOCATION_POLICY,RELEASE_POLICY,DELIVERY_SCHEMA,ZERO_HASH} from '../../../../packages/protocol/src/escrow.js';
import type {EscrowDeployment} from '../../../../packages/protocol/src/escrow-read.js';
import {aggregateJev,JevResponseSchema,questionConfigHash,type JevPort} from '../../../../packages/adapters/src/jev-review.js';
import type {Principal} from '../../../../packages/adapters/src/privy-auth.js';
import {ReviewRequestSchema,ReviewResultSchema} from '../../../../packages/protocol/src/purchase-api.js';
import {MemoryReviewJournal,type ReviewJournal,type ReviewResult,type ReviewRecord} from '../../../../packages/storage/src/review-journal.js';
import {reviewSemanticInput} from './review-key.js';
export {ReviewRequestSchema};
type UnsignedReceipt=Omit<z.infer<typeof DecisionReceiptSchema>,'signature'>;
export interface ReceiptSigner {readonly address:string;sign(receipt:UnsignedReceipt,domain:{chainId:string;arbiter:string}):Promise<Hex>;}
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export class ReviewService {
  readonly questionHash:Hex;
  constructor(private readonly jev:JevPort,private readonly deployment:EscrowDeployment,private readonly minConfidence:number,private readonly signer?:ReceiptSigner,private readonly clock:()=>bigint=()=>BigInt(Math.floor(Date.now()/1000)),private readonly journal:ReviewJournal=new MemoryReviewJournal(),private readonly attemptNamespace?:string) {this.questionHash=questionConfigHash(minConfidence,jev.questionVersion??1);if(attemptNamespace!==undefined)z.uuid().parse(attemptNamespace);}
  async review(input:unknown,principal:Principal):Promise<ReviewResult> {
    const now=this.clock();
    const parsed=ReviewRequestSchema.safeParse(input);
    if(!parsed.success)return {decision:'REJECT' as const,source:'HARD_RULE',code:'INPUT_INVALID'};
    const {policy:p,intent:e,quote:q,evidence}=parsed.data,d=this.deployment,domain={chainId:d.chainId,arbiter:d.arbiter};
    const reject=(code:string)=>({decision:'REJECT' as const,source:'HARD_RULE' as const,code});
    if(!principal.wallets.some(w=>eq(w,e.buyer)))return reject('OWNER_MISMATCH');
    if(evidence.schemaVersion!==2)return reject('EVIDENCE_SALT_REQUIRED');
    if(e.chainId!==d.chainId||![ [e.arbiter,d.arbiter],[e.asset,d.asset],[e.reviewer,d.reviewer],[e.committeeHash,d.committeeHash], [e.allocationPolicyHash,ALLOCATION_POLICY],[e.intentReleasePolicyHash,RELEASE_POLICY],[e.deliverySchemaHash,DELIVERY_SCHEMA],[e.pactPaymentPublicKeyHash,ZERO_HASH] ].every(([a,b])=>eq(a,b)))return reject('DEPLOYMENT_MISMATCH');
    if(!eq(e.policyHash,policyHash(p))||!eq(e.taskId,p.taskId)||!eq(e.datasetHash,p.datasetHash)||!eq(e.asset,p.allowedAsset)||BigInt(e.price)+BigInt(e.bond)>BigInt(p.budget))return reject('POLICY_CONTRADICTED');
    if(now<0n||BigInt(q.expiresAt)<=now||BigInt(e.deliveryDeadline)<=now)return reject('QUOTE_EXPIRED');
    if(!eq(q.seller,e.seller)||!eq(q.payee,e.payee)||!eq(q.asset,e.asset)||q.amount!==e.price||!eq(q.serviceTermsHash,e.serviceTermsHash)||!eq(termsHash(q.serviceTerms),q.serviceTermsHash)||!await verifyQuoteSignature(q,domain))return reject('QUOTE_INVALID');
    if(!eq(purchaseEvidenceHash(evidence),e.purchaseEvidenceCommitment))return reject('EVIDENCE_COMMITMENT_MISMATCH');
    let key:string;
    try{
      const semantic=reviewSemanticInput(parsed.data,this.jev.model,this.questionHash);
      key=this.journal.key(this.attemptNamespace===undefined?semantic:{version:2,attemptNamespace:this.attemptNamespace,request:semantic});
      if(!this.journal.reserve(key,contextHash(e),String(now))){const record=this.journal.get(key);if(!record)throw new Error();return await this.replay(record,parsed.data,now);}
    }catch{return this.dependency('REVIEW_JOURNAL_UNAVAILABLE');}
    try{
      const result=ReviewResultSchema.parse(await this.evaluate(parsed.data,key,now)),record=this.journal.get(key);if(!record)throw new Error();
      const current=this.clock(),earliest=BigInt(record.evaluatedAt??record.startedAt);this.journal.finish(key,result,String(current<earliest?earliest:current));
      if(result.source==='JEV'&&result.executable){const returningAt=this.clock();if(returningAt<now)return this.dependency('REVIEW_TIME_INVALID');if(returningAt>=BigInt(result.receipt.expiresAt))return this.dependency('REVIEW_RECEIPT_EXPIRED');}
      return result;
    }catch{return this.dependency('REVIEW_JOURNAL_UNAVAILABLE');}
  }
  private dependency(code:string):ReviewResult{return {decision:'ABSTAIN',source:'DEPENDENCY',code};}
  private async replay(record:ReviewRecord,request:z.infer<typeof ReviewRequestSchema>,now:bigint):Promise<ReviewResult>{
    if(now<BigInt(record.startedAt))return this.dependency('REVIEW_TIME_INVALID');
    if(record.status==='PENDING')return this.dependency('REVIEW_REQUEST_IN_PROGRESS_OR_UNKNOWN');
    if(record.status==='EVALUATED')return this.dependency('REVIEW_SIGNING_OUTCOME_UNKNOWN');
    if(!eq(record.contextHash,contextHash(request.intent)))return this.dependency('REVIEW_VERSION_ALREADY_REQUESTED');
    if(record.status==='UNKNOWN')return record.result!;
    const result=record.result!,evaluation=record.evaluation!;
    if(evaluation.source!=='JEV'||evaluation.modelId!==this.jev.model||!eq(evaluation.questionConfigHash,this.questionHash)
      ||aggregateJev({model:evaluation.modelId,answers:evaluation.answers,usage:evaluation.usage},this.minConfidence)!==evaluation.decision)throw new Error('REVIEW_RECORD_INVALID');
    if(result.source==='JEV'&&result.executable){const r=result.receipt,e=request.intent;
      if(evaluation.decision!=='PASS'||!eq(r.contextHash,contextHash(e))||!eq(r.purchaseEvidenceCommitment,e.purchaseEvidenceCommitment)||!eq(r.policyHash,e.policyHash)||!eq(r.reviewer,e.reviewer)||r.modelId!==this.jev.model||!eq(r.questionConfigHash,this.questionHash)||BigInt(r.expiresAt)>BigInt(request.quote.expiresAt)||BigInt(r.expiresAt)>BigInt(e.deliveryDeadline)||!await verifyReceiptSignature(r,{chainId:e.chainId,arbiter:e.arbiter}))throw new Error('REVIEW_RECORD_INVALID');
      const current=this.clock();if(current<now)return this.dependency('REVIEW_TIME_INVALID');if(now>=BigInt(r.expiresAt)||current>=BigInt(r.expiresAt))return this.dependency('REVIEW_RECEIPT_EXPIRED');
    }
    return result;
  }
  private async evaluate(request:z.infer<typeof ReviewRequestSchema>,key:string,now:bigint):Promise<ReviewResult>{
    const {policy:p,intent:e,quote:q,evidence}=request,d=this.deployment,domain={chainId:d.chainId,arbiter:d.arbiter};
    let result;
    try{result=JevResponseSchema.parse(await this.jev.evaluate({policy:p,taskText:evidence.taskText,currentQuote:{quoteId:q.quoteId,seller:q.seller,service:q.service,serviceTerms:q.serviceTerms},documents:evidence.documents}));if(result.model!==this.jev.model)throw new Error();}
    catch{return {decision:'ABSTAIN' as const,source:'DEPENDENCY',code:'JEV_UNAVAILABLE_OR_INVALID'};}
    const decision=aggregateJev(result,this.minConfidence);
    const base={decision,source:'JEV' as const,modelId:result.model,questionConfigHash:this.questionHash,answers:result.answers,usage:result.usage,executable:false as const};
    const evaluatedAt=this.clock();this.journal.evaluated(key,base,String(evaluatedAt<now?now:evaluatedAt));
    if(decision!=='PASS')return base;
    const current=this.clock();
    if(current<now||current>=BigInt(q.expiresAt)||current>=BigInt(e.deliveryDeadline))return {...base,decision:'ABSTAIN' as const,code:'REVIEW_EXPIRED'};
    if(!this.signer)return base;
    if(!eq(this.signer.address,d.reviewer))return {...base,decision:'ABSTAIN' as const,code:'REVIEWER_UNAVAILABLE'};
    const expiresAt=String([current+300n,BigInt(q.expiresAt),BigInt(e.deliveryDeadline)].reduce((a,b)=>a<b?a:b));
    const receipt:UnsignedReceipt={schemaVersion:1,contextHash:contextHash(e),purchaseEvidenceCommitment:e.purchaseEvidenceCommitment,policyHash:e.policyHash,reviewer:e.reviewer,modelId:result.model,questionConfigHash:this.questionHash,decision:'PASS',expiresAt};
    try {
      const signed=DecisionReceiptSchema.parse({...receipt,signature:await this.signer.sign(receipt,domain)});
      if(!await verifyReceiptSignature(signed,domain))throw new Error();
      if(this.clock()>=BigInt(signed.expiresAt))return {...base,decision:'ABSTAIN' as const,code:'REVIEW_EXPIRED'};
      return {...base,decision:'PASS',receipt:signed,executable:true};
    }catch{return {...base,decision:'ABSTAIN' as const,code:'REVIEWER_UNAVAILABLE'};}
  }
}
