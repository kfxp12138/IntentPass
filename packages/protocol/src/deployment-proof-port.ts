import {parseAbi,TransactionNotFoundError,TransactionReceiptNotFoundError,type PublicClient} from 'viem';
import type {DeploymentProofPort} from './deployment-proof.js';
const abi=parseAbi(['function asset() view returns (address)','function eligibility() view returns (address)','function reviewer() view returns (address)','function committee(uint256) view returns (address)','function committeeHash() view returns (bytes32)','function ALLOCATION_POLICY() view returns (bytes32)','function RELEASE_POLICY() view returns (bytes32)','function DELIVERY_SCHEMA() view returns (bytes32)']);
export function deploymentProofPort(client:PublicClient,blockTag:'finalized'|'latest'='finalized'):DeploymentProofPort{return{blockTag,
  chainId:()=>client.getChainId(),block:number=>number===undefined?client.getBlock({blockTag}):client.getBlock({blockNumber:number}),
  transaction:async hash=>{try{return await client.getTransaction({hash});}catch(e){if(e instanceof TransactionNotFoundError)return null;throw e;}},
  receipt:async hash=>{try{return await client.getTransactionReceipt({hash});}catch(e){if(e instanceof TransactionReceiptNotFoundError)return null;throw e;}},
  code:(address,blockNumber)=>client.getCode({address,blockNumber}),
  configuration:async(address,blockNumber)=>{
    const args={address,blockNumber,abi},names=['asset','eligibility','reviewer','committeeHash','ALLOCATION_POLICY','RELEASE_POLICY','DELIVERY_SCHEMA'] as const;
    const [values,committee]=await Promise.all([Promise.all(names.map(functionName=>client.readContract({...args,functionName}))),Promise.all([0n,1n,2n].map(i=>client.readContract({...args,functionName:'committee',args:[i]})))]);
    return {asset:values[0],gate:values[1],reviewer:values[2],committee,committeeHash:values[3],allocationPolicy:values[4],releasePolicy:values[5],deliverySchema:values[6]};
  },
};}
