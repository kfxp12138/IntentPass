import {encodeFunctionData,TransactionReceiptNotFoundError,type Address,type Hex} from 'viem';
import {escrowAbi} from '../../../packages/protocol/src/escrow-abi.js';
import {EscrowReader} from '../../../packages/protocol/src/escrow-read.js';
import type {SettlementAction} from '../../../packages/storage/src/settlement-store.js';
import type {SettlementPort} from './settlement.js';
import {checkBroadcastResult,type RecordedBroadcast} from '../../../packages/protocol/src/provider-submission.js';
export interface RestrictedSender {
  readonly address:Address;
  send(input:{chainId:string;from:Address;to:Address;value:'0';data:Hex;idempotencyKey:string}):Promise<Hex>;
  sendRecorded?(input:Parameters<RestrictedSender['send']>[0]):Promise<RecordedBroadcast>;
}
/** Fixed escrow target and settle/timeout selectors; adapters never accept planner calldata. */
export function viemSettlementPort(reader:EscrowReader,sender:RestrictedSender):SettlementPort {
  const {client,deployment}=reader;
  const recordedSend=sender.sendRecorded?.bind(sender),legacySend=sender.send.bind(sender),from=sender.address;
  const calldata=(action:SettlementAction,id:string)=>encodeFunctionData({abi:escrowAbi,functionName:action,args:[id as Hex]});
  return {
    read:id=>reader.read(id),
    simulate:async(action,id)=>{await client.simulateContract({address:deployment.arbiter,abi:escrowAbi,functionName:action,args:[id as Hex],account:from});},
    send:async(action,id,idempotencyKey)=>{const input={chainId:deployment.chainId,from,to:deployment.arbiter,value:'0' as const,data:calldata(action,id),idempotencyKey};
      const response=await (recordedSend?recordedSend(input):legacySend(input));return checkBroadcastResult(response,input);},
    receipt:async(hash,action,id)=>{
      try {
        const r=await client.getTransactionReceipt({hash});
        const transaction=await client.getTransaction({hash});
        if(transaction.to?.toLowerCase()!==deployment.arbiter.toLowerCase()||transaction.from.toLowerCase()!==from.toLowerCase()
          ||transaction.input.toLowerCase()!==calldata(action,id).toLowerCase()||transaction.value!==0n)throw new Error('TRANSACTION_SCOPE_MISMATCH');
        return {status:r.status==='success'?'SUCCESS':'REVERTED',blockNumber:String(r.blockNumber),blockHash:r.blockHash};
      }catch(error){if(error instanceof TransactionReceiptNotFoundError)return {status:'PENDING'};throw error;}
    },
    blockHash:async number=>{const hash=(await client.getBlock({blockNumber:BigInt(number)})).hash;if(!hash)throw new Error('BLOCK_UNAVAILABLE');return hash;},
  };
}
