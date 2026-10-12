import {ExecutionScopeSchema,executionScopeHash,assertBackgroundTask,assertBackgroundAuthorization,assertBackgroundUnsignedAuthorization,type ExecutionScope} from '../../../packages/automation/src/background-scope.js';
import {BackgroundVault} from '../../../packages/storage/src/background-vault.js';
import {verifyOriginalAuthorization} from '../../../packages/capsule/src/recovery.js';
import {AutomaticPreparation,AutomaticPayment} from '../../web/src/purchase-automation.js';
import type {PurchaseFlow} from '../../web/src/purchase-flow.js';
import type {CompleteOrderAutomation} from '../../web/src/order-automation.js';
import {checkWithdrawalReceipt} from '../../../packages/protocol/src/withdrawal.js';
import {WithdrawalReconcileResponseSchema,checkWithdrawalRecord} from '../../../packages/protocol/src/withdrawal-api.js';
import {createHash} from 'node:crypto';
import {reportDelivery} from '../../../packages/protocol/src/fulfillment.js';

export interface BackgroundActivation {scopeHash:string;localPlaintextProcessingApproved:boolean;walletDelegationApproved:boolean;}
export interface BackgroundPorts {
  /** Must inspect current actual delegated wallets, policies and key possession. */
  assertDelegationReady(scope:ExecutionScope):Promise<void>;
  flow:PurchaseFlow;
  payment(payload:unknown,backupReady:()=>boolean):AutomaticPayment;
  fulfillment(payload:unknown,dataset:readonly number[]):CompleteOrderAutomation;
}
/** One approved job. No email, browser, device credential or wallet creation API.
 * Uses original controllers and proof validators. A durable lease is never
 * released following a timeout or crash; restarts require original reconciliation.
 */
export class BackgroundProcurement {
  private readonly scope:ExecutionScope;
  private readonly binding:string;
  private started=false;
  constructor(scope:unknown,private vault:BackgroundVault,private ports:BackgroundPorts,private clock=()=>BigInt(Math.floor(Date.now()/1000))){
    this.scope=ExecutionScopeSchema.parse(structuredClone(scope));this.binding=executionScopeHash(this.scope);
  }
  async run(task:unknown,activation:BackgroundActivation,progress:(stage:string)=>void=()=>{},externalActive:()=>void=()=>{}){
    if(activation.scopeHash!==this.binding||activation.localPlaintextProcessingApproved!==true||activation.walletDelegationApproved!==true)throw Error('BACKGROUND_INITIAL_SETUP_APPROVAL_REQUIRED');
    if(this.started)throw Error('BACKGROUND_ORIGINAL_JOB_RECONCILIATION_REQUIRED');
    const memory=assertBackgroundTask(this.scope,task,this.clock());
    await this.ports.assertDelegationReady(this.scope);
    if(this.started)throw Error('BACKGROUND_ORIGINAL_JOB_RECONCILIATION_REQUIRED');
    this.vault.reserve(this.binding);this.started=true;
    const active=()=>{externalActive();if(this.clock()>=BigInt(this.scope.expiresAt))throw Error('BACKGROUND_SCOPE_EXPIRED');};
    let sequence=0;
    const evidence=(name:string,value:unknown)=>this.vault.save('checkpoint',createHash('sha256').update(`${this.binding}:trace:${name}`).digest('hex'),this.binding,value);
    const checkpoint=(stage:string,verifiedComplete=false)=>{if(!/^[A-Z_]{1,64}$/.test(stage))throw Error('BACKGROUND_PROGRESS_INVALID');if(stage==='COMPLETE'&&!verifiedComplete)stage='PAYOUT_RETURNED';const id=createHash('sha256').update(`${this.binding}:${sequence++}`).digest('hex');this.vault.save('checkpoint',id,this.binding,{stage,at:String(this.clock()),...(stage==='REVIEW'&&this.ports.flow.draft?{candidate:this.ports.flow.draft}:{})});progress(stage);};
    try{
      checkpoint('BACKUP_TASK');this.vault.save('memory',this.scope.taskId.slice(2).toLowerCase(),this.binding,memory);
      // Intentionally no device hook: this is a different backend backup mode.
      const preparation=new AutomaticPreparation(this.ports.flow,this.clock);
      const prepared=await preparation.run(this.scope.quoteId?[this.scope.quoteId]:[],String(this.scope.mode==='general-job'?this.scope.profile.grantSeconds:300),checkpoint,false);active();
      evidence('preparation',{result:prepared,proposal:this.ports.flow.proposalResult??null,candidate:this.ports.flow.draft??null,review:this.ports.flow.reviewResult??null,preflight:this.ports.flow.preflightSnapshot??null});
      if(prepared!=='READY'){this.vault.save('checkpoint',createHash('sha256').update(`${this.binding}:original-preparation-stop`).digest('hex'),this.binding,{stage:'ORIGINAL_PREPARATION_STOP',reason:prepared,candidate:this.ports.flow.draft??null,review:this.ports.flow.reviewResult??null});checkpoint('STOPPED_'+prepared);return {status:'ATTENTION' as const,reason:prepared};}
      if(!this.ports.flow.authorization)throw Error('BACKGROUND_AUTHORIZATION_REQUIRED');
      assertBackgroundUnsignedAuthorization(this.scope,this.ports.flow.authorization.payload,this.clock());
      await this.ports.assertDelegationReady(this.scope);active();
      assertBackgroundUnsignedAuthorization(this.scope,this.ports.flow.authorization.payload,this.clock());
      this.vault.save('checkpoint',createHash('sha256').update(`${this.binding}:original-unsigned-grant`).digest('hex'),this.binding,{stage:'ORIGINAL_UNSIGNED_GRANT',payload:this.ports.flow.authorization.payload});
      checkpoint('SIGN_GRANT');const signed=await this.ports.flow.sign(active);active();
      const payload=assertBackgroundAuthorization(this.scope,signed.payload,this.clock());
      await verifyOriginalAuthorization(payload,[this.scope.buyer],this.scope.deployment);active();
      // Keep exact original salt, dataset and evidence together with the signed payload.
      checkpoint('BACKUP_AUTHORIZATION');this.vault.save('authorization',payload.intent.orderId.slice(2).toLowerCase(),this.binding,{payload,dataset:memory.taskInput!.dataset});
      let backupReady=true;const payment=this.ports.payment(payload,()=>backupReady);
      const funded=await payment.run(true,active,checkpoint);active();
      evidence('funding',funded);
      if(funded.status!=='CONFIRMED'){backupReady=false;checkpoint('STOPPED_'+funded.status);return {status:'ATTENTION' as const,reason:funded.status};}
      const completion=await this.ports.fulfillment(payload,memory.taskInput!.dataset).run(true,active,checkpoint);active();
      const original=WithdrawalReconcileResponseSchema.parse((completion.payout as {result:unknown}).result);
      if('status'in original)throw Error('BACKGROUND_PAYOUT_UNPROVEN');
      const request={payload,beneficiary:this.scope.payee};checkWithdrawalRecord(request,original.record);
      const receipt=checkWithdrawalReceipt({...request,hash:original.receipt.hash},original.receipt);
      if(receipt.status!=='CONFIRMED'||receipt.order.state!=='ALLOCATED_PAID'||receipt.transferredAmount!==payload.intent.price)throw Error('BACKGROUND_PAYOUT_UNPROVEN');
      const delivered=reportDelivery(payload,memory.taskInput!.dataset);
      if(delivered.evidenceHash.toLowerCase()!==receipt.order.evidenceHash.toLowerCase())throw Error('BACKGROUND_DELIVERY_UNPROVEN');
      evidence('completion',{...delivered,receipt});
      checkpoint('COMPLETE',true);return {status:'CONFIRMED' as const,orderId:payload.intent.orderId,payoutHash:receipt.hash};
    }catch(error){try{evidence('failure',{code:error instanceof Error&&/^[A-Z][A-Z0-9_]{0,100}$/.test(error.message)?error.message:'PROCUREMENT_OUTCOME_UNCONFIRMED'});checkpoint('ATTENTION');}catch{/* Preserve the original immutable lease even if backup storage fails. */}throw error;}
  }
}
