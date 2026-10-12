import test from 'node:test';
import assert from 'node:assert/strict';
import type {Address,Hex} from 'viem';
import {day4FailureTracePort} from '../packages/adapters/src/day4-failure-trace.js';
import type {Day4FailureTraceResult} from '../packages/protocol/src/day4-asset-failure-types.js';

// Explicit synthetic HTTP/stream doubles only. These tests never contact Monad,
// another RPC/provider, a wallet or a credential source; no D4 acceptance claim.
const endpoint='https://testnet-rpc.monad.xyz';
const hash=('0x'+'ab'.repeat(32)) as Hex;
const from=('0x'+'11'.repeat(20)) as Address,to=('0x'+'22'.repeat(20)) as Address;
const invalid={status:'UNAVAILABLE',reason:'TRACE_INVALID'};
const limit={status:'UNAVAILABLE',reason:'TRACE_LIMIT_EXCEEDED'};
const rpc={status:'UNAVAILABLE',reason:'RPC_UNAVAILABLE'};
type Frame=Record<string,unknown>;
const frame=(patch:Frame={}):Frame=>({type:'CALL',from,to,value:'0x0',gas:'0x4c4b40',gasUsed:'0x7530',input:'0x12345678',output:'0x',...patch});
const envelope=(trace:unknown=frame())=>({jsonrpc:'2.0',id:1,result:trace});
function response(body:string|Uint8Array,status=200,headers:Record<string,string>={},options:{url?:string;redirected?:boolean}={}):Response{
  const value=new Response(typeof body==='string'?body:Uint8Array.from(body).buffer,{status,headers:{'content-type':'application/json',...headers}});
  Object.defineProperty(value,'url',{value:options.url??endpoint});Object.defineProperty(value,'redirected',{value:options.redirected??false});return value;
}
function fixture(body:unknown=envelope(),options:{raw?:boolean;status?:number;headers?:Record<string,string>;url?:string;redirected?:boolean}={}){
  const calls:{input:unknown;init:RequestInit}[]=[];
  const config={fetch:(async(input,init)=>{
    assert.ok(init);calls.push({input,init});return response(options.raw?body as string:JSON.stringify(body),options.status,options.headers,options);
  }) as typeof globalThis.fetch};
  const port=day4FailureTracePort(config);return {port,calls,config};
}
const available=(result:Day4FailureTraceResult)=>{assert.equal(result.status,'AVAILABLE');if(result.status!=='AVAILABLE')throw Error('SYNTHETIC_EXPECTED_TRACE');return result.trace;};

test('fixed trace sends one exact original-hash native callTracer HTTPS POST with no override or retry',async()=>{
  const f=fixture(),result=await f.port.traceTransaction(hash);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].input,endpoint);
  const request=f.calls[0].init;
  assert.equal(request.method,'POST');assert.equal(request.redirect,'error');assert.ok(request.signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(request).sort(),['body','headers','method','redirect','signal']);
  assert.deepEqual(request.headers,{'content-type':'application/json'});
  assert.deepEqual(JSON.parse(request.body as string),{jsonrpc:'2.0',id:1,method:'debug_traceTransaction',params:[hash,
    {tracer:'callTracer',tracerConfig:{onlyTopCall:false,withLog:false}}]});
  assert.ok(Object.isFrozen(request));assert.ok(Object.isFrozen(request.headers));assert.ok(Object.isFrozen(f.port));
  assert.deepEqual(available(result),{type:'CALL',from,to,value:0n,gas:5_000_000n,gasUsed:30_000n,input:'0x12345678',output:'0x',failed:false,calls:[]});
});

test('factory captures its original fetch and normalized hash before any asynchronous response',async()=>{
  let release!:(value:Response)=>void,firstCalls=0,swappedCalls=0;
  const options={fetch:(async()=>{firstCalls++;return new Promise<Response>(resolve=>{release=resolve;});}) as typeof globalThis.fetch};
  const port=day4FailureTracePort(options),result=port.traceTransaction(hash.toUpperCase().replace('0X','0x') as Hex);
  options.fetch=async()=>{swappedCalls++;throw Error('SYNTHETIC_PRIVATE_SWAPPED_FETCH');};
  release(response(JSON.stringify(envelope())));available(await result);assert.equal(firstCalls,1);assert.equal(swappedCalls,0);
});

test('all allowed Geth frame kinds preserve nested order and normalize omitted optional fields',async()=>{
  const types=['STATICCALL','DELEGATECALL','CALLCODE','CREATE','CREATE2','SELFDESTRUCT'];
  const calls=types.map(type=>{const value=frame({type});delete value.to;delete value.value;delete value.output;return value;});
  const f=fixture(envelope(frame({calls}))),trace=available(await f.port.traceTransaction(hash));
  assert.deepEqual(trace.calls.map(value=>value.type),types);
  assert.ok(trace.calls.every(value=>value.to===null&&value.value===0n&&value.output==='0x'&&value.calls.length===0));
  assert.ok(Object.isFrozen(trace)&&Object.isFrozen(trace.calls)&&trace.calls.every(Object.isFrozen));
  assert.throws(()=>{(trace.calls as unknown as unknown[]).push({});},TypeError);
});

test('nonempty error is only a structural failure marker and every provider text or extension is excluded',async()=>{
  for(const text of ['execution reverted','out of gas','policy_violation','apikey_SYNTHETIC_SECRET']){
    const f=fixture(envelope(frame({error:text,revertReason:'SYNTHETIC_PRIVATE_REASON',privateMetadata:'SYNTHETIC_EXTENSION',logs:[{secret:'SYNTHETIC_LOG'}]})));
    const trace=available(await f.port.traceTransaction(hash));assert.equal(trace.failed,true);
    assert.deepEqual(Object.keys(trace).sort(),['calls','failed','from','gas','gasUsed','input','output','to','type','value']);
    const publicText=JSON.stringify(trace,(_,value)=>typeof value==='bigint'?value.toString():value);
    assert.ok(!publicText.includes(text));assert.ok(!publicText.includes('SYNTHETIC'));
  }
});

test('revertReason or revert-looking output alone never invents a failed frame',async()=>{
  const f=fixture(envelope(frame({output:'0x08c379a0',revertReason:'SYNTHETIC_REVERT_REASON'})));
  const trace=available(await f.port.traceTransaction(hash));assert.equal(trace.failed,false);assert.equal(trace.output,'0x08c379a0');
});

test('empty or nonstring errors malformed optional fields and unknown types are invalid without raw text',async()=>{
  for(const patch of [{error:''},{error:null},{error:3},{revertReason:null},{revertReason:{}},{type:'SUICIDE'},
    {type:'SYNTHETIC_PRIVATE_TEXT'},{from:'not-address'},{to:null},{value:null},{output:null},{calls:null},{calls:{}},
    {input:null},{gasUsed:30},{type:null}]){
    const f=fixture(envelope(frame(patch)));assert.deepEqual(await f.port.traceTransaction(hash),invalid);assert.equal(f.calls.length,1);
  }
});

test('gas gasUsed and value require canonical bounded hex quantities, not decimal or padded aliases',async()=>{
  for(const field of ['gas','gasUsed','value'])for(const value of ['0x','0x00','0x01','0X1','1','0xgg','-1',1,' 0x1']){
    const f=fixture(envelope(frame({[field]:value})));assert.deepEqual(await f.port.traceTransaction(hash),invalid);
  }
  for(const patch of [{gas:'0x1'+'0'.repeat(16)},{gasUsed:'0x1'+'0'.repeat(16)},{value:'0x1'+'0'.repeat(64)}]){
    assert.deepEqual(await fixture(envelope(frame(patch))).port.traceTransaction(hash),invalid);
  }
  const trace=available(await fixture(envelope(frame({gas:'0xFFFFFFFFFFFFFFFF',gasUsed:'0x0',value:'0x'+'F'.repeat(64)}))).port.traceTransaction(hash));
  assert.equal(trace.gas,2n**64n-1n);assert.equal(trace.value,2n**256n-1n);
});

test('data fields require even byte hex and normalize uppercase without interpreting returned bytes',async()=>{
  for(const field of ['input','output'])for(const value of ['0x1','0X00','00','0xzz',0,{data:'0x'}]){
    assert.deepEqual(await fixture(envelope(frame({[field]:value}))).port.traceTransaction(hash),invalid);
  }
  const trace=available(await fixture(envelope(frame({input:'0xAABB',output:'0xFF'}))).port.traceTransaction(hash));
  assert.equal(trace.input,'0xaabb');assert.equal(trace.output,'0xff');
});

test('each input and output accepts the actual 64KiB boundary and refuses any larger byte field',async()=>{
  const bounded='0x'+'aa'.repeat(64*1024);
  const trace=available(await fixture(envelope(frame({input:bounded,output:bounded}))).port.traceTransaction(hash));
  assert.equal(trace.input,bounded);assert.equal(trace.output,bounded);
  for(const field of ['input','output'])assert.deepEqual(await fixture(envelope(frame({[field]:bounded+'aa'}))).port.traceTransaction(hash),limit);
});

test('aggregate input and output bytes accept 256KiB and refuse even one more byte across frames',async()=>{
  const bounded='0x'+'ab'.repeat(64*1024);
  const root=frame({input:bounded,output:bounded,calls:[frame({input:bounded,output:bounded})]});
  available(await fixture(envelope(root)).port.traceTransaction(hash));
  (root.calls as Frame[]).push(frame({input:'0x00'}));
  assert.deepEqual(await fixture(envelope(root)).port.traceTransaction(hash),limit);
});

test('node cap covers all branches and accepts exactly 1024 frames',async()=>{
  const root=frame({calls:Array.from({length:1023},()=>frame())});
  assert.equal(available(await fixture(envelope(root)).port.traceTransaction(hash)).calls.length,1023);
  (root.calls as Frame[]).push(frame());assert.deepEqual(await fixture(envelope(root)).port.traceTransaction(hash),limit);
});

test('depth cap is enforced on the complete nested tree before a public trace is returned',async()=>{
  const nested=(levels:number)=>{let root=frame();for(let i=1;i<levels;i++)root=frame({calls:[root]});return root;};
  available(await fixture(envelope(nested(64))).port.traceTransaction(hash));
  assert.deepEqual(await fixture(envelope(nested(65))).port.traceTransaction(hash),limit);
});

test('provider error and revertReason strings are bounded by actual UTF8 bytes and never returned',async()=>{
  const trace=available(await fixture(envelope(frame({error:'x'.repeat(8192),revertReason:'x'.repeat(8192)}))).port.traceTransaction(hash));
  assert.equal(trace.failed,true);
  for(const patch of [{error:'x'.repeat(8193)},{revertReason:'x'.repeat(8193)},{error:'中'.repeat(2731)}]){
    assert.deepEqual(await fixture(envelope(frame(patch))).port.traceTransaction(hash),limit);
  }
});

test('strict JSON rejects nested literal and decoded duplicate keys instead of accepting the last failure field',async()=>{
  const good=JSON.stringify(envelope());
  for(const text of [good.replace('"gas":"0x4c4b40"','"gas":"0x4c4b40","gas":"0x0"'),
    good.replace('"gas":"0x4c4b40"','"gas":"0x4c4b40","g\\u0061s":"0x0"'),
    good.replace('"id":1','"id":2,"id":1'),'{SYNTHETIC_PRIVATE_INVALID_JSON}']){
    assert.deepEqual(await fixture(text,{raw:true}).port.traceTransaction(hash),invalid);
  }
});

test('JSONRPC version id result and envelope shape are exact and RPC error codes never classify a trace failure',async()=>{
  for(const body of [{...envelope(),jsonrpc:'1.0'},{...envelope(),id:'1'},{...envelope(),id:2},{jsonrpc:'2.0',id:1},
    {...envelope(),private:'SYNTHETIC_PRIVATE_TEXT'},{...envelope(),error:{code:3,message:'SYNTHETIC_ERROR'}},{...envelope(),result:null},[envelope()]]){
    assert.deepEqual(await fixture(body).port.traceTransaction(hash),invalid);
  }
  for(const code of [3,-32000,-32601,403]){
    assert.deepEqual(await fixture({jsonrpc:'2.0',id:1,error:{code,data:'0x8baa579f',message:'SYNTHETIC_POLICY_DENIAL'}}).port.traceTransaction(hash),rpc);
  }
});

test('HTTP rejection redirect or endpoint changes remain unavailable and cannot fall back or retry',async()=>{
  for(const options of [{status:403},{status:500},{status:302},{redirected:true},{url:'https://synthetic-private.invalid/secret'},
    {url:endpoint+'/?secret=SYNTHETIC_PRIVATE_KEY'},{url:'http://testnet-rpc.monad.xyz'},{url:''}]){
    const f=fixture(envelope(),options);assert.deepEqual(await f.port.traceTransaction(hash),rpc);assert.equal(f.calls.length,1);
  }
  available(await fixture(envelope(),{url:endpoint+'/'}).port.traceTransaction(hash));
});

test('content type and UTF8 must be valid before strict trace interpretation',async()=>{
  for(const contentType of ['','text/plain','text/html','application/jsonp']){
    assert.deepEqual(await fixture(envelope(),{headers:{'content-type':contentType}}).port.traceTransaction(hash),invalid);
  }
  const port=day4FailureTracePort({fetch:async()=>response(Uint8Array.from([0xff,0xfe]))});assert.deepEqual(await port.traceTransaction(hash),invalid);
  available(await fixture(envelope(),{headers:{'content-type':'application/json; charset=utf-8'}}).port.traceTransaction(hash));
});

test('raw response limit counts UTF8 bytes not characters and respects the exact one MiB boundary',async()=>{
  assert.deepEqual(await fixture(' '.repeat(1024*1024),{raw:true}).port.traceTransaction(hash),invalid);
  assert.deepEqual(await fixture(' '.repeat(1024*1024+1),{raw:true}).port.traceTransaction(hash),limit);
  assert.deepEqual(await fixture(JSON.stringify({padding:'中'.repeat(350000)}),{raw:true}).port.traceTransaction(hash),limit);
});

test('declared or chunked oversized bodies stop consumption without leaking their private contents',async()=>{
  assert.deepEqual(await fixture(envelope(),{headers:{'content-length':String(1024*1024+1)}}).port.traceTransaction(hash),limit);
  let cancelled=0;
  const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(512*1024));controller.enqueue(new Uint8Array(512*1024+1));},cancel(){cancelled++;}});
  const value=new Response(stream,{headers:{'content-type':'application/json'}});Object.defineProperty(value,'url',{value:endpoint});
  const port=day4FailureTracePort({fetch:async()=>value});assert.deepEqual(await port.traceTransaction(hash),limit);assert.equal(cancelled,1);
});

test('network and reader errors have one safe fixed outcome with no private message or retry',async()=>{
  let sent=0;
  const port=day4FailureTracePort({fetch:async()=>{sent++;throw Error('SYNTHETIC_PRIVATE_NETWORK_SECRET');}});
  assert.deepEqual(await port.traceTransaction(hash),rpc);assert.equal(sent,1);
  const stream=new ReadableStream<Uint8Array>({start(controller){controller.error(Error('SYNTHETIC_PRIVATE_STREAM_SECRET'));}});
  const value=new Response(stream,{headers:{'content-type':'application/json'}});Object.defineProperty(value,'url',{value:endpoint});
  assert.deepEqual(await day4FailureTracePort({fetch:async()=>value}).traceTransaction(hash),rpc);
});

test('total ten second lifetime cancels a stalled fetch and ignores late headers without another request',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let sent=0,signal:AbortSignal|undefined,release!:(value:Response)=>void;
  const port=day4FailureTracePort({fetch:async(_,init)=>{sent++;signal=init!.signal as AbortSignal;return new Promise<Response>(resolve=>{release=resolve;});}});
  const pending=port.traceTransaction(hash);t.mock.timers.tick(10_000);
  assert.deepEqual(await pending,rpc);assert.equal(signal!.aborted,true);assert.equal(sent,1);
  release(response(JSON.stringify(envelope())));await new Promise(resolve=>setImmediate(resolve));assert.equal(sent,1);
});

test('the same total lifetime also cancels a stalled response body after immediate headers',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let sent=0,cancelled=0;
  const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0"'));},cancel(){cancelled++;}});
  const value=new Response(stream,{headers:{'content-type':'application/json'}});Object.defineProperty(value,'url',{value:endpoint});
  const port=day4FailureTracePort({fetch:async()=>{sent++;return value;}}),pending=port.traceTransaction(hash);
  await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(10_000);
  assert.deepEqual(await pending,rpc);assert.equal(sent,1);assert.equal(cancelled,1);
});

test('malformed hashes fail before any fetch and port has no sender or arbitrary RPC method',async()=>{
  const f=fixture();for(const value of ['0x','0x1','0x'+'gg'.repeat(32),'0X'+'aa'.repeat(32),{}]){
    assert.deepEqual(await f.port.traceTransaction(value as Hex),invalid);
  }
  assert.equal(f.calls.length,0);assert.deepEqual(Object.keys(f.port),['traceTransaction']);
});
