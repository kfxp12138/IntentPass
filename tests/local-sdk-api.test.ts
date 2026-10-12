import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../apps/web/src/server.js';
import {configuredLocalSdkApi} from '../apps/web/src/local-sdk-api.js';
import {runLocalSdkRead} from '../apps/web/src/local-sdk-runner.js';
import {AuthenticationRejected} from '../packages/adapters/src/privy-auth.js';
import {originalAuthorizationFixture} from './support/original-authorization.js';
import {runExample} from '../examples/client/client.js';
import {checkOrderSnapshotContinuation} from '../apps/web/src/order-view.js';

test('local bridge runs the real independent Node SDK with stdin-only authentication and three read requests, preserving order ACL',async()=>{
  const f=await originalAuthorizationFixture('10143'),token='LOCAL_SYNTHETIC_SESSION',observed:string[]=[],auth={authenticate:async(t:string)=>{
    if(![token,'other'].includes(t))throw new AuthenticationRejected();return {subject:t===token?'original-owner':'other-owner',wallets:[t===token?f.buyer.address:f.deployment.committee[0]] as `0x${string}`[]};}};
  const browser={auth,configuration:{privyAppId:'local-test-app',meraRpId:null,recoveryDeployment:null}},api=configuredLocalSdkApi({INTENTPASS_LOCAL_SDK_READ_ENABLED:'1'},browser)!;
  const app=await createApp({dependencyPrebundling:false,browserApi:browser,orderApi:{auth,read:async()=>f.snapshot('ALLOCATED_PAID')},localSdkApi:api});
  app.server.on('request',(req)=>observed.push(`${req.method} ${req.url}`));await new Promise<void>(r=>app.server.listen(0,'127.0.0.1',r));const bound=app.server.address();assert.ok(bound&&typeof bound==='object');
  const call=(body:unknown,t=token)=>fetch(`http://127.0.0.1:${bound.port}/api/local/sdk-order-read`,{method:'POST',headers:{Authorization:`Bearer ${t}`,'Content-Type':'application/json',Host:'untrusted.invalid'},body:JSON.stringify(body)});
  try{
    assert.equal((await call({orderId:f.payload.intent.orderId},'invalid')).status,401);
    const result=await call({orderId:f.payload.intent.orderId});assert.equal(result.status,200);const value=await result.json();assert.equal(value.status,'AUTHENTICATED_ORDER_READ');assert.equal(value.order.orderId,f.payload.intent.orderId);assert.equal(value.transactionsSent,0);assert.equal(JSON.stringify(value).includes(token),false);assert.equal(JSON.stringify(value).includes('original-owner'),false);
    assert.equal(observed.filter(s=>s==='GET /api/session').length,2);assert.equal(observed.filter(s=>s.startsWith('GET /api/orders/')).length,1);assert.ok(!observed.some(s=>/submit|review|propose/.test(s)));
    assert.equal((await call({orderId:f.payload.intent.orderId},'other')).status,503);
    const before=observed.length;const invalid=await(await call({orderId:f.payload.intent.orderId,command:'submit',url:'https://untrusted.invalid'})).json();assert.equal(invalid.code,'LOCAL_SDK_REQUEST_INVALID');assert.equal(observed.length,before+1);assert.equal(api.active.size,0);
  }finally{await app.close();}
});
test('local child configuration is disabled by default and under a public origin, and a subject change cannot produce a verified response',async()=>{
  const browser={auth:{authenticate:async()=>({subject:'local-owner',wallets:[]})},configuration:{privyAppId:'local-test-app',meraRpId:null,recoveryDeployment:null}};
  assert.equal(configuredLocalSdkApi({},browser),undefined);assert.equal(configuredLocalSdkApi({INTENTPASS_LOCAL_SDK_READ_ENABLED:'1',PUBLIC_HTTPS_URL:'https://example.test'},browser),undefined);
  await assert.rejects(runLocalSdkRead({orderId:'0x'+'11'.repeat(32),token:'local-test',expectedSubject:'owner',port:0}),/LOCAL_SDK_ORIGIN_INVALID/);
  const f=await originalAuthorizationFixture('10143'),out:unknown[]=[],errors:string[]=[],response=(value:unknown)=>new Response(JSON.stringify(value)),transport:typeof fetch=async(url)=>String(url).endsWith('/api/session')?response({subject:'different-subject',wallets:[f.buyer.address]}):response(f.snapshot('FUNDED'));
  const code=await runExample(['check-order','--local-session-input'],{}, {input:async()=>({orderId:f.payload.intent.orderId,token:'local-private-token',expectedSubject:'original-subject'}),out:v=>out.push(v),error:c=>errors.push(c),transport});
  assert.equal(code,1);assert.deepEqual(out,[]);assert.deepEqual(errors,['AUTHORIZATION_SESSION_CHANGED']);
  assert.equal(await runExample(['submit','--local-session-input','--confirm'],{}, {input:async()=>{throw Error('MUST_NOT_READ_PRIVATE_INPUT');},out:()=>assert.fail(),error:()=>{}}),1);
});
test('adopting a read snapshot cannot switch original financial anchors, accept stale blocks or regress a terminal order',async()=>{
  const f=await originalAuthorizationFixture('10143'),anchor=f.snapshot('ALLOCATED_PAID');
  assert.equal(checkOrderSnapshotContinuation(anchor,{...anchor,block:{...anchor.block,number:'101'}}).state,'ALLOCATED_PAID');
  for(const current of [{...anchor,orderId:f.payload.intent.taskId as `0x${string}`},{...anchor,price:'11'},{...anchor,payee:f.buyer.address},{...anchor,block:{...anchor.block,number:'99'}},{...anchor,block:{...anchor.block,hash:f.payload.intent.taskId as `0x${string}`}},{...anchor,state:'FUNDED' as const}])assert.throws(()=>checkOrderSnapshotContinuation(anchor,current));
});
