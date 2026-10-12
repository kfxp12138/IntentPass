import {BaseError,RpcRequestError,type Hex,type PublicClient} from 'viem';
import {day4CreationPairPort} from './day4-creation-pair-port.js';
import {day4SubmitGas,type Day4SubmitCallOutcome,type Day4SubmitRejectionPort} from './day4-submit-rejection-types.js';
import {address,uint} from './schemas.js';

const maxCallBytes=128*1024,maxRevertBytes=4096,maxCauseNodes=8;
function freeze<T>(value:T):T{
  if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}
  return value;
}
function bytes(value:unknown,max:number,empty:boolean):value is Hex{
  return typeof value==='string'&&value.length<=2+max*2
    &&(empty?/^0x(?:[0-9a-fA-F]{2})*$/:/^0x(?:[0-9a-fA-F]{2})+$/).test(value);
}
function snapshot<T extends object>(input:T,keys:readonly string[],code:string):T{
  try{
    const value=freeze(structuredClone(input));
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length
      ||keys.some(key=>!Object.hasOwn(value,key)))throw Error();
    const call=value as Record<string,unknown>;
    if(!address.safeParse(call.to).success||!bytes(call.data,maxCallBytes,false)
      ||typeof call.blockNumber!=='bigint'||!uint.safeParse(String(call.blockNumber)).success)throw Error();
    if(keys.includes('from')&&(!address.safeParse(call.from).success||call.value!==0n||call.gas!==day4SubmitGas))throw Error();
    return value;
  }catch{throw Error(code);}
}
const unavailable=(reason:'RPC_UNAVAILABLE'|'REVERT_BYTES_UNAVAILABLE'='RPC_UNAVAILABLE'):Day4SubmitCallOutcome=>
  Object.freeze({status:'UNAVAILABLE',reason});
function failure(error:unknown):Day4SubmitCallOutcome{
  try{
    const visited=new Set<object>();
    let current=error;
    // Do not use BaseError.walk(): it traverses arbitrary objects without a bound.
    for(let depth=0;depth<maxCauseNodes;depth++){
      if(!(current instanceof BaseError)||visited.has(current))return unavailable();
      visited.add(current);
      if(current instanceof RpcRequestError){
        const code=Object.getOwnPropertyDescriptor(current,'code'),data=Object.getOwnPropertyDescriptor(current,'data');
        if(!code||!('value' in code)||code.value!==3)return unavailable();
        if(!data||!('value' in data)||!bytes(data.value,maxRevertBytes,false))return unavailable('REVERT_BYTES_UNAVAILABLE');
        return Object.freeze({status:'REVERT',revertData:data.value.toLowerCase() as Hex,rpcCode:3});
      }
      const cause=Object.getOwnPropertyDescriptor(current,'cause');
      if(!cause||!('value' in cause))return unavailable();
      current=cause.value;
    }
  }catch{/* Provider errors and hostile accessors have no public message channel. */}
  return unavailable();
}

/** Fixed raw historical eth_call requests only. The supplied public transport
 * must itself be configured without batching; this adapter adds no send/CCIP,
 * state override, retry, or endpoint discovery capability. */
export function day4SubmitRejectionPort(client:PublicClient):Day4SubmitRejectionPort{
  let request:PublicClient['request'],base:ReturnType<typeof day4CreationPairPort>;
  try{request=client.request.bind(client);base=day4CreationPairPort(client);}
  catch{throw Error('DAY4_SUBMIT_PORT_INVALID');}
  const options=Object.freeze({retryCount:0,dedupe:false});
  return Object.freeze({...base,
    query:async(input:Parameters<Day4SubmitRejectionPort['query']>[0]):Promise<Hex|undefined>=>{
      const fixed=snapshot(input,['to','data','blockNumber'],'DAY4_SUBMIT_QUERY_INVALID');
      const rpc=freeze({method:'eth_call' as const,params:[{to:fixed.to,data:fixed.data},`0x${fixed.blockNumber.toString(16)}` as Hex] as const});
      try{
        const result=await request(rpc,options);
        return bytes(result,maxCallBytes,true)?result.toLowerCase() as Hex:undefined;
      }catch{return undefined;}
    },
    submitCall:async(input:Parameters<Day4SubmitRejectionPort['submitCall']>[0]):Promise<Day4SubmitCallOutcome>=>{
      const fixed=snapshot(input,['from','to','value','gas','data','blockNumber'],'DAY4_SUBMIT_CALL_INVALID');
      const rpc=freeze({method:'eth_call' as const,params:[{from:fixed.from,to:fixed.to,value:'0x0' as const,
        gas:`0x${fixed.gas.toString(16)}` as Hex,data:fixed.data},`0x${fixed.blockNumber.toString(16)}` as Hex] as const});
      try{
        const result=await request(rpc,options);
        return bytes(result,maxCallBytes,true)?Object.freeze({status:'SUCCESS',returnData:result.toLowerCase() as Hex}):unavailable();
      }catch(error){return failure(error);}
    },
  });
}
