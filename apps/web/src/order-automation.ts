import {DeliveryPrepareRequestSchema,reportDelivery,assertFulfillmentOrder} from '../../../packages/protocol/src/fulfillment.js';
import {verifyOriginalAuthorization} from '../../../packages/capsule/src/recovery.js';
import {PurchaseClient} from '../../../packages/protocol/src/purchase-client.js';
import type {BrowserSession} from './browser-session.js';
import {DeliveryFlow} from './delivery-flow.js';
import {AcceptanceFlow} from './acceptance-flow.js';
import {VoteFlow} from './vote-flow.js';
import {AllocationFlow} from './allocation-flow.js';
import {WithdrawalFlow} from './withdrawal-flow.js';

export interface AutomationActors {
  seller:BrowserSession;
  members:readonly [{index:0|1|2;session:BrowserSession},{index:0|1|2;session:BrowserSession}];
  settler:BrowserSession;
  payee:BrowserSession;
}
export type OrderAutomationPhase='CHECK_ROLES'|'DELIVERY'|'MEMBER_ONE'|'MEMBER_TWO'|'SETTLEMENT'|'PAYOUT'|'COMPLETE';
/** All actors must already own or hold valid restricted authority for their role.
 * Does not create wallets, broaden permissions, log in another user, export keys,
 * renew a signature, or claim that missing role authority is automation-ready.
 */
export class CompleteOrderAutomation {
  private input:ReturnType<typeof DeliveryPrepareRequestSchema.parse>;
  private started=false;
  constructor(input:unknown,private baseUrl:string,private actors:AutomationActors,
    private clock=()=>BigInt(Math.floor(Date.now()/1000)),private wait:()=>Promise<void>=()=>new Promise(r=>setTimeout(r,2500)),private maxQueries=20){
    this.input=DeliveryPrepareRequestSchema.parse(input);
    if(actors.members[0].index===actors.members[1].index)throw Error('AUTOMATION_DISTINCT_MEMBERS_REQUIRED');
    if(!Number.isSafeInteger(maxQueries)||maxQueries<1||maxQueries>40)throw Error('AUTOMATION_QUERY_LIMIT_INVALID');
  }
  async run(confirmation:boolean,active:()=>void=()=>{},progress:(phase:OrderAutomationPhase)=>void=()=>{}){
    if(confirmation!==true)throw Error('ORDER_AUTOMATION_CONFIRMATION_REQUIRED');
    if(this.started)throw Error('ORDER_AUTOMATION_RECONCILIATION_REQUIRED');this.started=true;
    const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase(),e=this.input.payload.intent;
    const client=(s:BrowserSession)=>new PurchaseClient(this.baseUrl,()=>s.token());
    try{
      progress('CHECK_ROLES');
      const seller=await this.actors.seller.verified(),configuration=await this.actors.seller.configuration();active();
      const d=configuration.recoveryDeployment;if(!d)throw Error('AUTOMATION_DEPLOYMENT_REQUIRED');
      await verifyOriginalAuthorization(this.input.payload,[e.buyer],d);active();
      if(!seller.wallets.some(w=>eq(w,e.seller)))throw Error('AUTOMATION_SELLER_AUTHORITY_REQUIRED');
      const members=[];
      for(const member of this.actors.members){const principal=await member.session.verified();active();if(!principal.wallets.some(w=>eq(w,d.committee[member.index])))throw Error('AUTOMATION_MEMBER_AUTHORITY_REQUIRED');members.push({...member,principal});}
      const settler=await this.actors.settler.verified(),payee=await this.actors.payee.verified();active();
      if(!settler.wallets.some(w=>[e.buyer,e.seller,e.payee].some(a=>eq(a,w)))||!payee.wallets.some(w=>eq(w,e.payee)))throw Error('AUTOMATION_SETTLEMENT_AUTHORITY_REQUIRED');
      // Recompute the exact report; model output is never delivery evidence.
      const expected=reportDelivery(this.input.payload,this.input.dataset),report=expected.report;
      const read=async()=>{const order=await client(this.actors.seller).order(e.orderId);active();if(order.state==='UNREGISTERED')throw Error('AUTOMATION_FUNDED_ORDER_REQUIRED');assertFulfillmentOrder(this.input.payload,order);if(order.state==='ALLOCATED_REFUND'||order.state==='ALLOCATED_COMPENSATION')throw Error('AUTOMATION_NORMAL_SETTLEMENT_NOT_AVAILABLE');if(order.state!=='FUNDED'&&!eq(order.evidenceHash,expected.evidenceHash))throw Error('AUTOMATION_EVIDENCE_MISMATCH');return order;};
      let order=await read();
      if(order.state==='FUNDED'){
        if(this.clock()>BigInt(e.deliveryDeadline))throw Error('AUTOMATION_DELIVERY_EXPIRED');
        progress('DELIVERY');const delivery=new DeliveryFlow(this.input,seller.subject,this.actors.seller,client(this.actors.seller),this.clock);
        const sent=await delivery.deliver(true,active);active();const deliveryHash=sent.kind==='ALREADY_RECORDED'?sent.record.hash:sent.hash;
        if(!deliveryHash)throw Error('AUTOMATION_ORIGINAL_HASH_REQUIRED');
        await this.confirm(async()=>{const r=await delivery.reconcile(deliveryHash,active);return r.receipt.status;},active);order=await read();
      }
      for(let index=0;index<members.length;index++){
        if(order.voteMask&(1<<members[index].index))continue;
        progress(index===0?'MEMBER_ONE':'MEMBER_TWO');const member=members[index],api=client(member.session),request={...this.input,report,memberIndex:member.index,expiresAt:e.settlementDeadline};
        const acceptance=new AcceptanceFlow(request,member.principal.subject,member.session,api,this.clock);
        await acceptance.sign(true,active);active();
        // A saved digest cannot be turned into a fresh signature. If its exact
        // signature is not locally held, this stops for original reconciliation.
        const original=await acceptance.originalVote(true,active),vote=new VoteFlow(original,member.principal.subject,member.session,api,this.clock);
        const submitted=await vote.submit(true,active);active();const hash=submitted.kind==='ALREADY_RECORDED'?submitted.record.hash:submitted.hash;if(!hash)throw Error('AUTOMATION_ORIGINAL_HASH_REQUIRED');
        await this.confirm(async()=>{const r=await vote.reconcile(hash,active);return r.receipt.status;},active);order=await read();
      }
      progress('SETTLEMENT');const allocation=new AllocationFlow({payload:this.input.payload},settler.subject,this.actors.settler,client(this.actors.settler));
      const observed=await allocation.query(active);active();
      if(observed.preparation.order.state!=='ALLOCATED_PAID'){
        if(observed.preparation.action!=='settle'||observed.preparation.blockers.length)throw Error('AUTOMATION_SETTLEMENT_NOT_READY');
        const submitted=await allocation.trigger(true,'settle',active);active();const hash=submitted.record?.txHash;if(!hash)throw Error('AUTOMATION_ORIGINAL_HASH_REQUIRED');
        await this.confirm(async()=>{const r=await allocation.reconcile(hash,active);return r.record?.status==='CONFIRMED'?'CONFIRMED':r.record?.status==='SUBMITTED'?'PENDING':'UNKNOWN';},active);
      }
      progress('PAYOUT');const withdrawal=new WithdrawalFlow({payload:this.input.payload,beneficiary:e.payee},payee.subject,this.actors.payee,client(this.actors.payee));
      const submitted=await withdrawal.withdraw(true,undefined,active);active();const hash=submitted.kind==='ALREADY_RECORDED'?submitted.record.hash:submitted.hash;if(!hash)throw Error('AUTOMATION_ORIGINAL_HASH_REQUIRED');
      const payout=await this.confirm(async()=>{const r=await withdrawal.reconcile(hash,active);return {status:r.receipt.status,result:r};},active);
      progress('COMPLETE');return {status:'CONFIRMED' as const,orderId:e.orderId,payout};
    }catch(error){active();throw error;}
  }
  private async confirm<T extends string|{status:string}>(query:()=>Promise<T>,active:()=>void){
    for(let i=0;i<this.maxQueries;i++){const result=await query();active();const status=typeof result==='string'?result:result.status;if(status==='CONFIRMED')return result;if(status!=='PENDING')throw Error('AUTOMATION_ORIGINAL_OUTCOME_UNRESOLVED');await this.wait();active();}
    throw Error('AUTOMATION_CONFIRMATION_PENDING');
  }
}
