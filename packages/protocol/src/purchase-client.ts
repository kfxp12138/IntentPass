import {OrderPrepareRequestSchema,OrderPrepareResponseSchema} from './order-preparation.js';
import {WithdrawalRequestSchema,checkWithdrawalPreparation,checkWithdrawalReceipt} from './withdrawal.js';
import {AllocationRequestSchema,checkAllocationPreparation} from './allocation.js';
import {AllocationTriggerRequestSchema,AllocationAttemptReconcileRequestSchema,AllocationPrepareResponseSchema,AllocationResponseSchema,checkAllocationResponse} from './allocation-api.js';
import {WithdrawalReserveRequestSchema,WithdrawalQueryRequestSchema,WithdrawalAttemptReconcileRequestSchema,WithdrawalPrepareResponseSchema,WithdrawalReserveResponseSchema,WithdrawalQueryResponseSchema,WithdrawalReconcileResponseSchema,checkWithdrawalRecord} from './withdrawal-api.js';
import {VoteRequestSchema,VoteReconcileRequestSchema,checkVotePreparation,checkVoteReceipt} from './vote.js';
import {VotePrepareResponseSchema,VoteReserveResponseSchema,VoteQueryResponseSchema,VoteReconcileResponseSchema,checkVoteRecord} from './vote-api.js';
import {AcceptanceReserveRequestSchema,AcceptanceSignatureRequestSchema,AcceptanceReserveResponseSchema,AcceptanceQueryResponseSchema,AcceptanceSignatureResponseSchema,checkAcceptanceRecord,verifyAcceptanceSignature} from './acceptance-api.js';
import {DeliveryReserveRequestSchema,DeliveryReconcileRequestSchema,OrderDeliveryRequestSchema,DeliveryReserveResponseSchema,DeliveryReconcileResponseSchema,checkDeliveryRecord,checkDeliveryReceipt} from './delivery-api.js';
import {reportDelivery,DeliveryPrepareRequestSchema,AcceptancePrepareRequestSchema,DeliveryPrepareResponseSchema,AcceptancePrepareResponseSchema,checkDeliveryPreparation,checkAcceptancePreparation} from './fulfillment.js';
import {FundingSubmitRequestSchema,FundingReconcileRequestSchema,OrderSubmissionResponseSchema,checkOrderSubmissionResponse} from './funding-api.js';
import {ApprovalReserveRequestSchema,ApprovalReserveResponseSchema,ApprovalReconcileRequestSchema,ApprovalReconcileResponseSchema} from './approval-api.js';
import {z} from 'zod';
import {BrowserConfigurationSchema,VerifiedSessionSchema} from '../../capsule/src/session-schema.js';
import {prepareAuthorization,finalizeAuthorization} from '../../capsule/src/authorization.js';
import {OrderSnapshotSchema} from './escrow-read.js';
import {digest} from './schemas.js';
import {policyHash,verifyQuoteSignature,verifyReceiptSignature,termsHash} from './typed-data.js';
import {contextHash} from './index.js';
import {createEvidenceSalt,purchaseEvidenceHash} from './review-evidence.js';
import {CatalogResponseSchema,ProposeRequestSchema,ProposeResultSchema,ReviewRequestSchema,ReviewResultSchema} from './purchase-api.js';
import {PreflightRequestSchema,PreflightResultSchema} from './purchase-preflight.js';
import {aggregateJev,questionConfigHash} from '../../adapters/src/jev-review.js';
import {committeeHash} from './escrow.js';
import {ReceiptRecoveryRequestSchema,ReceiptRecoveryResponseSchema} from './receipt-recovery.js';
import {receiptHash} from './typed-data.js';
import {WorkflowIdSchema,WorkflowListSchema,WorkflowOutputSchema,WorkflowStateSchema,WorkflowSubmitRequestSchema} from './workflow-api.js';
export class PurchaseClient {
  workflows(){return this.request('/api/automation/workflows',WorkflowListSchema,{action:'list'});}
  submitWorkflow(input:unknown){const r=WorkflowSubmitRequestSchema.parse(input);return this.request('/api/automation/workflows',WorkflowStateSchema,{action:'submit',...r});}
  async workflowOutput(jobId:unknown){const id=WorkflowIdSchema.parse(jobId),r=await this.request('/api/automation/workflows',WorkflowOutputSchema,{action:'output',jobId:id});if(r.id!==id)throw Error('WORKFLOW_RESPONSE_MISMATCH');return r;}
  async cancelWorkflow(jobId:unknown,confirm:boolean){if(confirm!==true)throw Error('WORKFLOW_CONFIRMATION_REQUIRED');const id=WorkflowIdSchema.parse(jobId),r=await this.request('/api/automation/workflows',WorkflowStateSchema,{action:'cancel',jobId:id,confirm:true});if(r.id!==id)throw Error('WORKFLOW_RESPONSE_MISMATCH');return r;}
  health(){return this.request('/health',z.object({service:z.literal('intentpass'),liveness:z.literal('OK'),ready:z.boolean(),stage:z.string().max(32).optional(),settlementRoute:z.literal('context-vote-escrow').optional()}),undefined,false);}
  configuration(){return this.request('/api/config',BrowserConfigurationSchema);}
  session(){return this.request('/api/session',VerifiedSessionSchema);}
  async order(id:unknown){const orderId=digest.parse(id),o=await this.request(`/api/orders/${orderId}`,OrderSnapshotSchema);if(o.orderId.toLowerCase()!==orderId.toLowerCase())throw new Error('ORDER_RESPONSE_MISMATCH');return o;}
  private async authorizationContext(now:bigint){const principal=await this.session(),config=await this.configuration();if(!config.recoveryDeployment||!config.purchaseRule)throw new Error('AUTHORIZATION_CONFIGURATION_REQUIRED');return {principal,context:{authenticatedWallets:principal.wallets,deployment:config.recoveryDeployment,rule:config.purchaseRule,now}};}
  private async sameOwner(subject:string,buyer:string){const current=await this.session();if(current.subject!==subject||!current.wallets.some(w=>w.toLowerCase()===buyer.toLowerCase()))throw new Error('AUTHORIZATION_SESSION_CHANGED');}
  async prepareOriginal(input:unknown,now=BigInt(Math.floor(Date.now()/1000))){const r=OrderPrepareRequestSchema.parse(input),{principal,context}=await this.authorizationContext(now),result=await prepareAuthorization(r,context);await this.sameOwner(principal.subject,result.payload.intent.buyer);return result;}
  async prepareOrder(input:unknown,now?:bigint){const r=OrderPrepareRequestSchema.parse(input),{principal,context}=await this.authorizationContext(now??BigInt(Math.floor(Date.now()/1000))),local=await prepareAuthorization(r,context),remote=await this.request('/api/orders/prepare',OrderPrepareResponseSchema,r);if('status'in remote)throw new Error('ORDER_PREPARATION_REJECTED');if(JSON.stringify(remote.payload)!==JSON.stringify(local.payload))throw new Error('ORDER_PREPARATION_MISMATCH');const checked=await prepareAuthorization(r,{...context,now:now??BigInt(Math.floor(Date.now()/1000))});await this.sameOwner(principal.subject,checked.payload.intent.buyer);return checked;}
  async finalizeOriginal(input:unknown,ownerSignature:string,now=BigInt(Math.floor(Date.now()/1000))){const {principal,context}=await this.authorizationContext(now),result=await finalizeAuthorization(input,ownerSignature,context);await this.sameOwner(principal.subject,result.payload.intent.buyer);return result;}
  async prepareAllocation(input:unknown){const r=AllocationRequestSchema.parse(input),v=await this.request('/api/allocations/prepare',AllocationPrepareResponseSchema,r);return 'status'in v?v:checkAllocationPreparation(r,v);}
  async triggerAllocation(input:unknown){const r=AllocationTriggerRequestSchema.parse(input);return checkAllocationResponse({payload:r.payload},await this.request('/api/allocations/trigger',AllocationResponseSchema,r));}
  async queryAllocation(input:unknown){const r=AllocationRequestSchema.parse(input);return checkAllocationResponse(r,await this.request('/api/allocations/query',AllocationResponseSchema,r));}
  async reconcileAllocation(input:unknown){const r=AllocationAttemptReconcileRequestSchema.parse(input);return checkAllocationResponse({payload:r.payload},await this.request('/api/allocations/reconcile',AllocationResponseSchema,r),r.hash);}
  private base:URL;
  constructor(baseUrl:string,private token:()=>Promise<string>,private transport:typeof fetch=fetch,private clock:()=>bigint=()=>BigInt(Math.floor(Date.now()/1000))) {
    this.base=new URL(baseUrl);if(this.base.username||this.base.password||this.base.search||this.base.hash||this.base.protocol!=='https:'&&!(this.base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(this.base.hostname)))throw new Error('PURCHASE_ENDPOINT_INVALID');
  }
  private async request<T>(path:string,schema:z.ZodType<T>,body?:unknown,authenticate=true):Promise<T> {
    const token=authenticate?await this.token():undefined;if(authenticate&&(!token||token.length>16384))throw new Error('LOGIN_REQUIRED');
    const response=await this.transport.call(globalThis,new URL(path,this.base),{method:body===undefined?'GET':'POST',headers:{...(token?{Authorization:`Bearer ${token}`}:{ }),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',cache:'no-store',signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error(`PURCHASE_HTTP_${response.status}`);const reader=response.body?.getReader();if(!reader)throw new Error('PURCHASE_RESPONSE_INVALID');
    let size=0;const chunks:Uint8Array[]=[];try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1500000){await reader.cancel();throw new Error('PURCHASE_RESPONSE_TOO_LARGE');}chunks.push(value);}}finally{reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}return schema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
  }
  async prepareWithdrawal(input:unknown){const r=WithdrawalRequestSchema.parse(input),result=await this.request('/api/withdrawals/prepare',WithdrawalPrepareResponseSchema,r);return 'status'in result?result:checkWithdrawalPreparation(r,result);}
  async reserveWithdrawal(input:unknown){const r=WithdrawalReserveRequestSchema.parse(input),result=await this.request('/api/withdrawals/reserve',WithdrawalReserveResponseSchema,r);if('status'in result)return result;const record=checkWithdrawalRecord({payload:r.payload,beneficiary:r.beneficiary},result.record);if(r.retryOf?record.retryOf?.toLowerCase()!==r.retryOf.toLowerCase():result.created&&record.attempt!=='1')throw new Error('WITHDRAWAL_RESPONSE_MISMATCH');return result;}
  async queryWithdrawal(input:unknown){const r=WithdrawalQueryRequestSchema.parse(input),result=await this.request('/api/withdrawals/query',WithdrawalQueryResponseSchema,r);if('status'in result)return result;if(result.record){checkWithdrawalRecord({payload:r.payload,beneficiary:r.beneficiary},result.record);if(r.attempt&&r.attempt!==result.record.attempt)throw new Error('WITHDRAWAL_RESPONSE_MISMATCH');}return result;}
  async reconcileWithdrawal(input:unknown){const r=WithdrawalAttemptReconcileRequestSchema.parse(input),original={payload:r.payload,beneficiary:r.beneficiary},result=await this.request('/api/withdrawals/reconcile',WithdrawalReconcileResponseSchema,r);if('status'in result)return result;const record=checkWithdrawalRecord(original,result.record),receipt=checkWithdrawalReceipt({...original,hash:r.hash},result.receipt);if(record.attempt!==r.attempt||(receipt.status==='PENDING'?record.status!=='RESERVED':record.status!==receipt.status||record.hash?.toLowerCase()!==r.hash.toLowerCase()||record.allocationState!==receipt.order.state||JSON.stringify(record.receiptBlock).toLowerCase()!==JSON.stringify(receipt.receiptBlock).toLowerCase()))throw new Error('WITHDRAWAL_RESPONSE_MISMATCH');return result;}
  async prepareVote(input:unknown){const r=VoteRequestSchema.parse(input),result=await this.request('/api/votes/prepare',VotePrepareResponseSchema,r);return 'status'in result?result:checkVotePreparation(r,result);}
  async reserveVote(input:unknown){const r=VoteRequestSchema.parse(input),result=await this.request('/api/votes/reserve',VoteReserveResponseSchema,r);if('status'in result)return result;await checkVoteRecord(r,result.record);return result;}
  async queryVote(input:unknown){const r=VoteRequestSchema.parse(input),result=await this.request('/api/votes/query',VoteQueryResponseSchema,r);if('status'in result)return result;if(result.record)await checkVoteRecord(r,result.record);return result;}
  async reconcileVote(input:unknown){const r=VoteReconcileRequestSchema.parse(input),result=await this.request('/api/votes/reconcile',VoteReconcileResponseSchema,r);if('status'in result)return result;await checkVoteRecord(r,result.record);const {dataHash:_dataHash,hash:_hash,...record}=result.record,receipt=checkVoteReceipt(r,result.receipt,{...record,status:'SIGNED'});if(receipt.status==='PENDING'?result.record.status!=='RESERVED':result.record.status!==receipt.status||result.record.hash?.toLowerCase()!==receipt.hash.toLowerCase())throw new Error('VOTE_RESPONSE_MISMATCH');return result;}
  async reserveAcceptance(input:unknown){const request=AcceptanceReserveRequestSchema.parse(input),result=await this.request('/api/acceptances/reserve',AcceptanceReserveResponseSchema,request);if('status'in result)return result;checkAcceptanceRecord(request,result.record);return result;}
  async queryAcceptance(input:unknown){const request=AcceptanceReserveRequestSchema.parse(input),result=await this.request('/api/acceptances/query',AcceptanceQueryResponseSchema,request);if('status'in result)return result;if(result.record)checkAcceptanceRecord(request,result.record);return result;}
  async recordAcceptanceSignature(input:unknown){const request=AcceptanceSignatureRequestSchema.parse(input),result=await this.request('/api/acceptances/record-signature',AcceptanceSignatureResponseSchema,request);if('status'in result)return result;checkAcceptanceRecord(request,result.record);const expected=await verifyAcceptanceSignature(request,result.record.committee);if(expected.signatureHash.toLowerCase()!==result.record.signatureHash?.toLowerCase())throw new Error('ACCEPTANCE_RESPONSE_MISMATCH');return result;}
  async reserveDelivery(input:unknown){const r=DeliveryReserveRequestSchema.parse(input),result=await this.request(`/api/orders/${r.payload.intent.orderId}/deliver`,DeliveryReserveResponseSchema,OrderDeliveryRequestSchema.parse({...r,report:reportDelivery(r.payload,r.dataset).report}));if('status'in result)return result;checkDeliveryRecord(r,result.record);return result;}
  async reconcileDelivery(input:unknown){const r=DeliveryReconcileRequestSchema.parse(input),result=await this.request(`/api/orders/${r.payload.intent.orderId}/deliver`,DeliveryReconcileResponseSchema,OrderDeliveryRequestSchema.parse({...r,report:reportDelivery(r.payload,r.dataset).report}));if('status'in result)return result;checkDeliveryRecord(r,result.record);const receipt=checkDeliveryReceipt(r,result.receipt);if(receipt.status==='PENDING'?result.record.status!=='RESERVED':result.record.status!==receipt.status||result.record.hash?.toLowerCase()!==receipt.hash.toLowerCase())throw new Error('DELIVERY_RESPONSE_MISMATCH');return result;}
  async prepareDelivery(input:unknown){const request=DeliveryPrepareRequestSchema.parse(input);return checkDeliveryPreparation(request,await this.request('/api/orders/prepare-delivery',DeliveryPrepareResponseSchema,request));}
  async prepareAcceptance(input:unknown){const request=AcceptancePrepareRequestSchema.parse(input);return checkAcceptancePreparation(request,await this.request('/api/orders/prepare-acceptance',AcceptancePrepareResponseSchema,request));}
  async submitOriginal(input:unknown){const request=FundingSubmitRequestSchema.parse(input);return checkOrderSubmissionResponse(request.payload,await this.request('/api/orders/submit',OrderSubmissionResponseSchema,request));}
  async reconcileFunding(input:unknown){const request=FundingReconcileRequestSchema.parse(input);return checkOrderSubmissionResponse(request.payload,await this.request('/api/orders/reconcile',OrderSubmissionResponseSchema,request));}
  async reserveApproval(input:unknown){
    const request=ApprovalReserveRequestSchema.parse(input),result=await this.request('/api/asset-approvals/reserve',ApprovalReserveResponseSchema,request);
    if('status'in result)return result;this.checkApprovalRecord(result.record,request);return result;
  }
  async reconcileApproval(input:unknown){
    const request=ApprovalReconcileRequestSchema.parse(input),result=await this.request('/api/asset-approvals/reconcile',ApprovalReconcileResponseSchema,request);
    if('status'in result)return result;this.checkApprovalRecord(result.record,request);
    const r=result.receipt;if(r.hash.toLowerCase()!==request.hash.toLowerCase())throw new Error('APPROVAL_RESPONSE_MISMATCH');
    if(r.status==='PENDING'&&result.record.status!=='RESERVED')throw new Error('APPROVAL_RESPONSE_MISMATCH');
    if(r.status!=='PENDING'&&(r.orderId.toLowerCase()!==request.payload.grant.orderId.toLowerCase()||r.step!==request.step||r.approvedAmount!==result.record.amount||r.exactAllowance!==(r.currentAllowance===request.payload.grant.amount)||result.record.status!==r.status||result.record.hash?.toLowerCase()!==r.hash.toLowerCase()))throw new Error('APPROVAL_RESPONSE_MISMATCH');
    return result;
  }
  private checkApprovalRecord(record:import('./approval-api.js').ApprovalRecord,request:ReturnType<typeof ApprovalReserveRequestSchema.parse>){
    const g=request.payload.grant;
    if(record.chainId!==g.chainId||record.nonce!==g.nonce||record.amount!==(request.step==='RESET'?'0':g.amount)||record.step!==request.step
      ||([['owner',g.owner],['asset',g.asset],['spender',g.arbiter],['orderId',g.orderId],['contextHash',g.contextHash]] as const).some(([key,value])=>record[key].toLowerCase()!==value.toLowerCase()))throw new Error('APPROVAL_RESPONSE_MISMATCH');
  }
  catalog(){return this.request('/api/catalog',CatalogResponseSchema);}
  async recoverReceipt(input:unknown){
    const r=ReceiptRecoveryRequestSchema.parse(input),config=await this.configuration(),rule=config.purchaseRule,d=config.recoveryDeployment;
    if(!rule||!d||rule.questionConfigHash!==questionConfigHash(rule.minConfidence,rule.questionVersion??1))throw Error('REVIEW_CONFIGURATION_REQUIRED');
    const v=await this.request('/api/intent/receipt-recovery',ReceiptRecoveryResponseSchema,r);if(v.status!=='SIGNED')return v;
    const e=r.request.intent,ev=v.evaluation;if(ev.source!=='JEV'||ev.executable||ev.decision!=='PASS'||ev.modelId!==rule.model||ev.questionConfigHash!==rule.questionConfigHash||aggregateJev({model:ev.modelId,answers:ev.answers,usage:ev.usage},rule.minConfidence)!=='PASS')throw Error('RECEIPT_RECOVERY_RESPONSE_MISMATCH');
    if(e.chainId!==d.chainId||e.arbiter.toLowerCase()!==d.arbiter.toLowerCase()||e.asset.toLowerCase()!==d.asset.toLowerCase()||e.committeeHash.toLowerCase()!==committeeHash(d.committee).toLowerCase())throw Error('RECEIPT_RECOVERY_RESPONSE_MISMATCH');
    for(const receipt of [v.originalReceipt,v.receipt])if(receipt.contextHash.toLowerCase()!==contextHash(e).toLowerCase()||receipt.policyHash.toLowerCase()!==policyHash(r.request.policy).toLowerCase()||receipt.purchaseEvidenceCommitment.toLowerCase()!==purchaseEvidenceHash(r.request.evidence).toLowerCase()||receipt.reviewer.toLowerCase()!==d.reviewer.toLowerCase()||receipt.modelId!==rule.model||receipt.questionConfigHash!==rule.questionConfigHash||BigInt(receipt.expiresAt)>BigInt(r.request.quote.expiresAt)||BigInt(receipt.expiresAt)>BigInt(e.deliveryDeadline)||!await verifyReceiptSignature(receipt,{chainId:e.chainId,arbiter:e.arbiter}))throw Error('RECEIPT_RECOVERY_RESPONSE_MISMATCH');
    const {signature:_originalSignature,expiresAt:_originalExpiry,...originalFields}=v.originalReceipt,{signature:_signature,expiresAt:_expiry,...currentFields}=v.receipt,{signature:_unused,...unsigned}=v.receipt;
    if(JSON.stringify(originalFields)!==JSON.stringify(currentFields)||v.receiptHash!==receiptHash(unsigned,{chainId:e.chainId,arbiter:e.arbiter})||BigInt(v.receipt.expiresAt)<BigInt(v.originalReceipt.expiresAt)||BigInt(v.reviewFinishedAt)<BigInt(v.reviewStartedAt)||BigInt(v.receipt.expiresAt)>this.clock()+300n)throw Error('RECEIPT_RECOVERY_RESPONSE_MISMATCH');
    // Expired signed receipts are metadata here. prepareOriginal still enforces current validity.
    return v;
  }
  async propose(input:unknown){const parsed=ProposeRequestSchema.parse(input),r={...parsed,evidenceSalt:parsed.evidenceSalt??createEvidenceSalt()},v=await this.request('/api/intent/propose',ProposeResultSchema,r);if(v.status!=='DRAFT')return v;const e=v.intent,q=v.quote,eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();if(v.evidence.schemaVersion!==2||!eq(v.evidence.salt,r.evidenceSalt)||!eq(policyHash(v.policy),policyHash(r.policy))||!eq(e.policyHash,policyHash(r.policy))||!eq(e.taskId,r.policy.taskId)||!eq(e.datasetHash,r.policy.datasetHash)||!eq(e.buyer,r.buyer)||!eq(e.asset,r.policy.allowedAsset)||v.evidence.taskText!==r.taskText||!r.quoteRefs.some(id=>eq(id,q.quoteId))||!eq(e.purchaseEvidenceCommitment,purchaseEvidenceHash(v.evidence))||!eq(q.seller,e.seller)||!eq(q.payee,e.payee)||!eq(q.asset,e.asset)||q.amount!==e.price||!eq(termsHash(q.serviceTerms),q.serviceTermsHash)||!eq(e.serviceTermsHash,q.serviceTermsHash)||BigInt(e.price)+BigInt(e.bond)>BigInt(r.policy.budget)||r.additionalEvidence?.some(doc=>!v.evidence.documents.some(actual=>actual.id===doc.id&&eq(actual.subjectQuoteId,doc.subjectQuoteId)&&actual.text===doc.text))||!await verifyQuoteSignature(q,{chainId:e.chainId,arbiter:e.arbiter}))throw new Error('PROPOSAL_RESPONSE_MISMATCH');return v;}
  async review(input:unknown){
    const r=ReviewRequestSchema.parse(input),started=this.clock(),config=await this.configuration(),rule=config.purchaseRule;
    if(!rule||rule.questionConfigHash!==questionConfigHash(rule.minConfidence,rule.questionVersion??1))throw new Error('REVIEW_CONFIGURATION_REQUIRED');
    const v=await this.request('/api/intent/review',ReviewResultSchema,r);
    if(v.source==='JEV'){
      const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
      if(v.modelId!==rule.model||!eq(v.questionConfigHash,rule.questionConfigHash))throw new Error('REVIEW_RESPONSE_MISMATCH');
      const actual=aggregateJev({model:v.modelId,answers:v.answers,usage:v.usage},rule.minConfidence);
      if(v.decision!==actual&&!(actual==='PASS'&&v.decision==='ABSTAIN'&&!v.executable&&['REVIEW_EXPIRED','REVIEWER_UNAVAILABLE'].includes(v.code??'')))throw new Error('REVIEW_RESPONSE_MISMATCH');
      if(v.executable){
        const p=v.receipt,e=r.intent,d=config.recoveryDeployment,now=this.clock();
        if(!d||e.chainId!==d.chainId||!eq(e.arbiter,d.arbiter)||!eq(e.asset,d.asset)||!eq(e.reviewer,d.reviewer)||!eq(e.committeeHash,committeeHash(d.committee))
          ||!eq(p.contextHash,contextHash(e))||!eq(p.policyHash,policyHash(r.policy))||!eq(p.purchaseEvidenceCommitment,purchaseEvidenceHash(r.evidence))||!eq(p.reviewer,e.reviewer)||p.modelId!==v.modelId||!eq(p.questionConfigHash,v.questionConfigHash)
          ||started<0n||now<started||BigInt(p.expiresAt)<=now||BigInt(p.expiresAt)>BigInt(r.quote.expiresAt)||BigInt(p.expiresAt)>BigInt(e.deliveryDeadline)||!await verifyReceiptSignature(p,{chainId:e.chainId,arbiter:e.arbiter}))throw new Error('REVIEW_RESPONSE_MISMATCH');
        const current=this.clock();if(current<now||BigInt(p.expiresAt)<=current)throw new Error('REVIEW_RESPONSE_MISMATCH');
      }
    }
    return v;
  }
  async preflight(input:unknown){
    const request=PreflightRequestSchema.parse(input),result=await this.request('/api/intent/preflight',PreflightResultSchema,request);
    if('status'in result)return result;
    if(result.block.finality!=='finalized')throw new Error('PREFLIGHT_FINALITY_REQUIRED');
    const g=request.grant;
    if(result.chainId!==g.chainId||result.nonce!==g.nonce||result.amount!==g.amount||result.deadline!==g.deadline
      ||([['arbiter',g.arbiter],['asset',g.asset],['buyer',g.owner],['orderId',g.orderId],['contextHash',g.contextHash]] as const).some(([key,value])=>result[key].toLowerCase()!==value.toLowerCase()))throw new Error('PREFLIGHT_RESPONSE_MISMATCH');
    return result;
  }
}
