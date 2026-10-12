import {keccak256,type Hex} from 'viem';
import {verifyOriginalAuthorization,RecoveryDeploymentSchema,type RecoveryDeployment} from '../../../packages/capsule/src/recovery.js';
import {fundingCalldata} from '../../../packages/protocol/src/funding.js';
import {OrderSnapshotSchema,type OrderSnapshot} from '../../../packages/protocol/src/escrow-read.js';
import {PreflightSnapshotSchema,type PreflightSnapshot} from '../../../packages/protocol/src/purchase-preflight.js';
import {FundingStore,type FundingRecord} from '../../../packages/storage/src/funding-store.js';
import {SubmissionRejected} from '../../../packages/adapters/src/privy-sender.js';
import {digest} from '../../../packages/protocol/src/schemas.js';
import {recordedBroadcast,type BroadcastResult} from '../../../packages/protocol/src/provider-submission.js';
export type FundingPayload=Awaited<ReturnType<typeof verifyOriginalAuthorization>>;
export interface FundingPort {preflight(payload:FundingPayload):Promise<PreflightSnapshot>;read(id:string):Promise<OrderSnapshot>;simulate(payload:FundingPayload):Promise<void>;send(payload:FundingPayload,key:string):Promise<BroadcastResult>;
  observe?(payload:FundingPayload):Promise<{snapshot:OrderSnapshot;preflight:PreflightSnapshot}>;
  receipt(payload:FundingPayload,hash:Hex):Promise<{status:'PENDING'}|{status:'SUCCESS'|'REVERTED';blockNumber:string;blockHash:Hex}>;blockHash(number:string):Promise<Hex>;}
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const safe=(error:unknown)=>error instanceof Error&&['CHAIN_MISMATCH','DEPLOYMENT_MISMATCH','CHAIN_SNAPSHOT_CHANGED','ESCROW_INSOLVENT','FUNDING_CONTEXT_MISMATCH','FUNDING_EFFECT_MISMATCH','FUNDING_TRANSACTION_MISMATCH'].includes(error.message)?error.message:'FUNDING_SERVICE_UNAVAILABLE';
function snapshotMatches(p:FundingPayload,s:OrderSnapshot){const e=p.intent;
  if(s.chainId!==e.chainId||!eq(s.arbiter,e.arbiter)||!eq(s.asset,e.asset)||!eq(s.orderId,e.orderId))throw new Error('FUNDING_CONTEXT_MISMATCH');
  if(s.state!=='UNREGISTERED'&&((['buyer','seller','payee','datasetHash','serviceTermsHash'] as const).some(k=>!eq(s[k],e[k]))||!eq(s.contextHash,p.grant.contextHash)||(['price','bond','deliveryDeadline','settlementDeadline'] as const).some(k=>s[k]!==e[k])))throw new Error('FUNDING_CONTEXT_MISMATCH');
}
function preflightMatches(p:FundingPayload,s:PreflightSnapshot,allowLatest:boolean){const g=p.grant;if((!allowLatest&&s.block.finality!=='finalized')||s.chainId!==g.chainId||s.nonce!==g.nonce||s.amount!==g.amount||s.deadline!==g.deadline||([['arbiter',g.arbiter],['asset',g.asset],['buyer',g.owner],['orderId',g.orderId],['contextHash',g.contextHash]] as const).some(([k,v])=>!eq(s[k],v)))throw new Error('FUNDING_CONTEXT_MISMATCH');}
/** Explicit original-order submit, not an autonomous planner tool. No automatic retry.
 * Reconcile can verify expired history but never reopens payment permission.
 */
export class FundingWorker {
  private deployment:RecoveryDeployment;
  constructor(readonly store:FundingStore,readonly port:FundingPort,deployment:RecoveryDeployment,readonly clock=Date.now,readonly localLatest=false){this.deployment=RecoveryDeploymentSchema.parse(deployment);}
  submit(input:unknown,wallets:readonly string[]){return this.run(input,wallets,true);}
  reconcile(input:unknown,wallets:readonly string[],hash?:string){return this.run(input,wallets,false,hash);}
  private async run(input:unknown,wallets:readonly string[],sendAllowed:boolean,providedHash?:string){
    const p=await verifyOriginalAuthorization(input,wallets,this.deployment),g=p.grant;
    const initial=this.store.register({chainId:g.chainId,arbiter:g.arbiter,asset:g.asset,owner:g.owner,executor:g.executor,orderId:g.orderId,contextHash:g.contextHash,nonce:g.nonce,amount:g.amount,calldataHash:keccak256(fundingCalldata(p))});
    this.store.expire(initial.key,this.clock());let record=this.store.get(initial.key)!;
    const result=(error?:string,snapshot?:OrderSnapshot)=>({record:this.store.get(initial.key)!,...(snapshot?{snapshot}:{}),...(error?{error}:{}),canSubmitPayment:false as const});
    let snapshot:OrderSnapshot,observed:PreflightSnapshot;
    try{
      if(this.port.observe){const observation=await this.port.observe(structuredClone(p));snapshot=observation.snapshot;observed=observation.preflight;}
      else [snapshot,observed]=await Promise.all([this.port.read(g.orderId),this.port.preflight(structuredClone(p))]);
      snapshot=OrderSnapshotSchema.parse(snapshot) as OrderSnapshot;observed=PreflightSnapshotSchema.parse(observed);snapshotMatches(p,snapshot);preflightMatches(p,observed,this.localLatest);if(observed.block.number!==snapshot.block.number||observed.block.hash!==snapshot.block.hash||observed.block.timestamp!==snapshot.block.timestamp)throw new Error('CHAIN_SNAPSHOT_CHANGED');
    }catch(error){return result(safe(error));}
    const hash=providedHash?digest.parse(providedHash):record.hash;
    if(record.hash&&hash&&!eq(record.hash,hash))throw new Error('FUNDING_HASH_LOCKED');
    if(hash){try{
      const receipt=await this.port.receipt(structuredClone(p),hash as Hex);
      if(receipt.status==='PENDING'||BigInt(receipt.blockNumber)>BigInt(snapshot.block.number))return result(record.status==='CONFIRMED'?'CONFIRMATION_LOST':undefined,snapshot);
      if(await this.port.blockHash(receipt.blockNumber)!==receipt.blockHash)throw new Error('CHAIN_SNAPSHOT_CHANGED');
      if(receipt.status==='SUCCESS'&&(snapshot.state==='UNREGISTERED'||!observed.consumed))throw new Error('FUNDING_EFFECT_MISMATCH');
      this.store.finish(record.key,hash,receipt.status==='SUCCESS'?'CONFIRMED':'REVERTED');return result(undefined,snapshot);
    }catch(error){return result(safe(error),snapshot);}}
    if(snapshot.state!=='UNREGISTERED'){
      if(!observed.consumed||observed.state==='UNREGISTERED')return result('FUNDING_EFFECT_MISMATCH',snapshot);
      this.store.reconcileOrder(record.key);return result(undefined,snapshot);
    }
    if(!sendAllowed||record.status!=='IDLE')return result(undefined,snapshot);
    if(observed.blockers.length||BigInt(g.deadline)<=BigInt(Math.floor(this.clock()/1000)))return result('FUNDING_PREFLIGHT_BLOCKED',snapshot);
    const attempt=this.store.acquire(record.key,this.clock());if(!attempt)return result(undefined,snapshot);
    try{await this.port.simulate(structuredClone(p));const fresh=PreflightSnapshotSchema.parse(await this.port.preflight(structuredClone(p)));preflightMatches(p,fresh,this.localLatest);if(fresh.blockers.length||BigInt(g.deadline)<=BigInt(Math.floor(this.clock()/1000)))throw new Error();}
    catch{try{this.store.stop(record.key,attempt,'BLOCKED');}catch{}return result('FUNDING_PREFLIGHT_BLOCKED',snapshot);}
    this.store.expire(record.key,this.clock());record=this.store.get(record.key)!;
    if(record.status!=='IN_FLIGHT'||record.attempt!==attempt)return result(undefined,snapshot);
    try{const tx=recordedBroadcast(await this.port.send(structuredClone(p),attempt));this.store.broadcast(record.key,attempt,tx.hash,tx.providerSubmission??undefined);return result(undefined,snapshot);}
    catch(error){try{this.store.stop(record.key,attempt,error instanceof SubmissionRejected?'BLOCKED':'UNKNOWN');}catch{}return result(error instanceof SubmissionRejected?'TRANSACTION_SCOPE_REJECTED':'SUBMISSION_OUTCOME_UNKNOWN',snapshot);}
  }
}
