import {ApprovalReserveResponseSchema,ApprovalReconcileResponseSchema,ApprovalStepSchema} from '../../../packages/protocol/src/approval-api.js';
import {AuthorizationPayloadSchema} from '../../../packages/capsule/src/format.js';
import {verifyOriginalAuthorization} from '../../../packages/capsule/src/recovery.js';
import {prepareExactApproval,type ApprovalStep} from '../../../packages/capsule/src/asset-approval.js';
import {PurchaseClient} from '../../../packages/protocol/src/purchase-client.js';
import {browserSession,type BrowserSession} from './browser-session.js';
import {digest} from '../../../packages/protocol/src/schemas.js';
export interface ApprovalPort {preflight:(request:unknown)=>Promise<unknown>;reserveApproval:(request:unknown)=>Promise<unknown>;reconcileApproval:(request:unknown)=>Promise<unknown>;}
export interface ApprovalAttempt {status:'PREPARING'|'RESERVED'|'SUBMITTED'|'UNKNOWN'|'CONFIRMED'|'REVERTED';hash?:string;}
/** Original signed authorization only. Durable reservation precedes every wallet request.
 * New page instances must reserve again, receiving created=false for the original attempt.
 */
export class AssetApprovalFlow {
  private payload:ReturnType<typeof AuthorizationPayloadSchema.parse>;
  private attempts:Partial<Record<ApprovalStep,ApprovalAttempt>>={};
  private observedBlocks:Partial<Record<ApprovalStep,{number:string;hash:string}>>={};
  private busy=false;
  constructor(input:unknown,private subject:string,private backupReady:()=>boolean,private session:BrowserSession=browserSession,
    private client:ApprovalPort=new PurchaseClient(location.origin,()=>session.token()),private clock:()=>bigint=()=>BigInt(Math.floor(Date.now()/1000))){this.payload=AuthorizationPayloadSchema.parse(input);}
  get attemptStates(){return structuredClone(this.attempts);}
  private async current(active:()=>void){
    active();const principal=await this.session.verified(),config=await this.session.configuration();active();
    if(principal.subject!==this.subject||!config.recoveryDeployment)throw new Error('SESSION_CHANGED');
    await verifyOriginalAuthorization(this.payload,principal.wallets,config.recoveryDeployment);active();return {principal,deployment:config.recoveryDeployment};
  }
  private async exclusive<T>(work:()=>Promise<T>){if(this.busy)throw new Error('APPROVAL_OPERATION_PENDING');this.busy=true;try{return await work();}finally{this.busy=false;}}
  approve(rawStep:ApprovalStep,active:()=>void=()=>{}){return this.exclusive(async()=>{
    const step=ApprovalStepSchema.parse(rawStep),generation=this.session.generation,guard=()=>{active();if(this.session.generation!==generation)throw new Error('SESSION_CHANGED');};
    if(!this.backupReady())throw new Error('ENCRYPTED_BACKUP_REQUIRED');
    if(this.attempts[step]||Object.values(this.attempts).some(a=>!['CONFIRMED','REVERTED'].includes(a.status)))throw new Error('APPROVAL_RECONCILIATION_REQUIRED');
    this.attempts[step]={status:'PREPARING'};let reservationRequested=false;
    try{
      const {principal,deployment}=await this.current(guard),observation=await this.client.preflight(structuredClone({intent:this.payload.intent,grant:this.payload.grant}));guard();
      await prepareExactApproval(this.payload,deployment,principal.wallets,observation,step,this.clock());await this.current(guard);
      reservationRequested=true;
      const reserved=ApprovalReserveResponseSchema.parse(await this.client.reserveApproval({payload:structuredClone(this.payload),step}));
      if('status'in reserved)throw new Error('APPROVAL_RESERVATION_REJECTED');
      this.checkRecord(reserved.record,step);
      if(!reserved.created){this.attempts[step]={status:reserved.record.status==='RESERVED'?'UNKNOWN':reserved.record.status,...(reserved.record.hash?{hash:reserved.record.hash}:{})};return {status:'ALREADY_RECORDED' as const,record:reserved.record};}
      this.attempts[step]={status:'RESERVED'};await this.current(guard);
      const sent=await this.session.approveAsset(this.payload,step,request=>this.client.preflight(request),guard);
      if(sent.orderId.toLowerCase()!==this.payload.grant.orderId.toLowerCase()||sent.step!==step||sent.amount!==(step==='RESET'?'0':this.payload.grant.amount))throw new Error('APPROVAL_RESPONSE_MISMATCH');
      this.attempts[step]={status:'SUBMITTED',hash:digest.parse(sent.hash)};await this.current(guard);return sent;
    }catch(error){if(reservationRequested){if(this.attempts[step]?.status!=='SUBMITTED')this.attempts[step]={status:'UNKNOWN'};}else delete this.attempts[step];throw error;}
  });}
  private checkRecord(record:import('../../../packages/protocol/src/approval-api.js').ApprovalRecord,step:ApprovalStep){const g=this.payload.grant;if(record.step!==step||record.chainId!==g.chainId||record.nonce!==g.nonce||record.amount!==(step==='RESET'?'0':g.amount)||([['owner',g.owner],['asset',g.asset],['spender',g.arbiter],['orderId',g.orderId],['contextHash',g.contextHash]] as const).some(([key,value])=>record[key].toLowerCase()!==value.toLowerCase()))throw new Error('APPROVAL_RESPONSE_MISMATCH');}
  reconcile(rawStep:ApprovalStep,providedHash?:string,active:()=>void=()=>{}){return this.exclusive(async()=>{
    const step=ApprovalStepSchema.parse(rawStep),generation=this.session.generation,guard=()=>{active();if(this.session.generation!==generation)throw new Error('SESSION_CHANGED');};
    await this.current(guard);const old=this.attempts[step],hash=digest.parse(providedHash??old?.hash);
    if(old?.hash&&old.hash.toLowerCase()!==hash.toLowerCase())throw new Error('APPROVAL_HASH_LOCKED');
    const result=ApprovalReconcileResponseSchema.parse(await this.client.reconcileApproval({payload:structuredClone(this.payload),step,hash}));await this.current(guard);
    if('status'in result)throw new Error('APPROVAL_RECONCILIATION_REJECTED');
    this.checkRecord(result.record,step);const r=result.receipt;if(r.hash.toLowerCase()!==hash.toLowerCase()||(r.status==='PENDING'?result.record.status!=='RESERVED':r.orderId.toLowerCase()!==this.payload.grant.orderId.toLowerCase()||r.step!==step||r.approvedAmount!==(step==='RESET'?'0':this.payload.grant.amount)||r.exactAllowance!==(r.currentAllowance===this.payload.grant.amount)||result.record.status!==r.status||result.record.hash?.toLowerCase()!==r.hash.toLowerCase()))throw new Error('APPROVAL_RESPONSE_MISMATCH');
    if(old&&['CONFIRMED','REVERTED'].includes(old.status)&&r.status!==old.status)throw new Error('APPROVAL_RECORD_LOCKED');
    if(r.status!=='PENDING'){
      const previous=this.observedBlocks[step];if(previous&&(BigInt(r.block.number)<BigInt(previous.number)||r.block.number===previous.number&&r.block.hash.toLowerCase()!==previous.hash.toLowerCase()))throw new Error('APPROVAL_SNAPSHOT_STALE');
      this.observedBlocks[step]={...r.block};
    }
    this.attempts[step]={status:r.status==='PENDING'?'SUBMITTED':r.status,hash};return result;
  });}
}
