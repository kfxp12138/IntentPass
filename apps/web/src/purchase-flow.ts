import {z} from 'zod';
import {TaskPolicySchema} from '../../../packages/protocol/src/schemas.js';
import {TaskInputSchema} from '../../../packages/capsule/src/format.js';
import {EvidenceBundleSchema,createEvidenceSalt,purchaseEvidenceHash} from '../../../packages/protocol/src/review-evidence.js';
import {mergeQuoteEvidence,supplementDraftEvidence} from '../../../packages/protocol/src/evidence-version.js';
import {CatalogResponseSchema,ProposeResultSchema,ReviewResultSchema,ReviewRequestSchema,type Draft} from '../../../packages/protocol/src/purchase-api.js';
import {PurchaseClient} from '../../../packages/protocol/src/purchase-client.js';
import {contextHash,policyHash,verifyQuoteSignature,verifyReceiptSignature,committeeHash,ALLOCATION_POLICY,RELEASE_POLICY,DELIVERY_SCHEMA,ZERO_HASH} from '../../../packages/protocol/src/index.js';
import {aggregateJev,questionConfigHash} from '../../../packages/adapters/src/jev-review.js';
import {browserSession,BrowserSession} from './browser-session.js';
import {createReport} from '../../../packages/protocol/src/report.js';
import {prepareAuthorization,finalizeAuthorization} from '../../../packages/capsule/src/authorization.js';
import {PreflightResultSchema,type PreflightSnapshot} from '../../../packages/protocol/src/purchase-preflight.js';
import {OriginalCandidateSchema,ReceiptRecoveryResponseSchema} from '../../../packages/protocol/src/receipt-recovery.js';
import {DraftSchema} from '../../../packages/protocol/src/draft.js';
import {receiptHash} from '../../../packages/protocol/src/typed-data.js';
import {WalletSignatureNotRequested} from './privy-grant-wallet.js';
const TaskSchema=z.object({policy:TaskPolicySchema,taskInput:TaskInputSchema,evidence:EvidenceBundleSchema.optional()}).strict();
export interface PurchasePort {catalog:()=>Promise<unknown>;propose:(input:unknown)=>Promise<unknown>;review:(input:unknown)=>Promise<unknown>;recoverReceipt?:(input:unknown)=>Promise<unknown>;prepareOrder?:(input:unknown)=>Promise<Awaited<ReturnType<typeof prepareAuthorization>>>;preflight?:(input:unknown)=>Promise<unknown>;}
export interface PurchaseReviewAttempt {request:ReturnType<typeof ReviewRequestSchema.parse>;state:'PENDING'|'COMPLETE'|'FAILED'|'DISCARDED';startedAt:string;endedAt?:string;result?:ReturnType<typeof ReviewResultSchema.parse>;code?:string;}
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export class PurchaseFlow {
  draft:Draft|undefined;
  reviewResult:ReturnType<typeof ReviewResultSchema.parse>|undefined;
  authorization:Awaited<ReturnType<typeof prepareAuthorization>>|undefined;
  preflightSnapshot:PreflightSnapshot|undefined;
  signedAuthorization:Awaited<ReturnType<typeof finalizeAuthorization>>|undefined;
  private signing=false;
  private walletStarted=false;
  private attempts=new Map<string,PurchaseReviewAttempt>();
  private revision=0;
  private entries:ReturnType<typeof CatalogResponseSchema.parse>['entries']|undefined;
  private taskSalt:{key:string;salt:string}|undefined;
  constructor(private task:()=>unknown,private session:BrowserSession=browserSession,private client:PurchasePort=new PurchaseClient(location.origin,()=>session.token()),private clock:()=>bigint=()=>BigInt(Math.floor(Date.now()/1000))){}
  get authorizationLocked(){return this.signing||this.walletStarted||!!this.signedAuthorization;}
  get reviewHistory(){return structuredClone([...this.attempts.values()]);}
  private reviewKey(draft:Draft){return JSON.stringify({policy:policyHash(draft.policy),buyer:draft.intent.buyer.toLowerCase(),quote:draft.quote,evidence:purchaseEvidenceHash(draft.evidence),chainId:draft.intent.chainId,arbiter:draft.intent.arbiter.toLowerCase(),bond:draft.intent.bond});}
  get canReview(){return !!this.draft&&!this.authorizationLocked&&!this.attempts.has(this.reviewKey(this.draft));}
  private editable(){if(this.signing)throw new Error('WALLET_SIGNATURE_PENDING');if(this.signedAuthorization)throw new Error('ORIGINAL_AUTHORIZATION_ALREADY_SIGNED');if(this.walletStarted)throw new Error('ORIGINAL_AUTHORIZATION_OUTCOME_UNKNOWN');}
  reset(){this.revision++;this.draft=undefined;this.reviewResult=undefined;this.authorization=undefined;this.preflightSnapshot=undefined;}
  invalidateAuthorization(){this.revision++;this.authorization=undefined;this.preflightSnapshot=undefined;}
  private guard() {
    const snapshot=JSON.stringify(this.task()),generation=this.session.generation,revision=this.revision;
    return ()=>{if(snapshot!==JSON.stringify(this.task())||generation!==this.session.generation||revision!==this.revision)throw new Error('PURCHASE_CONTEXT_CHANGED');};
  }
  private assertCurrentTask(draft:Draft) {
    const task=TaskSchema.parse(this.task()),taskText=task.evidence?.taskText??`生成数据集 ${task.policy.datasetHash} 的 count、sum、min、max 报告；用途为商业使用。`;
    if(!eq(policyHash(task.policy),policyHash(draft.policy))||!eq(createReport(task.taskInput.dataset).datasetHash,task.policy.datasetHash)
      ||!eq(task.taskInput.buyer,draft.intent.buyer)||!eq(task.taskInput.seller,draft.intent.seller)||taskText!==draft.evidence.taskText||task.evidence?.schemaVersion===2&&(draft.evidence.schemaVersion!==2||!eq(task.evidence.salt,draft.evidence.salt))
      ||task.evidence?.documents.some(doc=>!draft.evidence.documents.some(actual=>actual.id===doc.id&&eq(actual.subjectQuoteId,doc.subjectQuoteId)&&actual.text===doc.text)))throw new Error('PURCHASE_TASK_CHANGED');
  }
  async catalog(){const guard=this.guard();await this.session.verified();const catalog=CatalogResponseSchema.parse(await this.client.catalog());guard();this.entries=structuredClone(catalog.entries);return catalog;}
  async propose(refs:string[]) {
    this.editable();this.reset();const guard=this.guard(),task=TaskSchema.parse(this.task()),principal=await this.session.verified(),config=await this.session.configuration(),d=config.recoveryDeployment;
    if(task.evidence?.schemaVersion===1)throw new Error('LEGACY_TASK_RECONFIRM_REQUIRED');
    if(!eq(createReport(task.taskInput.dataset).datasetHash,task.policy.datasetHash))throw new Error('TASK_DATASET_MISMATCH');
    if(!d)throw new Error('PURCHASE_DEPLOYMENT_REQUIRED');if(!principal.wallets.some(w=>eq(w,task.taskInput.buyer)))throw new Error('OWNER_MISMATCH');
    if(!this.entries||refs.some(ref=>!this.entries!.some(entry=>eq(entry.quote.quoteId,ref))))throw new Error('CATALOG_REQUIRED');
    const taskText=task.evidence?.taskText??`生成数据集 ${task.policy.datasetHash} 的 count、sum、min、max 报告；用途为商业使用。`;
    const key=policyHash(task.policy)+taskText;if(this.taskSalt?.key!==key)this.taskSalt={key,salt:createEvidenceSalt()};const salt=task.evidence?.schemaVersion===2?task.evidence.salt:this.taskSalt.salt;
    guard();const result=ProposeResultSchema.parse(await this.client.propose({policy:task.policy,taskText,buyer:task.taskInput.buyer,quoteRefs:refs,evidenceSalt:salt,...(task.evidence?.documents.length?{additionalEvidence:task.evidence.documents}:{})}));guard();
    if(result.status!=='DRAFT')return result;
    if(result.evidence.schemaVersion!==2||!eq(result.evidence.salt,salt))throw new Error('DRAFT_CONTEXT_INVALID');
    const e=result.intent,q=result.quote;
    const entry=this.entries.find(entry=>eq(entry.quote.quoteId,q.quoteId));
    if(!entry||JSON.stringify(entry.quote)!==JSON.stringify(q)||JSON.stringify(mergeQuoteEvidence(entry.documents,task.evidence?.documents??[],q.quoteId))!==JSON.stringify(result.evidence.documents))throw new Error('DRAFT_CATALOG_CHANGED');
    if(!eq(policyHash(result.policy),policyHash(task.policy))||!eq(e.policyHash,policyHash(task.policy))||!eq(e.taskId,task.policy.taskId)||!eq(e.datasetHash,task.policy.datasetHash)
      ||!eq(e.buyer,task.taskInput.buyer)||!eq(e.asset,d.asset)||!eq(e.asset,task.policy.allowedAsset)||e.chainId!==d.chainId||!eq(e.arbiter,d.arbiter)||!eq(e.reviewer,d.reviewer)||!eq(e.committeeHash,committeeHash(d.committee))
      ||!eq(e.allocationPolicyHash,ALLOCATION_POLICY)||!eq(e.intentReleasePolicyHash,RELEASE_POLICY)||!eq(e.deliverySchemaHash,DELIVERY_SCHEMA)||!eq(e.pactPaymentPublicKeyHash,ZERO_HASH)
      ||BigInt(e.price)+BigInt(e.bond)>BigInt(task.policy.budget)||!eq(e.seller,task.taskInput.seller)||!eq(q.seller,e.seller)||!eq(q.payee,e.payee)||!eq(q.asset,e.asset)||q.amount!==e.price||!eq(q.serviceTermsHash,e.serviceTermsHash)
      ||BigInt(q.expiresAt)<=this.clock()||BigInt(e.deliveryDeadline)<=this.clock()
      ||!refs.some(ref=>eq(ref,q.quoteId))||result.evidence.taskText!==taskText||!eq(purchaseEvidenceHash(result.evidence),e.purchaseEvidenceCommitment)
      ||result.citations.some(id=>!result.evidence.documents.some(doc=>doc.id===id))||!await verifyQuoteSignature(q,{chainId:d.chainId,arbiter:d.arbiter}))throw new Error('DRAFT_CONTEXT_INVALID');
    guard();this.draft=result;return result;
  }
  async supplementEvidence(document:unknown){
    this.editable();const draft=this.draft;if(!draft)throw new Error('DRAFT_REQUIRED');const next=supplementDraftEvidence(draft,document),snapshot=JSON.stringify(draft),base=this.guard(),guard=()=>{base();if(draft!==this.draft||JSON.stringify(draft)!==snapshot)throw new Error('PURCHASE_CONTEXT_CHANGED');};
    const principal=await this.session.verified();guard();this.editable();this.assertCurrentTask(draft);
    if(!principal.wallets.some(w=>eq(w,draft.intent.buyer)))throw new Error('OWNER_MISMATCH');
    if(this.clock()>=BigInt(draft.quote.expiresAt)||this.clock()>=BigInt(draft.intent.deliveryDeadline))throw new Error('EVIDENCE_VERSION_EXPIRED');
    this.reset();this.draft=next;return structuredClone(next);
  }
  async review() {
    this.editable();const draft=this.draft;if(!draft)throw new Error('DRAFT_REQUIRED');const key=this.reviewKey(draft);if(this.attempts.has(key))throw new Error('EVIDENCE_VERSION_ALREADY_REVIEWED');const snapshot=JSON.stringify(draft),guardBase=this.guard(),guard=()=>{guardBase();if(draft!==this.draft||JSON.stringify(draft)!==snapshot)throw new Error('PURCHASE_CONTEXT_CHANGED');},principal=await this.session.verified(),config=await this.session.configuration(),rule=config.purchaseRule,d=config.recoveryDeployment;
    guard();this.editable();if(this.attempts.has(key))throw new Error('EVIDENCE_VERSION_ALREADY_REVIEWED');
    if(!d||!rule||rule.questionConfigHash!==questionConfigHash(rule.minConfidence,rule.questionVersion??1))throw new Error('REVIEW_RULE_REQUIRED');
    this.assertCurrentTask(draft);
    if(!principal.wallets.some(w=>eq(w,draft.intent.buyer)))throw new Error('OWNER_MISMATCH');
    const input=ReviewRequestSchema.parse({policy:draft.policy,intent:draft.intent,quote:draft.quote,evidence:draft.evidence});
    this.preflightSnapshot=undefined;this.authorization=undefined;this.reviewResult=undefined;const attempt:PurchaseReviewAttempt={request:structuredClone(input),state:'PENDING',startedAt:this.clock().toString()};this.attempts.set(key,attempt);
    try{const result=ReviewResultSchema.parse(await this.client.review(input));attempt.result=structuredClone(result);guard();
    if(result.source==='JEV') {
      if(result.modelId!==rule.model||result.questionConfigHash!==rule.questionConfigHash)throw new Error('REVIEW_CONTEXT_INVALID');
      const actual=aggregateJev({model:result.modelId,answers:result.answers,usage:result.usage},rule.minConfidence);
      if(result.decision!==actual&&!(actual==='PASS'&&result.decision==='ABSTAIN'&&!result.executable&&['REVIEW_EXPIRED','REVIEWER_UNAVAILABLE'].includes(result.code??'')))throw new Error('REVIEW_CONTEXT_INVALID');
      if(result.executable) {const r=result.receipt;if(!eq(r.contextHash,contextHash(draft.intent))||!eq(r.policyHash,draft.intent.policyHash)||!eq(r.purchaseEvidenceCommitment,draft.intent.purchaseEvidenceCommitment)||!eq(r.reviewer,d.reviewer)||r.modelId!==rule.model||r.questionConfigHash!==rule.questionConfigHash||BigInt(r.expiresAt)<=this.clock()||BigInt(r.expiresAt)>BigInt(draft.quote.expiresAt)||BigInt(r.expiresAt)>BigInt(draft.intent.deliveryDeadline)||!await verifyReceiptSignature(r,{chainId:d.chainId,arbiter:d.arbiter}))throw new Error('REVIEW_CONTEXT_INVALID');}
    }
    const current=await this.session.verified();guard();if(current.subject!==principal.subject||!current.wallets.some(w=>eq(w,draft.intent.buyer)))throw new Error('SESSION_CHANGED');
    attempt.state='COMPLETE';attempt.endedAt=this.clock().toString();this.reviewResult=result;return result;
    }catch(error){attempt.state='FAILED';attempt.code='REVIEW_UNAVAILABLE_OR_INVALID';attempt.endedAt=this.clock().toString();try{guard();}catch{attempt.state='DISCARDED';attempt.code='PURCHASE_CONTEXT_CHANGED';}throw error;}
  }
  /** Restore one already-reviewed committed header without planner/model requests. */
  async resumeOriginal(input:unknown){
    this.editable();if(this.draft)throw Error('ORIGINAL_CANDIDATE_ALREADY_PRESENT');const hint=OriginalCandidateSchema.parse(input),task=TaskSchema.parse(this.task()),guard=this.guard();
    if(!task.evidence||task.evidence.schemaVersion!==2)throw Error('ORIGINAL_TASK_BACKUP_REQUIRED');
    if(!this.entries)await this.catalog();guard();const entry=this.entries!.find(v=>eq(v.quote.quoteId,hint.quoteId));if(!entry)throw Error('ORIGINAL_QUOTE_NOT_IN_CATALOG');
    const draft=DraftSchema.parse({status:'DRAFT',modelId:'RECOVERED_EXISTING_CANDIDATE',policy:task.policy,intent:hint.intent,quote:entry.quote,evidence:{...task.evidence,documents:mergeQuoteEvidence(entry.documents,task.evidence.documents,entry.quote.quoteId)},citations:[]});
    this.assertCurrentTask(draft);if(!eq(purchaseEvidenceHash(draft.evidence),hint.intent.purchaseEvidenceCommitment))throw Error('ORIGINAL_EVIDENCE_MISMATCH');
    const result=await this.receiptFor(draft,false);guard();if(result.status!=='SIGNED')throw Error(result.code);
    this.draft=draft;const {policy,intent,quote,evidence}=draft;
    this.attempts.set(this.reviewKey(draft),{request:{policy,intent,quote,evidence},state:'COMPLETE',startedAt:result.reviewStartedAt,endedAt:result.reviewFinishedAt,result:{...result.evaluation,source:'JEV',decision:'PASS',executable:true,receipt:result.originalReceipt}});
    this.reviewResult={...result.evaluation,source:'JEV',decision:'PASS',executable:true,receipt:result.receipt};return result;
  }
  private async receiptFor(draft:Draft,confirmation:boolean,previousReceiptHash?:string,reschedule=false){
    if(!this.client.recoverReceipt)throw Error('RECEIPT_RECOVERY_UNAVAILABLE');const principal=await this.session.verified();this.assertCurrentTask(draft);
    if(!principal.wallets.some(w=>eq(w,draft.intent.buyer)))throw Error('OWNER_MISMATCH');
    const {policy,intent,quote,evidence}=draft,result=ReceiptRecoveryResponseSchema.parse(await this.client.recoverReceipt({request:{policy,intent,quote,evidence},confirmation,...(previousReceiptHash?{previousReceiptHash}:{}),...(reschedule?{reschedule:true}:{})}));
    const current=await this.session.verified();if(current.subject!==principal.subject||!current.wallets.some(w=>eq(w,draft.intent.buyer)))throw Error('SESSION_CHANGED');
    if(result.status==='SIGNED'){
      const config=await this.session.configuration(),rule=config.purchaseRule;if(!rule||result.evaluation.source!=='JEV'||result.evaluation.executable||result.evaluation.decision!=='PASS'||result.evaluation.modelId!==rule.model||result.evaluation.questionConfigHash!==rule.questionConfigHash||aggregateJev({model:result.evaluation.modelId,answers:result.evaluation.answers,usage:result.evaluation.usage},rule.minConfidence)!=='PASS')throw Error('RECEIPT_RECOVERY_RESPONSE_MISMATCH');
      for(const receipt of [result.originalReceipt,result.receipt])if(!eq(receipt.contextHash,contextHash(intent))||!eq(receipt.policyHash,intent.policyHash)||!eq(receipt.purchaseEvidenceCommitment,intent.purchaseEvidenceCommitment)||!eq(receipt.reviewer,intent.reviewer)||receipt.modelId!==rule.model||receipt.questionConfigHash!==rule.questionConfigHash||BigInt(receipt.expiresAt)>BigInt(quote.expiresAt)||BigInt(receipt.expiresAt)>BigInt(intent.deliveryDeadline)||!await verifyReceiptSignature(receipt,{chainId:intent.chainId,arbiter:intent.arbiter}))throw Error('RECEIPT_RECOVERY_RESPONSE_MISMATCH');
    }
    return result;
  }
  async recoverReceipt(confirmation:boolean){
    this.editable();const draft=this.draft;if(!draft)throw Error('DRAFT_REQUIRED');const previous=this.reviewResult;
    let hash:string|undefined;if(confirmation){if(!previous||previous.source!=='JEV'||!previous.executable)throw Error('RECORDED_EXECUTABLE_PASS_REQUIRED');const {signature:_signature,...unsigned}=previous.receipt;hash=receiptHash(unsigned,{chainId:draft.intent.chainId,arbiter:draft.intent.arbiter});}
    this.invalidateAuthorization();const currentGuard=this.guard(),result=await this.receiptFor(draft,confirmation,hash);currentGuard();if(draft!==this.draft)throw Error('PURCHASE_CONTEXT_CHANGED');
    if(result.status==='SIGNED')this.reviewResult={...result.evaluation,source:'JEV',decision:'PASS',executable:true,receipt:result.receipt};
    return result;
  }
  async rescheduleOriginal(confirmation:boolean,onTask:(task:ReturnType<typeof TaskSchema.parse>)=>void){
    this.editable();if(!confirmation)throw Error('RESCHEDULE_CONFIRMATION_REQUIRED');const draft=this.draft,r=this.reviewResult,guard=this.guard();
    if(!draft||!r||r.source!=='JEV'||!r.executable)throw Error('RECORDED_EXECUTABLE_PASS_REQUIRED');
    const {signature:_signature,...unsigned}=r.receipt,hash=receiptHash(unsigned,{chainId:draft.intent.chainId,arbiter:draft.intent.arbiter});
    const result=await this.receiptFor(draft,true,hash,true);guard();if(result.status!=='SIGNED'||!result.canReschedule)throw Error('code'in result?result.code:'RESCHEDULE_NOT_READY');
    const task=TaskSchema.parse(this.task());if(!task.evidence||task.evidence.schemaVersion!==2)throw Error('ORIGINAL_TASK_BACKUP_REQUIRED');
    const amended=TaskSchema.parse({...task,policy:{...task.policy,version:String(BigInt(task.policy.version)+1n)},evidence:{...task.evidence,taskText:task.evidence.taskText+'\n本人确认的重新采购安排：本次采购开始后30分钟内交付同一数据报告，预算、商业用途、数据集与收款方保持。'}});
    // Only this explicit path changes the task revision; original attempts remain in the map.
    onTask(amended);this.reset();return amended;
  }
  /** Candidate nonce only; chain availability and wallet interaction remain separate. */
  async prepare(nonce:string,deadline:string) {
    if(this.signedAuthorization)throw new Error('ORIGINAL_AUTHORIZATION_ALREADY_SIGNED');
    if(this.walletStarted)throw new Error('ORIGINAL_AUTHORIZATION_OUTCOME_UNKNOWN');
    this.preflightSnapshot=undefined;this.authorization=undefined;
    const draft=this.draft,review=this.reviewResult;
    if(!draft||!review)throw new Error('REVIEW_REQUIRED');
    const snapshot=JSON.stringify([draft,review]),guardBase=this.guard();
    const guard=()=>{guardBase();if(draft!==this.draft||review!==this.reviewResult||snapshot!==JSON.stringify([draft,review]))throw new Error('PURCHASE_CONTEXT_CHANGED');};
    const principal=await this.session.verified(),config=await this.session.configuration();guard();
    this.assertCurrentTask(draft);
    if(!config.recoveryDeployment||!config.purchaseRule)throw new Error('PURCHASE_DEPLOYMENT_REQUIRED');
    const input={request:{policy:draft.policy,intent:draft.intent,quote:draft.quote,evidence:draft.evidence},review,nonce,deadline};
    const prepared=await prepareAuthorization(input,{authenticatedWallets:principal.wallets,deployment:config.recoveryDeployment,rule:config.purchaseRule,now:this.clock()});
    if(this.client.prepareOrder){const remote=await this.client.prepareOrder(input);guard();if(JSON.stringify(remote.payload)!==JSON.stringify(prepared.payload))throw new Error('ORDER_PREPARATION_MISMATCH');}
    guard();if(this.clock()>=BigInt(prepared.payload.grant.deadline))throw new Error('AUTHORIZATION_EXPIRED');
    this.authorization=prepared;return prepared;
  }
  async preflight() {
    this.preflightSnapshot=undefined;
    const prepared=this.authorization,draft=this.draft,review=this.reviewResult;
    if(!prepared||!draft||!review)throw new Error('AUTHORIZATION_PREPARATION_REQUIRED');
    if(!this.client.preflight)throw new Error('PREFLIGHT_SERVICE_REQUIRED');
    const guardBase=this.guard(),snapshot=JSON.stringify([draft,review]);
    const guard=()=>{guardBase();if(prepared!==this.authorization||draft!==this.draft||review!==this.reviewResult||snapshot!==JSON.stringify([draft,review]))throw new Error('PURCHASE_CONTEXT_CHANGED');};
    const principal=await this.session.verified(),config=await this.session.configuration();guard();this.assertCurrentTask(draft);
    if(!config.recoveryDeployment||!config.purchaseRule)throw new Error('PURCHASE_DEPLOYMENT_REQUIRED');
    const {grant:g,intent}=prepared.payload;
    const revalidated=await prepareAuthorization({request:{policy:draft.policy,intent:draft.intent,quote:draft.quote,evidence:draft.evidence},review,nonce:g.nonce,deadline:g.deadline},
      {authenticatedWallets:principal.wallets,deployment:config.recoveryDeployment,rule:config.purchaseRule,now:this.clock()});guard();
    if(JSON.stringify(revalidated.payload.grant)!==JSON.stringify(g))throw new Error('PURCHASE_CONTEXT_CHANGED');
    const result=PreflightResultSchema.parse(await this.client.preflight({intent,grant:g}));guard();
    if('status'in result)return result;
    if(result.block.finality!=='finalized'||result.chainId!==g.chainId||result.nonce!==g.nonce||result.amount!==g.amount||result.deadline!==g.deadline
      ||([['arbiter',g.arbiter],['asset',g.asset],['buyer',g.owner],['orderId',g.orderId],['contextHash',g.contextHash]] as const).some(([key,value])=>!eq(result[key],value)))throw new Error('PREFLIGHT_RESPONSE_MISMATCH');
    if(this.clock()>=BigInt(g.deadline))throw new Error('AUTHORIZATION_EXPIRED');
    this.preflightSnapshot=result;return result;
  }
  /** Called only by explicit user confirmation. It never approves or transfers assets. */
  async sign(assertActive:()=>void=()=>{}) {
    if(this.signing)throw new Error('WALLET_SIGNATURE_PENDING');
    if(this.signedAuthorization)throw new Error('ORIGINAL_AUTHORIZATION_ALREADY_SIGNED');
    if(this.walletStarted)throw new Error('ORIGINAL_AUTHORIZATION_OUTCOME_UNKNOWN');
    const prepared=this.authorization;if(!prepared)throw new Error('AUTHORIZATION_PREPARATION_REQUIRED');
    const guardBase=this.guard(),guard=()=>{assertActive();guardBase();if(prepared!==this.authorization)throw new Error('PURCHASE_CONTEXT_CHANGED');};
    this.signing=true;
    try {
      guard();const originalPrincipal=await this.session.verified();guard();const observed=await this.preflight();guard();
      // Grant signing does not set allowance. An exact approval is a later explicit action.
      if('status'in observed||observed.blockers.some(reason=>reason!=='EXACT_ALLOWANCE_REQUIRED'))throw new Error('AUTHORIZATION_CHAIN_BLOCKED');
      this.walletStarted=true;const signature=await this.session.signGrant(prepared.payload.grant);guard();
      const principal=await this.session.verified(),config=await this.session.configuration();guard();
      if(principal.subject!==originalPrincipal.subject)throw new Error('SESSION_CHANGED');
      if(!config.recoveryDeployment||!config.purchaseRule)throw new Error('PURCHASE_DEPLOYMENT_REQUIRED');
      const signed=await finalizeAuthorization(prepared.payload,signature,{authenticatedWallets:principal.wallets,deployment:config.recoveryDeployment,rule:config.purchaseRule,now:this.clock()});guard();
      if(this.clock()>=BigInt(signed.payload.grant.deadline))throw new Error('AUTHORIZATION_EXPIRED');
      this.signedAuthorization=signed;return signed;
    }catch(error){
      // A generic provider failure stays frozen. This branded local exception
      // requires that the signing RPC was never invoked and late work was closed.
      if(error instanceof WalletSignatureNotRequested)this.walletStarted=false;
      throw error;
    }finally{this.signing=false;}
  }
}
