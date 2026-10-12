import type {Address,PublicClient} from 'viem';
import type {CleanverseInspectionPort} from './cleanverse-inspection-types.js';

/** Existing public client only: fixed-block reads, with no wallet or send method. */
export function cleanverseInspectionPort(client:PublicClient):CleanverseInspectionPort{
  const port:CleanverseInspectionPort={blockTag:'finalized',
    chainId:()=>client.getChainId(),
    block:async(number?:bigint)=>{
      const block=await client.getBlock(number===undefined?{blockTag:'finalized'}:{blockNumber:number});
      return {number:block.number,hash:block.hash,timestamp:block.timestamp};
    },
    code:(address:Address,blockNumber:bigint)=>client.getCode({address,blockNumber}),
    call:async({to,data,blockNumber}:Parameters<CleanverseInspectionPort['call']>[0])=>(await client.call({to,data,blockNumber})).data,
  };
  return Object.freeze(port);
}
