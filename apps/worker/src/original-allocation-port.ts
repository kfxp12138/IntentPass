import type {AllocationReader} from '../../../packages/capsule/src/allocation-read.js';
import {AuthorizationPayloadSchema} from '../../../packages/capsule/src/format.js';
import type {Hex} from 'viem';
import type {OrderSnapshot} from '../../../packages/protocol/src/escrow-read.js';
import type {SettlementPort} from './settlement.js';
import {SubmissionRejected} from '../../../packages/adapters/src/privy-sender.js';
import {allocationCalldata} from '../../../packages/protocol/src/allocation.js';
import {checkBroadcastResult} from '../../../packages/protocol/src/provider-submission.js';

/** A request owns its original authorization and authenticated wallet set.
 * Every pre-send observation is finalized; receipt confirmation requires the
 * exact original Allocated event rather than merely a successful transaction.
 */
export function originalAllocationPort(reader:AllocationReader,base:SettlementPort,payload:unknown,wallets:readonly string[],confirmedAction?:'settle'|'timeout'):SettlementPort {
  const original=AuthorizationPayloadSchema.parse(structuredClone(payload)),actors=[...wallets],request={payload:original};
  const chainId=original.grant.chainId,from=original.grant.executor,to=original.grant.arbiter,send=base.send.bind(base);
  const assertId=(id:string)=>{if(id.toLowerCase()!==original.intent.orderId.toLowerCase())throw new Error('ORDER_ANCHOR_MISMATCH');};
  const ready=async(action:'settle'|'timeout',id:string)=>{
    assertId(id);const p=await reader.prepare(request,actors);
    if(confirmedAction&&confirmedAction!==action||p.action!==action||p.blockers.length)throw new SubmissionRejected();
    return p;
  };
  return {
    read:async id=>{assertId(id);return (await reader.prepare(request,actors)).order as OrderSnapshot;},
    simulate:async(action,id)=>{await ready(action,id);await base.simulate(action,id);},
    send:async(action,id,key)=>{const data=allocationCalldata(request,action);await ready(action,id);return checkBroadcastResult(await send(action,id,key),{chainId,from,to,data});},
    receipt:async(hash,action,id)=>{assertId(id);const proof=await reader.read({...request,action,hash},actors);return proof.status==='PENDING'?{status:'PENDING'}:{status:proof.status==='CONFIRMED'?'SUCCESS':'REVERTED',blockNumber:proof.receiptBlock.number,blockHash:proof.receiptBlock.hash as Hex};},
    blockHash:number=>base.blockHash(number),
  };
}
