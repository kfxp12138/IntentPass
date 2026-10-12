import {decodeFunctionResult,encodeFunctionData,encodeFunctionResult,parseAbi,TransactionNotFoundError,TransactionReceiptNotFoundError,type Address,type Hex,type PublicClient} from 'viem';
import type {Day4CreationPairPort} from './day4-origin-types.js';
import {address,uint} from './schemas.js';
const abi=parseAbi(['function asset() view returns(address)','function validator() view returns(address)','function policy() view returns(address)',
  'function pool() view returns(address)','function eligibility() view returns(address)','function reviewer() view returns(address)',
  'function committee(uint256) view returns(address)','function committeeHash() view returns(bytes32)','function ALLOCATION_POLICY() view returns(bytes32)',
  'function RELEASE_POLICY() view returns(bytes32)','function DELIVERY_SCHEMA() view returns(bytes32)']);
type Getter=typeof abi[number]['name'];
/** Raw fixed getters with exact canonical return words. This adapter has no
 * signer, sender, wallet or arbitrary user-selected function entry point. */
export function day4CreationPairPort(client:PublicClient):Day4CreationPairPort{
  const reads=Object.freeze({chainId:client.getChainId.bind(client),block:client.getBlock.bind(client),transaction:client.getTransaction.bind(client),
    receipt:client.getTransactionReceipt.bind(client),code:client.getCode.bind(client),call:client.call.bind(client)});
  const getter=async(target:Address,number:bigint,name:Getter,member?:bigint):Promise<string>=>{
    if(!address.safeParse(target).success||typeof number!=='bigint'||!uint.safeParse(String(number)).success)throw Error('DAY4_CREATIONS_QUERY_INVALID');
    const data=encodeFunctionData({abi,functionName:name,...(name==='committee'?{args:[member!]}:{})} as Parameters<typeof encodeFunctionData>[0]);
    const raw=(await reads.call({to:target,data,blockNumber:number})).data;
    if(typeof raw!=='string'||!/^0x[a-fA-F0-9]{64}$/.test(raw))throw Error('DAY4_CREATIONS_CONFIGURATION_INVALID');
    try{
      const value=decodeFunctionResult({abi,functionName:name,data:raw as Hex});
      const canonical=encodeFunctionResult({abi,functionName:name,result:value} as Parameters<typeof encodeFunctionResult>[0]);
      if(typeof value!=='string'||canonical.toLowerCase()!==raw.toLowerCase())throw Error('NONCANONICAL_LOCAL_GETTER');return value;
    }catch{throw Error('DAY4_CREATIONS_CONFIGURATION_INVALID');}
  };
  const port:Day4CreationPairPort={blockTag:'finalized',chainId:()=>reads.chainId(),
    block:async(number?:bigint)=>{const value=await reads.block(number===undefined?{blockTag:'finalized'}:{blockNumber:number});return {number:value.number,hash:value.hash,timestamp:value.timestamp};},
    transaction:async(hash:Hex)=>{try{return await reads.transaction({hash});}catch(error){if(error instanceof TransactionNotFoundError)return null;throw error;}},
    receipt:async(hash:Hex)=>{try{return await reads.receipt({hash});}catch(error){if(error instanceof TransactionReceiptNotFoundError)return null;throw error;}},
    code:(target:Address,blockNumber:bigint)=>reads.code({address:target,blockNumber}),
    gateConfiguration:async(target:Address,number:bigint)=>{const values=await Promise.all((['asset','validator','policy','pool'] as const).map(name=>getter(target,number,name)));
      return {asset:values[0],validator:values[1],policy:values[2],pool:values[3]};},
    escrowConfiguration:async(target:Address,number:bigint)=>{const [values,committee]=await Promise.all([
      Promise.all((['asset','eligibility','reviewer','committeeHash','ALLOCATION_POLICY','RELEASE_POLICY','DELIVERY_SCHEMA'] as const).map(name=>getter(target,number,name))),
      Promise.all([0n,1n,2n].map(index=>getter(target,number,'committee',index)))]);
      return {asset:values[0],gate:values[1],reviewer:values[2],committee,committeeHash:values[3],allocationPolicy:values[4],releasePolicy:values[5],deliverySchema:values[6]};},
  };
  return Object.freeze(port);
}
