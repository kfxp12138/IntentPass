import {DeliveryReserveRequestSchema,DeliveryReserveResponseSchema,DeliveryReconcileResponseSchema,checkDeliveryRecord,checkDeliveryReceipt} from '../../../packages/protocol/src/delivery-api.js';
import {checkDeliveryPreparation,prepareDelivery} from '../../../packages/protocol/src/fulfillment.js';
import {verifyOriginalAuthorization} from '../../../packages/capsule/src/recovery.js';
import {digest} from '../../../packages/protocol/src/schemas.js';
import type {OrderSnapshot} from '../../../packages/protocol/src/escrow-read.js';
import {PurchaseClient} from '../../../packages/protocol/src/purchase-client.js';
import {browserSession,type BrowserSession} from './browser-session.js';
export interface DeliveryPort {prepareDelivery:(input:unknown)=>Promise<unknown>;reserveDelivery:(input:unknown)=>Promise<unknown>;reconcileDelivery:(input:unknown)=>Promise<unknown>;}
export interface DeliveryAttempt {status:'PREPARING'|'RESERVED'|'SUBMITTED'|'UNKNOWN'|'CONFIRMED'|'REVERTED';hash?:string;}
/** A private original-role copy. Durable created=true is required before wallet access. */
export class DeliveryFlow {
  private input:ReturnType<typeof DeliveryReserveRequestSchema.parse>;
  private attempt:DeliveryAttempt|undefined;
  private busy=false;
  private terminal:'CONFIRMED'|'REVERTED'|undefined;
  private observed:OrderSnapshot|undefined;
  constructor(input:unknown,private subject:string,private session:BrowserSession=browserSession,private client:DeliveryPort=new PurchaseClient(location.origin,()=>session.token()),private clock=()=>BigInt(Math.floor(Date.now()/1000))){this.input=DeliveryReserveRequestSchema.parse(input);}
  get attemptState(){return this.attempt?structuredClone(this.attempt):undefined;}
  private async current(guard:()=>void){guard();const principal=await this.session.verified(),config=await this.session.configuration();guard();if(principal.subject!==this.subject||!config.recoveryDeployment)throw new Error('SESSION_CHANGED');if(!principal.wallets.some(w=>w.toLowerCase()===this.input.payload.intent.seller.toLowerCase()))throw new Error('FULFILLMENT_ROLE_MISMATCH');await verifyOriginalAuthorization(this.input.payload,[this.input.payload.intent.buyer],config.recoveryDeployment);guard();return {principal,deployment:config.recoveryDeployment};}
  private observe(order:OrderSnapshot){const old=this.observed;if(old&&(BigInt(order.block.number)<BigInt(old.block.number)||order.block.number===old.block.number&&order.block.hash.toLowerCase()!==old.block.hash.toLowerCase()||old.state.startsWith('ALLOCATED_')&&order.state!==old.state))throw new Error('DELIVERY_SNAPSHOT_CHANGED');this.observed=structuredClone(order);}
  private async exclusive<T>(work:()=>Promise<T>){if(this.busy)throw new Error('DELIVERY_OPERATION_PENDING');this.busy=true;try{return await work();}finally{this.busy=false;}}
  private async preparation(guard:()=>void){const {principal,deployment}=await this.current(guard),result=checkDeliveryPreparation(this.input,await this.client.prepareDelivery(structuredClone(this.input)));await this.current(guard);if('status'in result)throw new Error('FULFILLMENT_PREPARATION_REJECTED');await prepareDelivery(this.input,principal.wallets,deployment,async()=>({snapshot:result.order,finality:result.finality}),this.clock);guard();this.observe(result.order as OrderSnapshot);return result;}
  deliver(confirmation:boolean,active:()=>void=()=>{}){return this.exclusive(async()=>{
    if(confirmation!==true)throw new Error('FULFILLMENT_CONFIRMATION_REQUIRED');if(this.attempt)throw new Error('DELIVERY_RECONCILIATION_REQUIRED');
    const generation=this.session.generation,guard=()=>{active();if(generation!==this.session.generation)throw new Error('SESSION_CHANGED');};let reserved=false;this.attempt={status:'PREPARING'};
    try{await this.current(guard);reserved=true;
      const result=DeliveryReserveResponseSchema.parse(await this.client.reserveDelivery(structuredClone(this.input)));if('status'in result)throw new Error('DELIVERY_RESERVATION_REJECTED');checkDeliveryRecord(this.input,result.record);
      if(!result.created){this.attempt={status:result.record.status==='RESERVED'?'UNKNOWN':result.record.status,...(result.record.hash?{hash:result.record.hash}:{})};if(result.record.status!=='RESERVED')this.terminal=result.record.status;await this.current(guard);return {kind:'ALREADY_RECORDED' as const,record:result.record};}
      this.attempt={status:'RESERVED'};await this.preparation(guard);await this.current(guard);
      const sent=await this.session.deliverOrder(structuredClone(this.input),async request=>{if(JSON.stringify(DeliveryReserveRequestSchema.parse(request))!==JSON.stringify(this.input))throw new Error('DELIVERY_INPUT_CHANGED');return this.preparation(guard);},guard);
      if(sent.kind!=='DELIVERY_SUBMITTED'||sent.orderId.toLowerCase()!==this.input.payload.intent.orderId.toLowerCase()||sent.evidenceHash.toLowerCase()!==result.record.evidenceHash.toLowerCase())throw new Error('DELIVERY_RESPONSE_MISMATCH');
      this.attempt={status:'SUBMITTED',hash:digest.parse(sent.hash)};await this.current(guard);return sent;
    }catch(e){if(reserved)this.attempt={status:'UNKNOWN',...(this.attempt?.hash?{hash:this.attempt.hash}:{})};else this.attempt=undefined;throw e;}
  });}
  reconcile(providedHash?:string,active:()=>void=()=>{}){return this.exclusive(async()=>{
    const generation=this.session.generation,guard=()=>{active();if(generation!==this.session.generation)throw new Error('SESSION_CHANGED');};await this.current(guard);const hash=digest.parse(providedHash??this.attempt?.hash);
    if(this.attempt?.hash&&this.attempt.hash.toLowerCase()!==hash.toLowerCase())throw new Error('DELIVERY_HASH_LOCKED');
    const query={...structuredClone(this.input),hash};try{const result=DeliveryReconcileResponseSchema.parse(await this.client.reconcileDelivery(query));await this.current(guard);if('status'in result)throw new Error('DELIVERY_RECONCILIATION_REJECTED');checkDeliveryRecord(this.input,result.record);const receipt=checkDeliveryReceipt(query,result.receipt);
      if(receipt.status==='PENDING'){if(result.record.status!=='RESERVED'||this.terminal)throw new Error('DELIVERY_RESPONSE_MISMATCH');this.attempt={status:'SUBMITTED',hash};}
      else{if(result.record.status!==receipt.status||result.record.hash?.toLowerCase()!==hash.toLowerCase()||this.terminal&&this.terminal!==receipt.status)throw new Error('DELIVERY_RESPONSE_MISMATCH');this.observe(receipt.order as OrderSnapshot);this.terminal=receipt.status;this.attempt={status:receipt.status,hash};}
      return result;
    }catch(e){this.attempt={status:'UNKNOWN',...(this.attempt?.hash?{hash:this.attempt.hash}:{})};throw e;}
  });}
}
