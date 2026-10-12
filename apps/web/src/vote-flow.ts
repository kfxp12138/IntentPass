import {VoteRequestSchema,checkVotePreparation,prepareVote,checkVoteReceipt} from '../../../packages/protocol/src/vote.js';
import {VoteReserveResponseSchema,VoteQueryResponseSchema,VoteReconcileResponseSchema,checkVoteRecord} from '../../../packages/protocol/src/vote-api.js';
import {verifyAcceptanceSignature} from '../../../packages/protocol/src/acceptance-api.js';
import {verifyOriginalAuthorization} from '../../../packages/capsule/src/recovery.js';
import {digest} from '../../../packages/protocol/src/schemas.js';
import type {OrderSnapshot} from '../../../packages/protocol/src/escrow-read.js';
import {PurchaseClient} from '../../../packages/protocol/src/purchase-client.js';
import {browserSession,type BrowserSession} from './browser-session.js';
export interface VotePort {prepareVote:(input:unknown)=>Promise<unknown>;reserveVote:(input:unknown)=>Promise<unknown>;queryVote:(input:unknown)=>Promise<unknown>;reconcileVote:(input:unknown)=>Promise<unknown>;}
export interface VoteAttempt {status:'PREPARING'|'RESERVED'|'SUBMITTED'|'UNKNOWN'|'CONFIRMED'|'REVERTED';hash?:string;}
/** Privately retains the original signed vote. Only the first durable reservation
 * can reach a wallet; all subsequent operations are read-only original queries.
 */
export class VoteFlow {
  private input:ReturnType<typeof VoteRequestSchema.parse>;
  private attempt:VoteAttempt|undefined;
  private busy=false;
  private terminal:'CONFIRMED'|'REVERTED'|undefined;
  private observed:OrderSnapshot|undefined;
  constructor(input:unknown,private subject:string,private session:BrowserSession=browserSession,private client:VotePort=new PurchaseClient(location.origin,()=>session.token()),private clock=()=>BigInt(Math.floor(Date.now()/1000))){this.input=VoteRequestSchema.parse(input);}
  get attemptState(){return this.attempt?structuredClone(this.attempt):undefined;}
  private guard(active:()=>void){const epoch=this.session.generation;return ()=>{active();if(epoch!==this.session.generation)throw new Error('SESSION_CHANGED');};}
  private async current(guard:()=>void){guard();const principal=await this.session.verified(),config=await this.session.configuration();guard();const d=config.recoveryDeployment;if(principal.subject!==this.subject||!d)throw new Error('SESSION_CHANGED');if(!principal.wallets.some(w=>w.toLowerCase()===d.committee[this.input.memberIndex].toLowerCase()))throw new Error('FULFILLMENT_ROLE_MISMATCH');await verifyOriginalAuthorization(this.input.payload,[this.input.payload.intent.buyer],d);const signed=await verifyAcceptanceSignature(this.input,d.committee);guard();return {principal,deployment:d,signed};}
  private async exclusive<T>(work:()=>Promise<T>){if(this.busy)throw new Error('VOTE_OPERATION_PENDING');this.busy=true;try{return await work();}finally{this.busy=false;}}
  private observe(order:OrderSnapshot){const old=this.observed;if(old&&(BigInt(order.block.number)<BigInt(old.block.number)||order.block.number===old.block.number&&order.block.hash.toLowerCase()!==old.block.hash.toLowerCase()||old.state.startsWith('ALLOCATED_')&&order.state!==old.state))throw new Error('VOTE_SNAPSHOT_CHANGED');this.observed=structuredClone(order);}
  private async check(record:unknown){const r=await checkVoteRecord(this.input,record);if(this.terminal&&r.status!==this.terminal||this.attempt?.hash&&r.hash&&this.attempt.hash.toLowerCase()!==r.hash.toLowerCase())throw new Error('VOTE_RECORD_LOCKED');return r;}
  private async preparation(guard:()=>void){const {principal,deployment}=await this.current(guard),response=await this.client.prepareVote(structuredClone(this.input));await this.current(guard);const p=await checkVotePreparation(this.input,response);guard();await prepareVote(this.input,principal.wallets,deployment,async()=>({snapshot:p.order,finality:p.finality}),this.clock);guard();this.observe(p.order as OrderSnapshot);return p;}
  submit(confirmation:boolean,active:()=>void=()=>{}){return this.exclusive(async()=>{
    if(confirmation!==true)throw new Error('VOTE_CONFIRMATION_REQUIRED');if(this.attempt)throw new Error('VOTE_RECONCILIATION_REQUIRED');const guard=this.guard(active);let reserved=false;this.attempt={status:'PREPARING'};
    try{await this.current(guard);reserved=true;const result=VoteReserveResponseSchema.parse(await this.client.reserveVote(structuredClone(this.input)));if('status'in result)throw new Error('VOTE_RESERVATION_REJECTED');const record=await this.check(result.record);await this.current(guard);
      if(!result.created){this.attempt={status:record.status==='RESERVED'?'UNKNOWN':record.status,...(record.hash?{hash:record.hash}:{})};if(record.status!=='RESERVED')this.terminal=record.status;return {kind:'ALREADY_RECORDED' as const,record};}
      this.attempt={status:'RESERVED'};await this.preparation(guard);const sent=await this.session.submitVote(structuredClone(this.input),async request=>{if(JSON.stringify(VoteRequestSchema.parse(request))!==JSON.stringify(this.input))throw new Error('VOTE_INPUT_CHANGED');return this.preparation(guard);},guard);
      if(sent.kind!=='VOTE_SUBMITTED'||sent.orderId.toLowerCase()!==record.orderId.toLowerCase()||sent.evidenceHash.toLowerCase()!==record.evidenceHash.toLowerCase()||sent.memberIndex!==record.memberIndex||sent.signatureHash.toLowerCase()!==record.signatureHash.toLowerCase())throw new Error('VOTE_RESPONSE_MISMATCH');this.attempt={status:'SUBMITTED',hash:digest.parse(sent.hash)};await this.current(guard);return sent;
    }catch(e){if(reserved)this.attempt={status:'UNKNOWN',...(this.attempt?.hash?{hash:this.attempt.hash}:{})};else this.attempt=undefined;throw e;}
  });}
  query(active:()=>void=()=>{}){return this.exclusive(async()=>{const guard=this.guard(active);try{await this.current(guard);const result=VoteQueryResponseSchema.parse(await this.client.queryVote(structuredClone(this.input)));await this.current(guard);if('status'in result)throw new Error('VOTE_QUERY_REJECTED');if(result.record){const record=await this.check(result.record);guard();if(record.status!=='RESERVED'){this.terminal=record.status;this.attempt={status:record.status,hash:record.hash!};}else this.attempt={status:this.attempt?.hash?'SUBMITTED':'UNKNOWN',...(this.attempt?.hash?{hash:this.attempt.hash}:{})};}else if(this.attempt||this.terminal)throw new Error('VOTE_RECORD_MISSING');return result;}catch(e){if(this.attempt)this.attempt={status:'UNKNOWN',...(this.attempt.hash?{hash:this.attempt.hash}:{})};throw e;}});}
  reconcile(providedHash?:string,active:()=>void=()=>{}){return this.exclusive(async()=>{
    const guard=this.guard(active),{signed}=await this.current(guard),hash=digest.parse(providedHash??this.attempt?.hash);if(this.attempt?.hash&&this.attempt.hash.toLowerCase()!==hash.toLowerCase())throw new Error('VOTE_HASH_LOCKED');const request={...structuredClone(this.input),hash};
    try{const result=VoteReconcileResponseSchema.parse(await this.client.reconcileVote(request));await this.current(guard);if('status'in result)throw new Error('VOTE_RECONCILIATION_REJECTED');await this.check(result.record);guard();const receipt=checkVoteReceipt(request,result.receipt,signed);
      if(receipt.status==='PENDING'){if(result.record.status!=='RESERVED'||this.terminal)throw new Error('VOTE_RESPONSE_MISMATCH');this.attempt={status:'SUBMITTED',hash};}
      else{if(result.record.status!==receipt.status||result.record.hash?.toLowerCase()!==hash.toLowerCase()||this.terminal&&this.terminal!==receipt.status)throw new Error('VOTE_RESPONSE_MISMATCH');this.observe(receipt.order as OrderSnapshot);this.terminal=receipt.status;this.attempt={status:receipt.status,hash};}return result;
    }catch(e){this.attempt={status:'UNKNOWN',...(this.attempt?.hash?{hash:this.attempt.hash}:{})};throw e;}
  });}
}
