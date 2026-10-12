import {AllocationRequestSchema,verifyAllocationRequest} from '../../../packages/protocol/src/allocation.js';
import {checkAllocationResponse} from '../../../packages/protocol/src/allocation-api.js';
import {digest} from '../../../packages/protocol/src/schemas.js';
import {browserSession,type BrowserSession} from './browser-session.js';
import {PurchaseClient} from '../../../packages/protocol/src/purchase-client.js';
import {sameProviderSubmission} from '../../../packages/protocol/src/provider-submission.js';
export interface AllocationPort {queryAllocation:(input:unknown)=>Promise<unknown>;triggerAllocation:(input:unknown)=>Promise<unknown>;reconcileAllocation:(input:unknown)=>Promise<unknown>;}
type Response=Exclude<ReturnType<typeof checkAllocationResponse>,{status:'REJECT'}>;
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
/** Private original payload, current subject, single explicit trigger. Reloads
 * first query the durable original slot; unknown responses never unlock sends.
 */
export class AllocationFlow {
  private input:ReturnType<typeof AllocationRequestSchema.parse>;
  private held:Response|undefined;
  private attempted=false;
  private busy=false;
  constructor(input:unknown,private subject:string,private session:BrowserSession=browserSession,private client:AllocationPort=new PurchaseClient(location.origin,()=>session.token())){this.input=AllocationRequestSchema.parse(input);}
  get observation(){return this.held?structuredClone(this.held):undefined;}
  get locked(){return this.attempted||!!this.held?.record&&this.held.record.status!=='IDLE';}
  private guard(active:()=>void){const generation=this.session.generation;return ()=>{active();if(generation!==this.session.generation)throw new Error('SESSION_CHANGED');};}
  private async current(guard:()=>void){guard();const principal=await this.session.verified(),config=await this.session.configuration();guard();if(principal.subject!==this.subject||!config.recoveryDeployment)throw new Error('SESSION_CHANGED');await verifyAllocationRequest(this.input,principal.wallets,config.recoveryDeployment);guard();}
  private async exclusive<T>(work:()=>Promise<T>){if(this.busy)throw new Error('ALLOCATION_OPERATION_PENDING');this.busy=true;try{return await work();}finally{this.busy=false;}}
  private retain(value:unknown,hash?:string){const v=checkAllocationResponse(this.input,value,hash);if('status'in v)throw new Error(v.code);const old=this.held,o=old?.preparation.order,n=v.preparation.order;
    if(o&&(BigInt(n.block.number)<BigInt(o.block.number)||n.block.number===o.block.number&&!eq(n.block.hash,o.block.hash)||o.state.startsWith('ALLOCATED_')&&n.state!==o.state))throw new Error('ALLOCATION_SNAPSHOT_CHANGED');
    const before=old?.record,after=v.record;if(before&&(!after||before.attempt&&before.attempt!==after.attempt||before.action&&before.action!==after.action||before.txHash&&(!after.txHash||!eq(before.txHash,after.txHash))||before.status==='CONFIRMED'&&after.status!=='CONFIRMED'||before.status!=='IDLE'&&after.status==='IDLE'))throw new Error('ALLOCATION_RECORD_LOCKED');
    if(before?.providerSubmission&&(!after?.providerSubmission||!sameProviderSubmission(before.providerSubmission,after.providerSubmission)))throw new Error('ALLOCATION_PROVIDER_SUBMISSION_LOCKED');
    this.held=structuredClone(v);return v;
  }
  query(active:()=>void=()=>{}){return this.exclusive(async()=>{const guard=this.guard(active);await this.current(guard);const v=await this.client.queryAllocation(structuredClone(this.input));await this.current(guard);return this.retain(v);});}
  trigger(confirmation:boolean,action:'settle'|'timeout',active:()=>void=()=>{}){return this.exclusive(async()=>{if(confirmation!==true)throw new Error('ALLOCATION_CONFIRMATION_REQUIRED');if(!this.held||this.locked)throw new Error('ALLOCATION_QUERY_REQUIRED');const guard=this.guard(active);await this.current(guard);const fresh=await this.client.queryAllocation(structuredClone(this.input));await this.current(guard);const v=this.retain(fresh);if(this.locked||v.preparation.action!==action||v.preparation.blockers.length)throw new Error('ALLOCATION_REFRESH_REQUIRED');this.attempted=true;const result=await this.client.triggerAllocation({...structuredClone(this.input),confirm:true,action});await this.current(guard);return this.retain(result);});}
  reconcile(providedHash?:string,active:()=>void=()=>{}){return this.exclusive(async()=>{const guard=this.guard(active);await this.current(guard);const record=this.held?.record;if(!record?.attempt||!record.action)throw new Error('ALLOCATION_ATTEMPT_REQUIRED');const hash=digest.parse(providedHash??record.txHash);if(record.txHash&&!eq(hash,record.txHash))throw new Error('ALLOCATION_HASH_LOCKED');const v=await this.client.reconcileAllocation({...structuredClone(this.input),hash});await this.current(guard);return this.retain(v,hash);});}
}
