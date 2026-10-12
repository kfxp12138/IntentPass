import test from 'node:test';
import assert from 'node:assert/strict';
import {BaseError,HttpRequestError,RpcRequestError,createPublicClient,http,encodeFunctionResult,parseAbi,type Address,type Hex,type PublicClient} from 'viem';
import {day4SubmitRejectionPort} from '../packages/protocol/src/day4-submit-rejection-port.js';
import {day4SubmitGas,type Day4SubmitRejectionPort} from '../packages/protocol/src/day4-submit-rejection-types.js';

// All providers below are explicit local doubles, including installed viem's
// custom-fetch HTTP transport. No real RPC, wallet, endpoint, or credential is used.
const from=('0x'+'11'.repeat(20)) as Address,to=('0x'+'22'.repeat(20)) as Address,data='0x12345678' as Hex;
const submit=():Parameters<Day4SubmitRejectionPort['submitCall']>[0]=>({from,to,value:0n,gas:day4SubmitGas,data,blockNumber:30n});
type Request=(input:unknown,options?:unknown)=>Promise<unknown>;
function fixture(handler:Request=async()=> '0x'){
  const requests:{input:unknown;options:unknown}[]=[],calls:unknown[]=[],blocks:unknown[]=[];
  const client={request:async(input:unknown,options?:unknown)=>{requests.push({input,options});return handler(input,options);},
    getChainId:async()=>10143,
    getBlock:async(input:unknown)=>{blocks.push(input);return {number:30n,hash:('0x'+'33'.repeat(32)) as Hex,timestamp:130n};},
    getTransaction:async()=>null,getTransactionReceipt:async()=>null,getCode:async()=> '0x6000',
    call:async(input:unknown)=>{calls.push(input);return {data:encodeFunctionResult({abi:parseAbi(['function asset() view returns(address)']),functionName:'asset',result:from})};},
  };
  return {client,requests,calls,blocks,port:day4SubmitRejectionPort(client as unknown as PublicClient)};
}
function rpcError(code: number=3,...values:unknown[]){
  return new RpcRequestError({body:{method:'eth_call',params:['SYNTHETIC_REQUEST_BODY']},
    error:{code,data:values.length?values[0]:'0x8baa579f',message:'SYNTHETIC_PRIVATE_PROVIDER_TEXT'},url:'https://synthetic-provider.invalid/private'});
}
const unavailable={status:'UNAVAILABLE',reason:'RPC_UNAVAILABLE'};
const missingBytes={status:'UNAVAILABLE',reason:'REVERT_BYTES_UNAVAILABLE'};

test('raw query sends only exact to data and canonical historical height with no retry or extra RPC params',async()=>{
  const f=fixture(async()=> '0xAABB');
  assert.equal(await f.port.query({to,data,blockNumber:30n}),'0xaabb');
  assert.deepEqual(f.requests,[{input:{method:'eth_call',params:[{to,data},'0x1e']},options:{retryCount:0,dedupe:false}}]);
  assert.equal(f.calls.length,0);assert.equal(Object.isFrozen(f.port),true);
});
test('submit raw call fixes original from to zero value gas data and canonical zero or selected height',async()=>{
  const f=fixture();
  for(const blockNumber of [0n,30n])assert.deepEqual(await f.port.submitCall({...submit(),blockNumber}),{status:'SUCCESS',returnData:'0x'});
  assert.deepEqual(f.requests.map(value=>value.input),[0n,30n].map(block=>({method:'eth_call',params:[{from,to,value:'0x0',gas:'0x4c4b40',data},`0x${block.toString(16)}`]})));
  assert.ok(f.requests.every(value=>Object.isFrozen(value.input)&&Object.isFrozen((value.input as {params:unknown[]}).params)
    &&Object.isFrozen((value.input as {params:unknown[]}).params[0])));
  assert.equal(f.calls.length,0);
  assert.deepEqual(Object.keys(f.port),['blockTag','chainId','block','transaction','receipt','code','gateConfiguration','escrowConfiguration','query','submitCall']);
});
test('real installed RpcRequestError code 3 with even bounded bytes gives safe normalized revert',async()=>{
  const f=fixture(async()=>{throw rpcError(3,'0x8BAA579F');});
  const result=await f.port.submitCall(submit());assert.deepEqual(result,{status:'REVERT',revertData:'0x8baa579f',rpcCode:3});
  assert.equal(Object.isFrozen(result),true);assert.equal(f.requests.length,1);
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE_PROVIDER_TEXT'),false);
  assert.equal(JSON.stringify(result).includes('synthetic-provider'),false);
});
test('real bounded BaseError cause chain can reach RpcRequestError without relying on message or walk',async()=>{
  const error=new BaseError('SYNTHETIC_OUTER_TEXT',{cause:new BaseError('SYNTHETIC_MIDDLE_TEXT',{cause:rpcError()})});
  error.walk=()=>{throw Error('SYNTHETIC_WALK_MUST_NOT_RUN');};
  const f=fixture(async()=>{throw error;});assert.deepEqual(await f.port.submitCall(submit()),{status:'REVERT',revertData:'0x8baa579f',rpcCode:3});
});
test('plain pseudo RPC errors and arbitrary Error or object cause chains never become revert evidence',async()=>{
  const plain={name:'RpcRequestError',code:3,data:'0x8baa579f',message:'execution reverted'},outer=new Error('SYNTHETIC_OUTER',{cause:rpcError()});
  for(const error of [plain,outer,{cause:rpcError()},new BaseError('SYNTHETIC_OUTER',{cause:plain as unknown as Error})]){
    const f=fixture(async()=>{throw error;});assert.deepEqual(await f.port.submitCall(submit()),unavailable);assert.equal(f.requests.length,1);
  }
});
test('HTTP status 403 text and data never become RPC policy or contract rejection evidence',async()=>{
  const error=new HttpRequestError({status:403,url:'https://synthetic-provider.invalid/private',details:'execution reverted policy denial 0x8baa579f',body:{code:3,data:'0x8baa579f'}});
  const f=fixture(async()=>{throw error;});assert.deepEqual(await f.port.submitCall(submit()),unavailable);
});
test('other real RPC codes including canonical revert-looking data remain unavailable with exactly one request',async()=>{
  for(const code of [-32000,-32603,4001,403,0]){
    const f=fixture(async()=>{throw rpcError(code);});assert.deepEqual(await f.port.submitCall(submit()),unavailable);assert.equal(f.requests.length,1);
  }
});
test('code 3 without nonempty canonical even bounded hex bytes reports revert bytes unavailable',async()=>{
  for(const raw of [undefined,null,'0x','0x1','0X8baa579f','0xzz',' 0x8baa579f',{data:'0x8baa579f'},'0x'+'aa'.repeat(4097)]){
    const f=fixture(async()=>{throw rpcError(3,raw);});assert.deepEqual(await f.port.submitCall(submit()),missingBytes);assert.equal(f.requests.length,1);
  }
});
test('cause depth bound cycles and throwing cause getters fail closed without raw error exposure',async()=>{
  let deep:BaseError=rpcError();for(let i=0;i<8;i++)deep=new BaseError('SYNTHETIC_DEPTH',{cause:deep});
  const cycle=new BaseError('SYNTHETIC_CYCLE');Object.defineProperty(cycle,'cause',{value:cycle});
  const getter=new BaseError('SYNTHETIC_GETTER');Object.defineProperty(getter,'cause',{get:()=>{throw Error('SYNTHETIC_PRIVATE_THROW');}});
  for(const error of [deep,cycle,getter]){const f=fixture(async()=>{throw error;});assert.deepEqual(await f.port.submitCall(submit()),unavailable);}
});
test('real RPC error fields with hostile accessors cannot execute a data getter or leak provider contents',async()=>{
  const error=rpcError();let reads=0;Object.defineProperty(error,'data',{get:()=>{reads++;throw Error('SYNTHETIC_PRIVATE_THROW');}});
  const f=fixture(async()=>{throw error;});assert.deepEqual(await f.port.submitCall(submit()),missingBytes);assert.equal(reads,0);
  const code=rpcError();Object.defineProperty(code,'code',{get:()=>{throw Error('SYNTHETIC_PRIVATE_THROW');}});
  const g=fixture(async()=>{throw code;});assert.deepEqual(await g.port.submitCall(submit()),unavailable);
});
test('invalid success bytes and arbitrary success objects never enter safe outcomes',async()=>{
  for(const raw of [undefined,null,'0x0','0xgg','0X00',{data:'0x'},'0x'+'aa'.repeat(128*1024+1)]){
    const f=fixture(async()=>raw);assert.deepEqual(await f.port.submitCall(submit()),unavailable);assert.equal(await f.port.query({to,data,blockNumber:30n}),undefined);
  }
});
test('query provider failures return undefined without retries or extracting pseudo revert data',async()=>{
  for(const error of [rpcError(),new Error('SYNTHETIC_PRIVATE_THROW')]){
    const f=fixture(async()=>{throw error;});assert.equal(await f.port.query({to,data,blockNumber:30n}),undefined);assert.equal(f.requests.length,1);
  }
});
test('wrong value gas addresses calldata heights and state overrides reject before the first request',async()=>{
  for(const patch of [{value:1n},{value:'0'},{gas:day4SubmitGas-1n},{gas:'5000000'},{from:'bad'},{to:'bad'},{data:'0x'},{data:'0x1'},
    {blockNumber:-1n},{blockNumber:2n**256n},{blockNumber:30},{stateOverride:[]}]){
    const f=fixture();await assert.rejects(f.port.submitCall({...submit(),...patch} as Parameters<Day4SubmitRejectionPort['submitCall']>[0]),
      (error:unknown)=>error instanceof Error&&error.message==='DAY4_SUBMIT_CALL_INVALID');assert.equal(f.requests.length,0);
  }
});
test('invalid query shape and hostile input getters reject with only fixed errors before any request',async()=>{
  const f=fixture();for(const input of [{to,data,blockNumber:-1n},{to,data,blockNumber:30n,stateOverride:[]},{to,data:'0x1',blockNumber:30n}]){
    await assert.rejects(f.port.query(input as Parameters<Day4SubmitRejectionPort['query']>[0]),/DAY4_SUBMIT_QUERY_INVALID/);
  }
  const hostile={...submit()};Object.defineProperty(hostile,'data',{enumerable:true,get:()=>{throw Error('SYNTHETIC_PRIVATE_THROW');}});
  await assert.rejects(f.port.submitCall(hostile),(error:unknown)=>error instanceof Error&&error.message==='DAY4_SUBMIT_CALL_INVALID');assert.equal(f.requests.length,0);
});
test('original input and deeply frozen outgoing request cannot change while the local provider awaits',async()=>{
  let release!:()=>void;const pause=new Promise<void>(resolve=>{release=resolve;});
  const f=fixture(async input=>{await pause;const fixed=input as {params:[{data:Hex;value:Hex;gas:Hex},Hex]};
    assert.equal(fixed.params[0].data,data);assert.equal(fixed.params[0].value,'0x0');assert.equal(fixed.params[0].gas,'0x4c4b40');assert.equal(fixed.params[1],'0x1e');return '0x';});
  const input=submit(),pending=f.port.submitCall(input);input.data='0xabcdef00';input.blockNumber=99n;
  const outgoing=f.requests[0].input as {params:[{data:Hex},Hex]};assert.throws(()=>{outgoing.params[0].data='0xaabb';},TypeError);
  release();assert.deepEqual(await pending,{status:'SUCCESS',returnData:'0x'});assert.equal(f.requests.length,1);
});
test('captured original raw request and inherited read methods resist later client method replacement',async()=>{
  const f=fixture();const pending=f.port.query({to,data,blockNumber:30n});let replaced=0;
  for(const method of ['request','getChainId','getBlock','getTransaction','getTransactionReceipt','getCode','call'])
    (f.client as unknown as Record<string,unknown>)[method]=async()=>{replaced++;throw Error('SYNTHETIC_REPLACED_METHOD');};
  assert.equal(await pending,'0x');assert.deepEqual(await f.port.submitCall(submit()),{status:'SUCCESS',returnData:'0x'});
  assert.equal(await f.port.chainId(),10143);await f.port.block();await f.port.block(30n);assert.equal(await f.port.code(to,30n),'0x6000');
  assert.deepEqual(await f.port.gateConfiguration(to,30n),{asset:from,validator:from,policy:from,pool:from});
  assert.deepEqual(f.blocks,[{blockTag:'finalized'},{blockNumber:30n}]);assert.equal(replaced,0);
});
test('installed viem HTTP custom fetch preserves true RpcRequestError through its bounded BaseError wrapper without network',async()=>{
  const bodies:unknown[]=[];
  const client=createPublicClient({transport:http('https://synthetic-provider.invalid',{retryCount:0,batch:false,
    fetchFn:async(_input,init)=>{const body=JSON.parse(String(init?.body));bodies.push(body);
      return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,error:{code:3,data:'0x8baa579f',message:'SYNTHETIC_PRIVATE_PROVIDER_TEXT'}}),
        {status:200,headers:{'Content-Type':'application/json'}});}})});
  const port=day4SubmitRejectionPort(client);assert.deepEqual(await port.submitCall(submit()),{status:'REVERT',revertData:'0x8baa579f',rpcCode:3});
  assert.equal(bodies.length,1);assert.equal(Array.isArray(bodies[0]),false);
  assert.deepEqual((bodies[0] as {params:unknown}).params,[{from,to,value:'0x0',gas:'0x4c4b40',data},'0x1e']);
});
test('installed viem HTTP failure stays unavailable even with policy-looking message and exact revert selector',async()=>{
  let calls=0;const client=createPublicClient({transport:http('https://synthetic-provider.invalid',{retryCount:0,batch:false,
    fetchFn:async()=>{calls++;return new Response(JSON.stringify({code:3,data:'0x8baa579f',error:'policy_violation'}),{status:403,headers:{'Content-Type':'application/json'}});}})});
  assert.deepEqual(await day4SubmitRejectionPort(client).submitCall(submit()),unavailable);assert.equal(calls,1);
});
