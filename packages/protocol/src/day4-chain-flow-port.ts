import {parseAbi,TransactionNotFoundError,TransactionReceiptNotFoundError,type Address,type PublicClient} from 'viem';
import {Day4ChainFlowDeploymentSchema,type Day4ChainFlowDeployment,type Day4ChainFlowPort} from './day4-chain-flow-types.js';
import {EscrowReader} from './escrow-read.js';
import {committeeHash} from './escrow.js';
import {address,uint} from './schemas.js';

const balanceAbi=parseAbi(['function balanceOf(address) view returns(uint256)']);

/** Fixed deployment, finalized historical reads only. There is no wallet,
 * signer, sender, simulation or arbitrary calldata execution in this adapter. */
export function day4ChainFlowPort(client:PublicClient,input:Day4ChainFlowDeployment):Day4ChainFlowPort{
  let deployment:Day4ChainFlowDeployment;
  try{
    const parsed=Day4ChainFlowDeploymentSchema.parse(structuredClone(input));
    deployment=Object.freeze({...parsed,committee:Object.freeze([...parsed.committee])}) as Day4ChainFlowDeployment;
  }catch{throw Error('DAY4_FLOW_DEPLOYMENT_INVALID');}
  const reads=Object.freeze({chainId:client.getChainId.bind(client),block:client.getBlock.bind(client),
    transaction:client.getTransaction.bind(client),receipt:client.getTransactionReceipt.bind(client),
    contract:client.readContract.bind(client)});
  const historicalClient=Object.freeze({getChainId:reads.chainId,getBlock:reads.block,readContract:reads.contract}) as unknown as PublicClient;
  const reader=new EscrowReader(historicalClient,{chainId:deployment.chainId,arbiter:deployment.arbiter as Address,
    asset:deployment.asset as Address,gate:deployment.gate as Address,reviewer:deployment.reviewer as Address,
    committeeHash:committeeHash(deployment.committee)},'finalized');
  const port:Day4ChainFlowPort={blockTag:'finalized',chainId:()=>reads.chainId(),
    block:async(number?:bigint)=>{
      const block=await reads.block(number===undefined?{blockTag:'finalized'}:{blockNumber:number});
      return {number:block.number,hash:block.hash,timestamp:block.timestamp};
    },
    transaction:async hash=>{
      try{return await reads.transaction({hash});}
      catch(error){if(error instanceof TransactionNotFoundError)return null;throw error;}
    },
    receipt:async hash=>{
      try{return await reads.receipt({hash});}
      catch(error){if(error instanceof TransactionReceiptNotFoundError)return null;throw error;}
    },
    orderAt:(orderId,blockNumber)=>reader.readAt(orderId,blockNumber),
    balance:(asset,owner,blockNumber)=>{
      if(address.parse(asset).toLowerCase()!==deployment.asset.toLowerCase()
        ||typeof blockNumber!=='bigint'||!uint.safeParse(String(blockNumber)).success)
        throw Error('DAY4_FLOW_BALANCE_QUERY_INVALID');
      return reads.contract({address:deployment.asset as Address,abi:balanceAbi,functionName:'balanceOf',
        args:[address.parse(owner) as Address],blockNumber});
    },
  };
  return Object.freeze(port);
}
