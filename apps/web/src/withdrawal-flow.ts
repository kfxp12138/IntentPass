import {WithdrawalRequestSchema,verifyWithdrawalRequest,checkWithdrawalPreparation,checkWithdrawalReceipt} from '../../../packages/protocol/src/withdrawal.js';
import {WithdrawalReserveResponseSchema,WithdrawalQueryResponseSchema,WithdrawalReconcileResponseSchema,checkWithdrawalRecord,type WithdrawalRecord} from '../../../packages/protocol/src/withdrawal-api.js';
import {digest} from '../../../packages/protocol/src/schemas.js';
import type {OrderSnapshot} from '../../../packages/protocol/src/escrow-read.js';
import {PurchaseClient} from '../../../packages/protocol/src/purchase-client.js';
import {browserSession,type BrowserSession} from './browser-session.js';
export interface WithdrawalPort {prepareWithdrawal:(input:unknown)=>Promise<unknown>;reserveWithdrawal:(input:unknown)=>Promise<unknown>;queryWithdrawal:(input:unknown)=>Promise<unknown>;reconcileWithdrawal:(input:unknown)=>Promise<unknown>;}
export interface WithdrawalAttempt {status:'PREPARING'|'RESERVED'|'SUBMITTED'|'UNKNOWN'|'CONFIRMED'|'REVERTED';attempt?:string;hash?:string;}
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
/** Original authorization is privately cloned. A fresh durable slot is required
 * for each explicit withdrawal. Unknown outcomes only query or prove the original
 * transaction; another attempt requires the latest retained reverted hash.
 */
export class WithdrawalFlow {
  private input:ReturnType<typeof WithdrawalRequestSchema.parse>;
  private attempt:WithdrawalAttempt|undefined;
  private record:WithdrawalRecord|undefined;
  private history=new Map<string,WithdrawalRecord>();
  private observed:OrderSnapshot|undefined;
  private busy=false;
  constructor(input:unknown,private subject:string,private session:BrowserSession=browserSession,private client:WithdrawalPort=new PurchaseClient(location.origin,()=>session.token())){this.input=WithdrawalRequestSchema.parse(input);}
  get attemptState(){return this.attempt?structuredClone(this.attempt):undefined;}
  get originalRecord(){return this.record?structuredClone(this.record):undefined;}
  private guard(active:()=>void){const epoch=this.session.generation;return ()=>{active();if(epoch!==this.session.generation)throw new Error('SESSION_CHANGED');};}
  private async current(guard:()=>void){guard();const principal=await this.session.verified(),config=await this.session.configuration();guard();if(principal.subject!==this.subject||!config.recoveryDeployment)throw new Error('SESSION_CHANGED');await verifyWithdrawalRequest(this.input,principal.wallets,config.recoveryDeployment);guard();}
  private async exclusive<T>(work:()=>Promise<T>){if(this.busy)throw new Error('WITHDRAWAL_OPERATION_PENDING');this.busy=true;try{return await work();}finally{this.busy=false;}}
  private observe(order:OrderSnapshot){const old=this.observed;if(old&&(BigInt(order.block.number)<BigInt(old.block.number)||order.block.number===old.block.number&&!eq(order.block.hash,old.block.hash)||old.state.startsWith('ALLOCATED_')&&order.state!==old.state))throw new Error('WITHDRAWAL_SNAPSHOT_CHANGED');this.observed=structuredClone(order);}
  private check(candidate:unknown){const r=checkWithdrawalRecord(this.input,candidate),old=this.record,history=this.history.get(r.attempt);
    if(history&&(history.retryOf!==r.retryOf||history.allocationState!==r.allocationState||history.amount!==r.amount||history.status!=='RESERVED'&&(r.status!==history.status||!r.hash||!history.hash||!eq(r.hash,history.hash)||JSON.stringify(r.receiptBlock).toLowerCase()!==JSON.stringify(history.receiptBlock).toLowerCase())))throw new Error('WITHDRAWAL_RECORD_LOCKED');
    if(old&&old.attempt!==r.attempt&&(old.status!=='REVERTED'||BigInt(r.attempt)!==BigInt(old.attempt)+1n||!old.hash||!r.retryOf||!eq(r.retryOf,old.hash)))throw new Error('WITHDRAWAL_RECORD_LOCKED');
    if(this.attempt?.attempt===r.attempt&&this.attempt.hash&&r.hash&&!eq(this.attempt.hash,r.hash))throw new Error('WITHDRAWAL_HASH_LOCKED');return r;
  }
  private retain(r:WithdrawalRecord){this.record=structuredClone(r);this.history.set(r.attempt,structuredClone(r));}
  private state(r:WithdrawalRecord){const hash=r.hash??(this.attempt?.attempt===r.attempt?this.attempt.hash:undefined);this.attempt={status:r.status==='RESERVED'?(hash?'SUBMITTED':'UNKNOWN'):r.status,attempt:r.attempt,...(hash?{hash}:{})};}
  private unknown(){const hash=this.attempt?.status==='SUBMITTED'||this.attempt?.status==='UNKNOWN'?this.attempt.hash:undefined;this.attempt={status:'UNKNOWN',...(this.record?.status==='RESERVED'?{attempt:this.record.attempt}:{}),...(hash?{hash}:{})};}
  private async preparation(guard:()=>void){await this.current(guard);const p=checkWithdrawalPreparation(this.input,await this.client.prepareWithdrawal(structuredClone(this.input)));await this.current(guard);if(p.blockers.length||p.transferEligible!==true||p.withdrawn!=='0'||p.amount==='0'||this.record&&(p.amount!==this.record.amount||p.order.state!==this.record.allocationState))throw new Error('WITHDRAWAL_BLOCKED');this.observe(p.order as OrderSnapshot);return p;}
  withdraw(confirmation:boolean,retryOf?:string,active:()=>void=()=>{}){return this.exclusive(async()=>{
    if(confirmation!==true)throw new Error('WITHDRAWAL_CONFIRMATION_REQUIRED');if(retryOf!==undefined){digest.parse(retryOf);if(this.attempt?.status!=='REVERTED'||this.record?.status!=='REVERTED'||!this.record.hash||!eq(this.record.hash,retryOf))throw new Error('WITHDRAWAL_RETRY_NOT_ALLOWED');}else if(this.attempt||this.record)throw new Error('WITHDRAWAL_RECONCILIATION_REQUIRED');const guard=this.guard(active);let requested=false;this.attempt={status:'PREPARING'};
    try{await this.current(guard);requested=true;const result=WithdrawalReserveResponseSchema.parse(await this.client.reserveWithdrawal({...structuredClone(this.input),confirm:true,...(retryOf?{retryOf}:{})}));if('status'in result)throw new Error('WITHDRAWAL_RESERVATION_REJECTED');const record=this.check(result.record);if(retryOf&&(!record.retryOf||!eq(record.retryOf,retryOf))||result.created&&!retryOf&&record.attempt!=='1')throw new Error('WITHDRAWAL_RESPONSE_MISMATCH');await this.current(guard);this.retain(record);
      if(!result.created){this.state(record);return {kind:'ALREADY_RECORDED' as const,record};}this.attempt={status:'RESERVED',attempt:record.attempt};await this.preparation(guard);
      const sent=await this.session.withdrawOrder(structuredClone(this.input),result,async candidate=>{if(JSON.stringify(WithdrawalRequestSchema.parse(candidate))!==JSON.stringify(this.input))throw new Error('WITHDRAWAL_INPUT_CHANGED');return this.preparation(guard);},guard);
      if(sent.kind!=='WITHDRAWAL_SUBMITTED'||!eq(sent.orderId,record.orderId)||!eq(sent.beneficiary,record.beneficiary)||sent.amount!==record.amount||sent.attempt!==record.attempt||!eq(sent.authorizationHash,record.authorizationHash)||!eq(sent.dataHash,record.dataHash)||sent.canSubmitPayment!==false)throw new Error('WITHDRAWAL_RESPONSE_MISMATCH');this.attempt={status:'SUBMITTED',attempt:record.attempt,hash:digest.parse(sent.hash)};await this.current(guard);return sent;
    }catch(e){if(requested)this.unknown();else this.attempt=this.record?{status:this.record.status==='RESERVED'?'UNKNOWN':this.record.status,attempt:this.record.attempt,...(this.record.hash?{hash:this.record.hash}:{})}:undefined;throw e;}
  });}
  query(active:()=>void=()=>{}){return this.exclusive(async()=>{const guard=this.guard(active);try{await this.current(guard);const result=WithdrawalQueryResponseSchema.parse(await this.client.queryWithdrawal(structuredClone(this.input)));await this.current(guard);if('status'in result)throw new Error('WITHDRAWAL_QUERY_REJECTED');if(result.record){const r=this.check(result.record);this.retain(r);this.state(r);}else if(this.attempt||this.record)throw new Error('WITHDRAWAL_RECORD_MISSING');return result;}catch(e){if(this.attempt)this.unknown();throw e;}});}
  reconcile(providedHash?:string,active:()=>void=()=>{}){return this.exclusive(async()=>{const guard=this.guard(active);await this.current(guard);if(!this.record)throw new Error('WITHDRAWAL_QUERY_REQUIRED');const hash=digest.parse(providedHash??this.attempt?.hash??this.record.hash);if(this.attempt?.hash&&!eq(this.attempt.hash,hash)||this.record.hash&&!eq(this.record.hash,hash))throw new Error('WITHDRAWAL_HASH_LOCKED');const request={...structuredClone(this.input),attempt:this.record.attempt,hash};
    try{const result=WithdrawalReconcileResponseSchema.parse(await this.client.reconcileWithdrawal(request));await this.current(guard);if('status'in result)throw new Error('WITHDRAWAL_RECONCILIATION_REJECTED');const r=this.check(result.record);if(r.attempt!==request.attempt)throw new Error('WITHDRAWAL_RESPONSE_MISMATCH');const receipt=checkWithdrawalReceipt({...structuredClone(this.input),hash},result.receipt);
      if(receipt.status==='PENDING'){if(r.status!=='RESERVED')throw new Error('WITHDRAWAL_RESPONSE_MISMATCH');this.attempt={status:'SUBMITTED',attempt:r.attempt,hash};}
      else{if(r.status!==receipt.status||!r.hash||!eq(r.hash,hash)||JSON.stringify(r.receiptBlock).toLowerCase()!==JSON.stringify(receipt.receiptBlock).toLowerCase())throw new Error('WITHDRAWAL_RESPONSE_MISMATCH');this.observe(receipt.order as OrderSnapshot);this.attempt={status:receipt.status,attempt:r.attempt,hash};}this.retain(r);return result;
    }catch(e){this.unknown();throw e;}
  });}
}
