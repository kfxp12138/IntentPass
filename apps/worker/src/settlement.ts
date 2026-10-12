import {SubmissionRejected} from '../../../packages/adapters/src/privy-sender.js';
import type {Hex} from 'viem';
import type {OrderSnapshot} from '../../../packages/protocol/src/escrow-read.js';
import {SettlementStore,type SettlementAction,type SettlementRecord} from '../../../packages/storage/src/settlement-store.js';
import {recordedBroadcast,type BroadcastResult} from '../../../packages/protocol/src/provider-submission.js';
export interface SettlementPort {
  read(orderId:string):Promise<OrderSnapshot>;
  simulate(action:SettlementAction,orderId:string):Promise<void>;
  send(action:SettlementAction,orderId:string,idempotencyKey:string):Promise<BroadcastResult>;
  receipt(hash:Hex,action:SettlementAction,orderId:string):Promise<{status:'PENDING'}|{status:'SUCCESS'|'REVERTED';blockNumber:string;blockHash:Hex}>;
  blockHash(blockNumber:string):Promise<Hex>;
}
const terminal=(state:OrderSnapshot['state'])=>state.startsWith('ALLOCATED_');
const safeCode=(error:unknown)=>error instanceof Error&&['CHAIN_MISMATCH','DEPLOYMENT_MISMATCH','CHAIN_SNAPSHOT_CHANGED','ESCROW_INSOLVENT','ORDER_ANCHOR_MISMATCH','TRANSACTION_EFFECT_MISMATCH','TRANSACTION_SCOPE_MISMATCH'].includes(error.message)?error.message:'CHAIN_UNAVAILABLE';
function assertAnchors(record:SettlementRecord,snapshot:OrderSnapshot) {
  for(const key of ['chainId','arbiter','orderId'] as const)if(record.order[key].toLowerCase()!==snapshot[key].toLowerCase())throw new Error('ORDER_ANCHOR_MISMATCH');
  if(snapshot.state==='UNREGISTERED')return;
  for(const key of ['contextHash','buyer','seller','payee'] as const)if(record.order[key].toLowerCase()!==snapshot[key].toLowerCase())throw new Error('ORDER_ANCHOR_MISMATCH');
}
export interface WorkerResult {status:SettlementRecord['status']|'WAITING'|'UNAVAILABLE';snapshot?:OrderSnapshot;txHash?:string;error?:string;}
/** Settlement only: no wallet keys, review signing, withdrawals, generic calldata, or policy mutation.
 * Durable send lease + chain reconciliation keep restart/retry from blindly broadcasting twice.
 */
export class SettlementWorker {
  constructor(readonly store:SettlementStore,readonly port:SettlementPort,readonly clock=Date.now){}
  async runOnce(key:string,allowSend=true):Promise<WorkerResult> {
    this.store.expire(key,this.clock());
    let record=this.store.get(key);if(!record)throw new Error('ORDER_NOT_TRACKED');
    let snapshot:OrderSnapshot;
    try{snapshot=await this.port.read(record.order.orderId);assertAnchors(record,snapshot);}catch(error){return {status:'UNAVAILABLE',error:safeCode(error)};}
    if(record.status==='SUBMITTED'||record.status==='CONFIRMED') {
      try {
        const receipt=await this.port.receipt(record.txHash as Hex,record.action!,record.order.orderId);
        if(receipt.status==='PENDING'||BigInt(receipt.blockNumber)>BigInt(snapshot.block.number))return {status:record.status==='CONFIRMED'?'UNAVAILABLE':'SUBMITTED',snapshot,txHash:record.txHash!,...(record.status==='CONFIRMED'?{error:'CONFIRMATION_LOST'}:{})};
        if(await this.port.blockHash(receipt.blockNumber)!==receipt.blockHash)throw new Error('CHAIN_SNAPSHOT_CHANGED');
        if(receipt.status==='REVERTED') {
          if(record.status==='CONFIRMED')throw new Error('TRANSACTION_EFFECT_MISMATCH');
          this.store.finish(key,record.attempt!,'REVERTED','TRANSACTION_REVERTED');
        }
        else {
          const expected=record.action==='settle'?snapshot.state==='ALLOCATED_PAID':snapshot.state==='ALLOCATED_REFUND'||snapshot.state==='ALLOCATED_COMPENSATION';
          if(!expected)throw new Error('TRANSACTION_EFFECT_MISMATCH');
          if(record.status==='SUBMITTED')this.store.finish(key,record.attempt!,'CONFIRMED');
        }
        return {status:this.store.get(key)!.status,snapshot,txHash:record.txHash!};
      }catch(error){return {status:'UNAVAILABLE',snapshot,txHash:record.txHash!,error:safeCode(error)};}
    }
    if(terminal(snapshot.state)) {
      this.store.reconcile(key);record=this.store.get(key)!;
      return {status:record.status,snapshot,...(record.txHash?{txHash:record.txHash}:{})};
    }
    if(record.status!=='IDLE')return {status:record.status,snapshot};
    const expired=BigInt(snapshot.block.timestamp)>BigInt(snapshot.settlementDeadline);
    const action:SettlementAction|undefined=expired&&snapshot.state!=='UNREGISTERED'?'timeout':snapshot.state==='CERTIFIED'?'settle':undefined;
    if(!action||!allowSend)return {status:'WAITING',snapshot};
    const attempt=this.store.acquire(key,action,this.clock());if(!attempt)return {status:this.store.get(key)!.status,snapshot};
    try{await this.port.simulate(action,record.order.orderId);}catch {
      this.store.finish(key,attempt,'BLOCKED','PREFLIGHT_REJECTED');return {status:'BLOCKED',snapshot,error:'PREFLIGHT_REJECTED'};
    }
    this.store.expire(key,this.clock());
    const beforeSend=this.store.get(key)!;
    if(beforeSend.status!=='IN_FLIGHT'||beforeSend.attempt!==attempt)return {status:beforeSend.status,snapshot};
    try {
      const response=recordedBroadcast(await this.port.send(action,record.order.orderId,attempt));
      this.store.broadcast(key,attempt,response.hash,response.providerSubmission??undefined);
      const current=this.store.get(key)!;
      return {status:current.status,snapshot,...(current.txHash?{txHash:current.txHash}:{})};
    }catch(error) {
      if(error instanceof SubmissionRejected) {
        try{this.store.finish(key,attempt,'BLOCKED','TRANSACTION_SCOPE_REJECTED');}catch{/* A concurrent lease expiry/reconciliation wins; never overwrite it. */}
        return {status:this.store.get(key)!.status,snapshot,error:'TRANSACTION_SCOPE_REJECTED'};
      }
      // Includes send timeout or a crash between broadcast and hash persistence. Never assume no send.
      try{this.store.finish(key,attempt,'UNKNOWN','SUBMISSION_OUTCOME_UNKNOWN');}catch{/* Another process may have expired/reconciled this attempt; no new send. */}
      return {status:this.store.get(key)!.status,snapshot,error:'SUBMISSION_OUTCOME_UNKNOWN'};
    }
  }
}
