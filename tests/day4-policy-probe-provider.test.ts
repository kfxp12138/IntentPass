import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {encodeFunctionData,type Address,type Hex} from 'viem';
import {day4PolicyProbeProvider,type Day4PolicyProbeProviderConfig} from '../packages/adapters/src/day4-policy-probe-provider.js';
import {Day4PolicyProbeAttemptSchema,day4PolicyProbeKey,type Day4PolicyProbeAttempt,type Day4PolicyProbeCall,type Day4PolicyProbeJournal} from '../packages/protocol/src/day4-policy-probe-types.js';
import {escrowAbi} from '../packages/protocol/src/escrow-abi.js';

// Explicit local installed-SDK/custom-fetch doubles. No network, real wallet,
// application credential, provider policy or on-chain acceptance is exercised.
const authorizationPrivateKey=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({type:'pkcs8',format:'der'}).toString('base64');
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address;
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
const uuid='00000000-0000-4000-8000-000000000001';
const fixedError=(error:unknown)=>error instanceof Error&&/^DAY4_POLICY_PROBE_[A-Z_]+$/.test(error.message);

function localResponse(url:string,body:string|Uint8Array,status=403,headers:Record<string,string>={},extra:{url?:string;redirected?:boolean}={}){
  const response=new Response(typeof body==='string'?body:new Uint8Array(body).buffer,{status,headers:{'content-type':'application/json',...headers}});
  Object.defineProperty(response,'url',{value:extra.url??url,configurable:true});
  Object.defineProperty(response,'redirected',{value:extra.redirected??false,configurable:true});return response;
}
function fixture(options:{key?:string;body?:unknown;status?:number;headers?:Record<string,string>;fetch?:typeof globalThis.fetch}={}){
  const config:Day4PolicyProbeProviderConfig={chainId:'10143',arbiter:a(2),address:a(1),walletId:'synthetic-wallet',policyId:'synthetic-policy',
    signerId:'synthetic-signer',appId:'synthetic-app',appSecret:'synthetic-app-secret',authorizationPrivateKey:options.key??authorizationPrivateKey};
  const ids={funding:'synthetic-original-funding',allocation:'synthetic-original-allocation'};
  const call:Day4PolicyProbeCall={chainId:'10143',walletId:config.walletId,policyId:config.policyId,signerId:config.signerId,executor:config.address,
    arbiter:config.arbiter,orderId:h(1),contextHash:h(2),block:{number:'100',hash:h(3),timestamp:'1000'},
    data:encodeFunctionData({abi:escrowAbi,functionName:'orders',args:[h(1)]}),value:'0',gas:'5000000'};
  let stored:Day4PolicyProbeAttempt|null=null;
  const events:string[]=[],sent:{url:string;init:RequestInit}[]=[],responses:{body:Uint8Array;headers:readonly (readonly [string,string])[]}[]=[];
  const hooks:{reserve?:()=>void;response?:()=>void;hash?:()=>void;unknown?:()=>void;network?:(url:string,init:RequestInit)=>Promise<Response>}={};
  const copied=()=>stored===null?null:structuredClone(stored);
  const update=(fields:Partial<Day4PolicyProbeAttempt>)=>{
    assert.ok(stored);stored=Day4PolicyProbeAttemptSchema.parse({...stored,...fields,updatedAt:new Date().toISOString()});return copied()!;
  };
  const journal:Day4PolicyProbeJournal={get:()=>copied(),reserve:(value)=>{
    events.push('reserve');assert.equal(stored,null);const at=new Date().toISOString();
    stored=Day4PolicyProbeAttemptSchema.parse({key:day4PolicyProbeKey(value),attemptId:uuid,call:structuredClone(value),createdAt:at,updatedAt:at,
      status:'RESERVED',httpStatus:null,rawResponseStored:false,transactionHash:null,transactionHashStored:false});hooks.reserve?.();return copied()!;
  },recordResponse:(key,id,status,body,headers)=>{
    events.push('response');assert.equal(key,stored!.key);assert.equal(id,stored!.attemptId);hooks.response?.();
    responses.push({body:Uint8Array.from(body),headers:structuredClone(headers)});
    return update({httpStatus:status,rawResponseStored:true,status:stored!.transactionHash===null?'HTTP_CAPTURED':'UNEXPECTED_BROADCAST'});
  },markUnknown:(key,id)=>{
    events.push('unknown');assert.equal(key,stored!.key);assert.equal(id,stored!.attemptId);hooks.unknown?.();return update({status:'OUTCOME_UNKNOWN'});
  },recordUnexpectedHash:(key,id,hash)=>{
    events.push('hash');assert.equal(key,stored!.key);assert.equal(id,stored!.attemptId);hooks.hash?.();
    return update({status:'UNEXPECTED_BROADCAST',transactionHash:hash,transactionHashStored:true});
  }};
  const fetchOptions:{fetch:typeof globalThis.fetch}={fetch:options.fetch??(async(input,init)=>{
    assert.equal(typeof input,'string');assert.ok(init);const url=String(input);sent.push({url,init});events.push(init.method==='POST'?'forward-post':'forward-get');
    assert.equal(init.redirect,'error');assert.ok(Object.isFrozen(init));assert.ok(Object.isFrozen(init.headers));
    if(hooks.network)return hooks.network(url,init);
    return localResponse(url,JSON.stringify(options.body??{code:'policy_violation',message:'synthetic only'}),options.status??403,options.headers);
  })};
  const provider=day4PolicyProbeProvider(config,ids,journal,fetchOptions);
  return {config,ids,call,journal,fetchOptions,provider,hooks,sent,events,responses,stored:copied,
    create:()=>day4PolicyProbeProvider(config,ids,journal,fetchOptions)};
}

test('fixed policy probe uses actual installed SDK and captures 403 JSON without classifying policy denial',async()=>{
  const f=fixture(),result=await f.provider.capture(f.call);
  assert.equal(result.walletRpcAttempts,1);assert.equal(result.attempt.status,'HTTP_CAPTURED');assert.equal(result.attempt.httpStatus,403);
  assert.equal(result.attempt.transactionHash,null);assert.equal(result.attempt.rawResponseStored,true);
  assert.deepEqual(f.events,['reserve','forward-post','response']);assert.equal(f.sent.length,1);
  assert.deepEqual(JSON.parse(f.sent[0].init.body as string),{caip2:'eip155:10143',params:{transaction:{chain_id:'0x279f',from:a(1),to:a(2),value:'0x0',data:f.call.data,gas_limit:'0x4c4b40'}},method:'eth_sendTransaction',chain_type:'ethereum'});
  const headers=new Headers(f.sent[0].init.headers);
  assert.equal(headers.get('privy-idempotency-key'),uuid);assert.equal(headers.get('x-stainless-retry-count'),'0');assert.ok(headers.get('privy-authorization-signature'));
  const publicText=JSON.stringify(result);assert.ok(!publicText.includes('policy_violation'));assert.ok(!publicText.includes(f.config.appSecret));
  assert.ok(!publicText.includes(authorizationPrivateKey));assert.ok(!publicText.includes(headers.get('privy-authorization-signature')!));
  assert.ok(!Buffer.from(f.responses[0].body).includes(authorizationPrivateKey));assert.equal(Day4PolicyProbeAttemptSchema.safeParse(result.attempt).success,true);
});

test('only fixed original transaction IDs wallet and policy GETs are exposed and detached',async()=>{
  const f=fixture();f.hooks.network=async(url)=>localResponse(url,JSON.stringify({id:'synthetic-response',extra:'local metadata'}),200);
  for(const id of [f.ids.funding,f.ids.allocation])assert.deepEqual(await f.provider.origins.transaction(id),{id:'synthetic-response',extra:'local metadata'});
  const wallet=await f.provider.origins.wallet(f.config.walletId);assert.ok(Object.isFrozen(wallet));await f.provider.origins.policy(f.config.policyId);
  for(const run of [()=>f.provider.origins.transaction('another-id'),()=>f.provider.origins.wallet(f.config.policyId),()=>f.provider.origins.policy('../policy')])await assert.rejects(run,fixedError);
  assert.equal(f.sent.length,4);assert.ok(f.sent.every(value=>value.init.method==='GET'));assert.deepEqual(f.provider.snapshot(),{attempt:null,walletRpcAttempts:0,priorAttempt:false});
  assert.equal(f.stored(),null);
});

test('prepare accepts an empty authorization key but capture refuses it before reservation',async()=>{
  const f=fixture({key:''});f.hooks.network=async(url)=>localResponse(url,'{}',200);
  await f.provider.origins.wallet(f.config.walletId);await assert.rejects(f.provider.capture(f.call),fixedError);
  assert.equal(f.stored(),null);assert.equal(f.events.includes('reserve'),false);assert.equal(f.provider.snapshot().walletRpcAttempts,0);
});

test('wrong identity arbitrary calldata gas value and extra fields are refused before reserve or transport',async()=>{
  for(const change of [{walletId:'other-wallet'},{policyId:'other-policy'},{signerId:'other-signer'},{executor:a(9)},{arbiter:a(9)},
    {chainId:'1'},{value:'1'},{gas:'21000'},{data:encodeFunctionData({abi:escrowAbi,functionName:'settle',args:[h(1)]})},{stateOverride:[]}]){
    const f=fixture();await assert.rejects(f.provider.capture({...f.call,...change} as Day4PolicyProbeCall),fixedError);
    assert.equal(f.stored(),null);assert.equal(f.sent.length,0);
  }
});

test('reservation blocks concurrent calls and both same and new factories after denial',async()=>{
  const f=fixture();let finish!:(response:Response)=>void;f.hooks.network=url=>new Promise(resolve=>{finish=resolve;});
  const first=f.provider.capture(f.call);await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(f.provider.capture(f.call),fixedError);await assert.rejects(f.create().capture(f.call),fixedError);
  finish(localResponse(f.sent[0].url,'{"code":"policy_violation"}'));await first;
  await assert.rejects(f.provider.capture(f.call),fixedError);await assert.rejects(f.create().capture(f.call),fixedError);
  assert.equal(f.sent.length,1);
});

test('a changed height cannot create a new slot for the original wallet order',async()=>{
  const f=fixture();await f.provider.capture(f.call);const next=f.create();
  await assert.rejects(next.capture({...f.call,block:{...f.call.block,number:'101'}}),fixedError);assert.equal(f.sent.length,1);
  assert.equal(next.snapshot().priorAttempt,true);assert.deepEqual(next.snapshot().attempt,f.stored());
});

test('a prior original hash remains visible when new factory policy and height metadata differ',async()=>{
  const f=fixture({status:200,body:{method:'eth_sendTransaction',data:{caip2:'eip155:10143',hash:h(8)}}});await f.provider.capture(f.call);
  f.config.policyId='synthetic-policy-later';const next=f.create();
  await assert.rejects(next.capture({...f.call,policyId:f.config.policyId,block:{...f.call.block,number:'101'}}),fixedError);
  assert.equal(next.snapshot().priorAttempt,true);assert.equal(next.snapshot().attempt!.transactionHash,h(8));
  assert.equal(next.snapshot().attempt!.call.policyId,'synthetic-policy');assert.equal(next.snapshot().walletRpcAttempts,0);assert.equal(f.sent.length,1);
});

test('a competing reservation between get and reserve is recovered read-only with its original unknown or hash outcome',async()=>{
  for(const transactionHash of [null,h(8)]){
    const f=fixture();let reads=0,reserves=0;const at=new Date().toISOString();
    const old=Day4PolicyProbeAttemptSchema.parse({key:day4PolicyProbeKey(f.call),attemptId:uuid,call:{...f.call,block:{...f.call.block,number:'99'}},
      createdAt:at,updatedAt:at,status:transactionHash===null?'OUTCOME_UNKNOWN':'UNEXPECTED_BROADCAST',httpStatus:null,
      rawResponseStored:false,transactionHash,transactionHashStored:transactionHash!==null});
    f.journal.get=()=>++reads===1?null:structuredClone(old);f.journal.reserve=()=>{reserves++;throw Error('synthetic-competing-attempt-exists');};
    const provider=f.create();await assert.rejects(provider.capture(f.call),fixedError);
    assert.equal(reads,2);assert.equal(reserves,1);assert.deepEqual(provider.snapshot(),{attempt:old,walletRpcAttempts:0,priorAttempt:true});
    assert.equal(f.sent.length,0);await assert.rejects(provider.capture(f.call),fixedError);assert.equal(reserves,1);
  }
});

test('input config IDs options and journal method mutation cannot redirect the captured send',async()=>{
  const f=fixture(),original=structuredClone(f.call),originalRecord=f.journal.recordResponse;
  f.hooks.reserve=()=>{
    f.call.data=encodeFunctionData({abi:escrowAbi,functionName:'settle',args:[h(1)]});f.call.executor=a(9);
    f.config.walletId='other-wallet';f.config.authorizationPrivateKey='other-key';f.ids.funding='other-id';
    f.fetchOptions.fetch=async()=>{throw Error('synthetic-swapped-fetch');};f.journal.recordResponse=()=>{throw Error('synthetic-swapped-journal');};
  };
  const result=await f.provider.capture(f.call);assert.equal(result.attempt.status,'HTTP_CAPTURED');assert.equal(result.attempt.call.data,original.data);
  assert.equal(f.sent[0].url,'https://api.privy.io/v1/wallets/synthetic-wallet/rpc');assert.notEqual(f.journal.recordResponse,originalRecord);
});

test('SDK serialization extras cannot pass the final outgoing body guard',async()=>{
  const f=fixture(),stringify=JSON.stringify;
  JSON.stringify=((value:unknown,...args:unknown[])=>stringify(value&&typeof value==='object'&&(value as {method?:string}).method==='eth_sendTransaction'
    ?{...value,sponsor:true}:value,...args as [])) as typeof JSON.stringify;
  try{const result=await f.provider.capture(f.call);assert.equal(result.walletRpcAttempts,0);assert.equal(result.attempt.status,'OUTCOME_UNKNOWN');}
  finally{JSON.stringify=stringify;}
  assert.equal(f.sent.length,0);await assert.rejects(f.provider.capture(f.call),fixedError);
});

test('network failure and timeout are UNKNOWN with one counted POST and no retry or raw error',async()=>{
  for(const error of [Error('synthetic-secret-network-message'),new DOMException('synthetic-private-timeout','TimeoutError')]){
    const f=fixture();f.hooks.network=async()=>{throw error;};const result=await f.provider.capture(f.call);
    assert.equal(result.walletRpcAttempts,1);assert.equal(result.attempt.status,'OUTCOME_UNKNOWN');assert.equal(result.attempt.rawResponseStored,false);
    assert.equal(f.sent.length,1);assert.ok(!JSON.stringify(result).includes(error.message));await assert.rejects(f.create().capture(f.call),fixedError);
  }
});

test('bad response URL redirects headers and announced length remain UNKNOWN',async()=>{
  const variants:{extra?:{url?:string;redirected?:boolean};headers?:Record<string,string>}[]=[{extra:{url:'https://example.invalid/rpc'}},{extra:{url:'https://api.privy.io/v1/wallets/synthetic-wallet/rpc?other=1'}},
    {extra:{redirected:true}},{headers:{'x-synthetic-header':'x'.repeat(8192)}},
    {headers:{'content-length':'65537'}},{headers:{'content-length':'00'}}];
  for(const variant of variants){const f=fixture();f.hooks.network=async(url)=>localResponse(url,'{}',403,variant.headers,variant.extra);
    const result=await f.provider.capture(f.call);assert.equal(result.attempt.status,'OUTCOME_UNKNOWN');assert.equal(result.walletRpcAttempts,1);assert.equal(f.responses.length,0);}
});

test('body bound is enforced on actual streamed bytes before private persistence',async()=>{
  for(const body of [JSON.stringify('x'.repeat(65535))]){
    const f=fixture();f.hooks.network=async(url)=>localResponse(url,body);const result=await f.provider.capture(f.call);
    assert.equal(result.attempt.status,'OUTCOME_UNKNOWN');assert.equal(f.responses.length,0);assert.equal(result.walletRpcAttempts,1);
  }
});

test('bounded non-JSON missing content type duplicate JSON and invalid UTF8 remain private unclassified captures',async()=>{
  for(const body of ['policy_violation','{"code":1,"code":2}','{"code":1,"co\\u0064e":2}',Uint8Array.from([0xff])]){
    const f=fixture();f.hooks.network=async(url)=>localResponse(url,body);const result=await f.provider.capture(f.call);
    assert.equal(result.attempt.status,'HTTP_CAPTURED');assert.equal(result.attempt.transactionHash,null);assert.equal(result.attempt.rawResponseStored,true);
    assert.equal(f.responses.length,1);assert.deepEqual(f.responses[0].body,typeof body==='string'?new TextEncoder().encode(body):body);
  }
  for(const mode of ['text/html','missing']){
    const f=fixture();f.hooks.network=async(url)=>{const response=localResponse(url,'policy_violation',403,{'content-type':mode});if(mode==='missing')response.headers.delete('content-type');return response;};
    const result=await f.provider.capture(f.call);assert.equal(result.attempt.status,'HTTP_CAPTURED');assert.equal(f.responses.length,1);
  }
});

test('ambiguous success JSON or unexpected success content type cannot establish a hash through SDK parsing',async()=>{
  const good=JSON.stringify({method:'eth_sendTransaction',data:{caip2:'eip155:10143',hash:h(8)}});
  for(const body of [good.replace('"method":','"method":"other","method":'),good.replace('"hash":',`"hash":"${h(9)}","hash":`)]){
    const f=fixture();f.hooks.network=async(url)=>localResponse(url,body,200);const result=await f.provider.capture(f.call);
    assert.equal(result.attempt.transactionHash,null);assert.equal(result.attempt.status,'OUTCOME_UNKNOWN');assert.equal(result.attempt.rawResponseStored,true);
  }
  const f=fixture();f.hooks.network=async(url)=>localResponse(url,good,200,{'content-type':'text/html'});
  assert.equal((await f.provider.capture(f.call)).attempt.transactionHash,null);
});

test('the 64 KiB boundary stores exact original bytes and only response headers privately',async()=>{
  const body=JSON.stringify('x'.repeat(65534)),f=fixture();assert.equal(Buffer.byteLength(body),65536);
  f.hooks.network=async(url)=>localResponse(url,body,403,{'x-synthetic-id':'synthetic-private-response-id'});
  const result=await f.provider.capture(f.call);assert.equal(result.attempt.status,'HTTP_CAPTURED');assert.equal(Buffer.from(f.responses[0].body).toString(),body);
  assert.ok(f.responses[0].headers.some(([name])=>name==='x-synthetic-id'));assert.ok(!JSON.stringify(result).includes('synthetic-private-response-id'));
});

test('valid same-chain success saves the hash before response persistence and SDK return',async()=>{
  const f=fixture({status:200,body:{method:'eth_sendTransaction',data:{caip2:'eip155:10143',hash:h(8),transaction_id:'synthetic-original-probe'}}});
  f.hooks.hash=()=>{const snapshot=f.provider.snapshot();assert.equal(snapshot.attempt!.transactionHash,h(8));assert.equal(snapshot.attempt!.transactionHashStored,false);assert.equal(snapshot.walletRpcAttempts,1);};
  const result=await f.provider.capture(f.call);assert.equal(result.attempt.status,'UNEXPECTED_BROADCAST');assert.equal(result.attempt.transactionHash,h(8));
  assert.equal(result.attempt.transactionHashStored,true);assert.equal(result.attempt.rawResponseStored,true);
  assert.deepEqual(f.events,['reserve','forward-post','hash','response']);assert.equal(f.sent.length,1);await assert.rejects(f.create().capture(f.call),fixedError);
});

test('response journal failure cannot discard a valid success hash or reopen its attempt',async()=>{
  const f=fixture({status:200,body:{method:'eth_sendTransaction',data:{caip2:'eip155:10143',hash:h(8)}}});
  f.hooks.response=()=>{throw Error('synthetic-private-write-error');};const result=await f.provider.capture(f.call);
  assert.equal(result.attempt.status,'UNEXPECTED_BROADCAST');assert.equal(result.attempt.transactionHash,h(8));assert.equal(result.attempt.transactionHashStored,true);
  assert.equal(result.attempt.rawResponseStored,false);assert.equal(result.attempt.httpStatus,200);assert.equal(f.sent.length,1);await assert.rejects(f.create().capture(f.call),fixedError);
});

test('hash journal failure retains the in-memory original hash without claiming durable hash storage',async()=>{
  const f=fixture({status:200,body:{method:'eth_sendTransaction',data:{caip2:'eip155:10143',hash:h(8)}}});
  f.hooks.hash=()=>{throw Error('synthetic-private-hash-write-error');};const result=await f.provider.capture(f.call);
  assert.equal(result.attempt.status,'UNEXPECTED_BROADCAST');assert.equal(result.attempt.transactionHash,h(8));assert.equal(result.attempt.transactionHashStored,false);
  assert.equal(result.attempt.rawResponseStored,true);assert.equal(f.events.filter(value=>value==='hash').length,1);
  const copy=f.provider.snapshot();assert.ok(Object.isFrozen(copy.attempt!.call.block));assert.throws(()=>{copy.attempt!.transactionHash=h(9);},TypeError);
  assert.equal(f.provider.snapshot().attempt!.transactionHash,h(8));await assert.rejects(f.create().capture(f.call),fixedError);
});

test('both journal write failures retain the hash locally and original reservation durably',async()=>{
  const f=fixture({status:200,body:{method:'eth_sendTransaction',data:{caip2:'eip155:10143',hash:h(8)}}});
  f.hooks.hash=()=>{throw Error('synthetic-hash-error');};f.hooks.response=()=>{throw Error('synthetic-response-error');};
  const result=await f.provider.capture(f.call);assert.equal(result.attempt.transactionHash,h(8));assert.equal(result.attempt.rawResponseStored,false);
  assert.equal(result.attempt.transactionHashStored,false);assert.equal(f.stored()!.status,'RESERVED');await assert.rejects(f.create().capture(f.call),fixedError);
});

test('success bodies containing echoed credentials still retain the public hash without storing unsafe bytes',async()=>{
  const f=fixture();f.hooks.network=async(url)=>localResponse(url,JSON.stringify({method:'eth_sendTransaction',data:{caip2:'eip155:10143',hash:h(8)},extra:f.config.appSecret}),200);
  const result=await f.provider.capture(f.call);assert.equal(result.attempt.status,'UNEXPECTED_BROADCAST');assert.equal(result.attempt.transactionHash,h(8));
  assert.equal(result.attempt.rawResponseStored,false);assert.equal(result.attempt.transactionHashStored,true);assert.equal(f.responses.length,0);
  assert.ok(!JSON.stringify(result).includes(f.config.appSecret));
});

test('echoed authorization headers or decoded credential escapes are not written to the private response journal',async()=>{
  for(const mode of ['basic','signature','escaped','response-header']){
    const f=fixture();f.hooks.network=async(url,init)=>{
      const headers=new Headers(init.headers),secret=mode==='basic'?headers.get('authorization'):headers.get('privy-authorization-signature');
      return localResponse(url,mode==='escaped'?'"synthetic\\u002dapp-secret"':mode==='response-header'?'{}':JSON.stringify({echo:secret}),403,
        mode==='response-header'?{'privy-authorization-signature':secret!}:{});
    };
    const result=await f.provider.capture(f.call);assert.equal(result.attempt.status,'OUTCOME_UNKNOWN');assert.equal(result.attempt.rawResponseStored,false);assert.equal(f.responses.length,0);
  }
});

test('wrong-chain malformed success and errors carrying a hash never claim an unexpected broadcast',async()=>{
  for(const [status,body] of [[200,{method:'eth_sendTransaction',data:{caip2:'eip155:1',hash:h(8)}}],
    [200,{method:'eth_sendTransaction',data:null}],[200,{method:'eth_sendTransaction',data:{caip2:'eip155:10143',hash:'0xbad'}}],
    [403,{method:'eth_sendTransaction',data:{caip2:'eip155:10143',hash:h(8)}}]] as const){
    const f=fixture({status,body}),result=await f.provider.capture(f.call);assert.equal(result.attempt.transactionHash,null);
    assert.equal(result.attempt.status,status===403?'HTTP_CAPTURED':'OUTCOME_UNKNOWN');assert.equal(result.walletRpcAttempts,1);
  }
});

test('response metadata mutation during body read does not change the recorded status or headers',async()=>{
  const f=fixture();f.hooks.network=async(url)=>{
    let response!:Response;const stream=new ReadableStream<Uint8Array>({async pull(controller){
      await new Promise(resolve=>setImmediate(resolve));
      Object.defineProperty(response,'status',{value:200});response.headers.set('x-later','synthetic-mutated');
      controller.enqueue(new TextEncoder().encode('{"code":"policy_violation"}'));controller.close();
    }});
    response=new Response(stream,{status:403,headers:{'content-type':'application/json'}});Object.defineProperty(response,'url',{value:url});return response;
  };
  const result=await f.provider.capture(f.call);assert.equal(result.attempt.httpStatus,403);assert.equal(result.attempt.status,'HTTP_CAPTURED');
  assert.ok(f.responses[0].headers.every(([name])=>name!=='x-later'));
});

test('reservation and unknown-write errors expose fixed codes or safe snapshots without losing the once lock',async()=>{
  const f=fixture();f.journal.reserve=()=>{throw Error('synthetic-private-reserve');};
  const provider=f.create();await assert.rejects(provider.capture(f.call),fixedError);await assert.rejects(provider.capture(f.call),fixedError);assert.equal(f.sent.length,0);
  assert.deepEqual(provider.snapshot(),{attempt:null,walletRpcAttempts:0,priorAttempt:true});
  const g=fixture();g.hooks.network=async()=>{throw Error('synthetic-network-error');};g.hooks.unknown=()=>{throw Error('synthetic-private-unknown');};
  const result=await g.provider.capture(g.call);assert.equal(result.attempt.status,'OUTCOME_UNKNOWN');assert.equal(g.stored()!.status,'RESERVED');await assert.rejects(g.create().capture(g.call),fixedError);
});

test('unavailable initial and recovery history cannot imply the original key was never broadcast',async()=>{
  const f=fixture();let reads=0;f.journal.get=()=>{reads++;throw Error('synthetic-private-unavailable-history');};
  const provider=f.create();await assert.rejects(provider.capture(f.call),fixedError);
  assert.equal(reads,2);assert.deepEqual(provider.snapshot(),{attempt:null,walletRpcAttempts:0,priorAttempt:true});
  assert.equal(f.sent.length,0);assert.equal(f.stored(),null);
});

test('known sensitive configuration identifiers are rejected before SDK construction or any request',()=>{
  const f=fixture();assert.throws(()=>day4PolicyProbeProvider({...f.config,walletId:f.config.appSecret},f.ids,f.journal,f.fetchOptions),fixedError);
  assert.throws(()=>day4PolicyProbeProvider(f.config,{...f.ids,funding:f.config.appSecret},f.journal,f.fetchOptions),fixedError);assert.equal(f.sent.length,0);
});
