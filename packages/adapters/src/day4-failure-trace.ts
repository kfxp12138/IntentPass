import type {Address,Hex} from 'viem';
import type {Day4AssetFailurePort,Day4FailureTraceNode,Day4FailureTraceResult} from '../../protocol/src/day4-asset-failure-types.js';
import {strictJsonParse} from '../../../scripts/strict-json.js';

const endpoint='https://testnet-rpc.monad.xyz';
const endpointUrl=new URL(endpoint).href;
// At most 64 frame levels: root depth 0 through depth 63. The enclosing
// JSON-RPC object then fits the shared strict JSON parser's depth bound.
const maxRawBytes=1024*1024,maxDepth=63,maxNodes=1024,maxFrameBytes=64*1024,maxTotalBytes=256*1024,maxStringBytes=8*1024;
const lifetimeMs=10_000;
const callTypes=new Set(['CALL','STATICCALL','DELEGATECALL','CALLCODE','CREATE','CREATE2','SELFDESTRUCT']);
const encoder=new TextEncoder();
type Reason=Extract<Day4FailureTraceResult,{status:'UNAVAILABLE'}>['reason'];
class TraceFailure extends Error{
  constructor(readonly reason:Reason){super(reason);}
}
const unavailable=(reason:Reason):Day4FailureTraceResult=>Object.freeze({status:'UNAVAILABLE',reason});
const invalid=():never=>{throw new TraceFailure('TRACE_INVALID');};
const limited=():never=>{throw new TraceFailure('TRACE_LIMIT_EXCEEDED');};
function record(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))return invalid();
  return value as Record<string,unknown>;
}
function quantity(value:unknown,bits:64|256):bigint{
  if(typeof value!=='string'||value.length>2+bits/4||!/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value))return invalid();
  return BigInt(value);
}
function address(value:unknown):Address{
  if(typeof value!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(value))return invalid();
  return value.toLowerCase() as Address;
}
function boundedText(value:unknown,nonempty:boolean):void{
  if(typeof value!=='string'||nonempty&&value.length===0)return invalid();
  if(encoder.encode(value).length>maxStringBytes)return limited();
}

/** Normalize only public call-frame fields. Provider error/revertReason text and
 * unknown extensions never enter a returned object or an error message. */
function normalize(value:unknown):Day4FailureTraceNode{
  type MutableNode=Omit<Day4FailureTraceNode,'calls'>&{calls:MutableNode[]};
  let nodes=0,totalBytes=0;
  const bytes=(raw:unknown):Hex=>{
    if(typeof raw!=='string')return invalid();
    if(raw.length>2+maxFrameBytes*2)return limited();
    if(!/^0x(?:[0-9a-fA-F]{2})*$/.test(raw))return invalid();
    totalBytes+=(raw.length-2)/2;if(totalBytes>maxTotalBytes)return limited();
    return raw.toLowerCase() as Hex;
  };
  const frame=(raw:unknown,depth:number):{source:Record<string,unknown>;node:MutableNode}=>{
    if(depth>maxDepth||++nodes>maxNodes)return limited();
    const source=record(raw);
    if(typeof source.type!=='string'||!callTypes.has(source.type))return invalid();
    if(Object.hasOwn(source,'error'))boundedText(source.error,true);
    if(Object.hasOwn(source,'revertReason'))boundedText(source.revertReason,false);
    const node:MutableNode={type:source.type as Day4FailureTraceNode['type'],from:address(source.from),
      to:Object.hasOwn(source,'to')?address(source.to):null,
      value:Object.hasOwn(source,'value')?quantity(source.value,256):0n,
      gas:quantity(source.gas,64),gasUsed:quantity(source.gasUsed,64),input:bytes(source.input),
      output:Object.hasOwn(source,'output')?bytes(source.output):'0x',failed:Object.hasOwn(source,'error'),calls:[]};
    return {source,node};
  };
  const root=frame(value,0),pending=[{...root,depth:0}];
  while(pending.length){
    const {source,node,depth}=pending.pop()!;
    const calls=Object.hasOwn(source,'calls')?source.calls:[];
    if(!Array.isArray(calls))return invalid();
    if(calls.length>maxNodes-nodes)return limited();
    for(const raw of calls){
      const child=frame(raw,depth+1);node.calls.push(child.node);pending.push({...child,depth:depth+1});
    }
  }
  // Post-order freeze after the iterative validation; no recursive parser or
  // clone is invoked on the untrusted, potentially over-deep call tree.
  const frozen:MutableNode[]=[root.node];
  for(let i=0;i<frozen.length;i++)frozen.push(...frozen[i].calls);
  for(let i=frozen.length-1;i>=0;i--){Object.freeze(frozen[i].calls);Object.freeze(frozen[i]);}
  return root.node;
}

async function readBody(response:Response,signal:AbortSignal,expired:()=>boolean):Promise<string>{
  const declared=response.headers.get('content-length');
  if(declared!==null){
    if(!/^(0|[1-9][0-9]*)$/.test(declared))return invalid();
    if(BigInt(declared)>BigInt(maxRawBytes))return limited();
  }
  if(!response.body)return invalid();
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];
  let size=0;
  const cancel=()=>{void reader.cancel().catch(()=>{});};
  signal.addEventListener('abort',cancel,{once:true});
  try{
    for(;;){
      if(signal.aborted||expired())throw new TraceFailure('RPC_UNAVAILABLE');
      const {done,value}=await reader.read();if(done)break;
      if(!(value instanceof Uint8Array))return invalid();
      size+=value.byteLength;if(size>maxRawBytes){cancel();return limited();}
      chunks.push(Uint8Array.from(value));
    }
    const bytes=new Uint8Array(size);let offset=0;
    for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return invalid();}
  }finally{
    signal.removeEventListener('abort',cancel);reader.releaseLock();
  }
}

/** Fixed native callTracer on one Monad testnet HTTPS endpoint. The fetch option
 * exists solely for explicit local HTTP/stream doubles; production uses fetch.
 * No wallet, arbitrary tracer, state override, batching, redirect or retry. */
export function day4FailureTracePort(options?:{fetch?:typeof globalThis.fetch}):Pick<Day4AssetFailurePort,'traceTransaction'>{
  let fetch:typeof globalThis.fetch;
  try{fetch=options?.fetch??globalThis.fetch;if(typeof fetch!=='function')throw Error();}
  catch{throw Error('DAY4_FAILURE_TRACE_PORT_INVALID');}
  return Object.freeze({traceTransaction:async(hash:Hex):Promise<Day4FailureTraceResult>=>{
    if(typeof hash!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(hash))return unavailable('TRACE_INVALID');
    const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'debug_traceTransaction',params:[hash.toLowerCase(),
      {tracer:'callTracer',tracerConfig:{onlyTopCall:false,withLog:false}}]});
    const controller=new AbortController(),expiresAt=Date.now()+lifetimeMs;
    let timer:ReturnType<typeof setTimeout>;
    const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{
      reject(new TraceFailure('RPC_UNAVAILABLE'));controller.abort();
    },lifetimeMs);});
    const expired=()=>Date.now()>=expiresAt;
    const perform=async():Promise<Day4FailureTraceResult>=>{
      const init=Object.freeze({method:'POST',redirect:'error' as const,headers:Object.freeze({'content-type':'application/json'}),
        body,signal:controller.signal});
      const response=await fetch(endpoint,init);
      if(controller.signal.aborted||expired())throw new TraceFailure('RPC_UNAVAILABLE');
      if(!(response instanceof Response)||response.redirected||response.url!==endpoint&&response.url!==endpointUrl)
        throw new TraceFailure('RPC_UNAVAILABLE');
      if(!response.ok)throw new TraceFailure('RPC_UNAVAILABLE');
      if(!/^application\/json(?:\s*;[^\r\n]*)?$/i.test(response.headers.get('content-type')??''))return invalid();
      const text=await readBody(response,controller.signal,expired);
      let envelope:Record<string,unknown>;
      try{envelope=record(strictJsonParse(text));}catch(error){
        if(error instanceof TraceFailure)throw error;
        if(error instanceof Error&&error.message==='JSON_DEPTH_EXCEEDED')return limited();
        return invalid();
      }
      if(envelope.jsonrpc!=='2.0'||envelope.id!==1)return invalid();
      if(Object.hasOwn(envelope,'error')){
        if(Object.keys(envelope).length!==3||Object.hasOwn(envelope,'result'))return invalid();
        throw new TraceFailure('RPC_UNAVAILABLE');
      }
      if(Object.keys(envelope).length!==3||!Object.hasOwn(envelope,'result'))return invalid();
      const trace=normalize(envelope.result);
      if(controller.signal.aborted||expired())throw new TraceFailure('RPC_UNAVAILABLE');
      return Object.freeze({status:'AVAILABLE',trace});
    };
    try{return await Promise.race([perform(),deadline]);}
    catch(error){return unavailable(error instanceof TraceFailure?error.reason:'RPC_UNAVAILABLE');}
    finally{clearTimeout(timer!);controller.abort();}
  }});
}
