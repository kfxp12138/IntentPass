import {decodeEventLog,TransactionNotFoundError,TransactionReceiptNotFoundError,type Hex} from 'viem';
import {fundingCalldata} from '../../../packages/protocol/src/funding.js';
import type {EscrowReader} from '../../../packages/protocol/src/escrow-read.js';
import type {PurchasePreflightReader} from '../../../packages/protocol/src/purchase-preflight.js';
import type {RestrictedSender} from './viem-port.js';
import type {FundingPort} from './funding.js';
import {checkBroadcastResult} from '../../../packages/protocol/src/provider-submission.js';
const funded=[{type:'event',name:'Funded',inputs:[{name:'orderId',type:'bytes32',indexed:true},{name:'contextHash',type:'bytes32',indexed:false},{name:'buyer',type:'address',indexed:false},{name:'amount',type:'uint256',indexed:false}]}] as const;
const transfer=[{type:'event',name:'Transfer',inputs:[{name:'from',type:'address',indexed:true},{name:'to',type:'address',indexed:true},{name:'value',type:'uint256',indexed:false}]}] as const;
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
/** Fixed canonical submit target and selector; no planner calldata. ERC-20 event ABI is
 * standard project assumption, not official Cleanverse integration evidence.
 */
export function viemFundingPort(reader:EscrowReader,preflight:PurchasePreflightReader,sender:RestrictedSender):FundingPort {
  const {client,deployment:d}=reader;
  const recordedSend=sender.sendRecorded?.bind(sender),legacySend=sender.send.bind(sender),from=sender.address;
  if(client!==preflight.client||reader.blockTag!==preflight.blockTag||preflight.deployment.chainId!==d.chainId||!eq(preflight.deployment.arbiter,d.arbiter)||!eq(preflight.deployment.asset,d.asset)||(['gate','reviewer','committeeHash'] as const).some(k=>!eq(preflight.deployment[k],d[k]))||!eq(preflight.executor,from))throw new Error('FUNDING_CONTEXT_MISMATCH');
  const bound=(p:import('./funding.js').FundingPayload)=>{if(p.grant.chainId!==d.chainId||!eq(p.grant.arbiter,d.arbiter)||!eq(p.grant.asset,d.asset)||!eq(p.grant.executor,from))throw new Error('FUNDING_CONTEXT_MISMATCH');};
  return {read:id=>reader.read(id),preflight:p=>preflight.read({intent:p.intent,grant:p.grant}),
    observe:async p=>{
      bound(p);const observed=await preflight.read({intent:p.intent,grant:p.grant});
      // Finality may advance during paced RPC calls. Keep both views at the
      // chosen finalized height; readAt rechecks its canonical hash and solvency.
      const snapshot=reader.blockTag==='finalized'?await reader.readAt(p.grant.orderId,BigInt(observed.block.number)):await reader.read(p.grant.orderId);
      return {snapshot,preflight:observed};
    },
    simulate:async p=>{bound(p);await client.call({account:from,to:d.arbiter,data:fundingCalldata(p),value:0n});},
    send:async(p,idempotencyKey)=>{bound(p);const input={chainId:d.chainId,from,to:d.arbiter,value:'0' as const,data:fundingCalldata(p),idempotencyKey};
      const response=await (recordedSend?recordedSend(input):legacySend(input));return checkBroadcastResult(response,input);},
    receipt:async(p,hash)=>{
      try{bound(p);const [r,t]=await Promise.all([client.getTransactionReceipt({hash}),client.getTransaction({hash})]);
        if(!eq(t.hash,hash)||!eq(r.transactionHash,hash)||!t.to||!eq(t.to,d.arbiter)||!eq(t.from,from)||t.value!==0n||String(t.chainId)!==d.chainId||t.input.toLowerCase()!==fundingCalldata(p).toLowerCase()||t.blockHash!==r.blockHash||t.blockNumber!==r.blockNumber)throw new Error('FUNDING_TRANSACTION_MISMATCH');
        if(r.status==='success'){
          const f=r.logs.filter(log=>{if(log.removed||!eq(log.address,d.arbiter))return false;try{const e=decodeEventLog({abi:funded,data:log.data,topics:log.topics,strict:true});return eq(e.args.orderId,p.grant.orderId)&&eq(e.args.contextHash,p.grant.contextHash)&&eq(e.args.buyer,p.grant.owner)&&e.args.amount===BigInt(p.grant.amount);}catch{return false;}});
          const transfers=r.logs.filter(log=>{if(log.removed||!eq(log.address,d.asset))return false;try{const e=decodeEventLog({abi:transfer,data:log.data,topics:log.topics,strict:true});return eq(e.args.from,p.grant.owner)&&eq(e.args.to,d.arbiter)&&e.args.value===BigInt(p.grant.amount);}catch{return false;}});
          if(f.length!==1||transfers.length!==1)throw new Error('FUNDING_EFFECT_MISMATCH');
        }
        return {status:r.status==='success'?'SUCCESS':'REVERTED',blockNumber:String(r.blockNumber),blockHash:r.blockHash};
      }catch(error){if(error instanceof TransactionNotFoundError||error instanceof TransactionReceiptNotFoundError)return {status:'PENDING'};throw error;}
    },blockHash:async number=>{const block=await client.getBlock({blockNumber:BigInt(number)});if(!block.hash)throw new Error('BLOCK_UNAVAILABLE');return block.hash as Hex;},
  };
}
