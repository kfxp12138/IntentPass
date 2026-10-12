import {parseAbi,TransactionNotFoundError,TransactionReceiptNotFoundError,type PublicClient} from 'viem';
import type {CleanverseGateProofPort} from './cleanverse-gate-proof-types.js';
const abi=parseAbi(['function asset() view returns(address)','function validator() view returns(address)','function policy() view returns(address)','function pool() view returns(address)']);
export function cleanverseGateProofPort(client:PublicClient):CleanverseGateProofPort{return{
  blockTag:'finalized',chainId:()=>client.getChainId(),
  block:number=>number===undefined?client.getBlock({blockTag:'finalized'}):client.getBlock({blockNumber:number}),
  transaction:async hash=>{try{return await client.getTransaction({hash});}catch(error){if(error instanceof TransactionNotFoundError)return null;throw error;}},
  receipt:async hash=>{try{return await client.getTransactionReceipt({hash});}catch(error){if(error instanceof TransactionReceiptNotFoundError)return null;throw error;}},
  code:(address,blockNumber)=>client.getCode({address,blockNumber}),
  configuration:async(address,blockNumber)=>{
    const [asset,validator,policy,pool]=await Promise.all((['asset','validator','policy','pool'] as const).map(functionName=>client.readContract({address,blockNumber,abi,functionName})));
    return {asset,validator,policy,pool};
  }
};}
