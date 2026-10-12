import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../apps/web/src/server.js';
import {configuredOrderApi} from '../apps/web/src/configured-order-api.js';
import {AuthenticationRejected} from '../packages/adapters/src/privy-auth.js';
import {IntentPassClient,verifyOriginalOrderReadProof,checkOriginalOrderReadSnapshot,grantTypedData,contextHash,committeeHash} from '../packages/protocol/src/index.js';
import {originalOrderReadProof,recoverAuthorization} from '../packages/capsule/src/recovery.js';
import {originalAuthorizationFixture,readTestAddress as a,readTestHash as h} from './support/original-authorization.js';
import type {OrderState} from '../packages/protocol/src/escrow-read.js';

async function httpFixture(){
  const x=await originalAuthorizationFixture();let reads=0,fail=false,malformed=false,state:OrderState='UNREGISTERED';
  const app=await createApp({dependencyPrebundling:false,orderApi:{deployment:x.deployment,auth:{authenticate:async token=>{if(token==='invalid')throw new AuthenticationRejected();return {subject:'local-read-user',wallets:[token==='buyer'?x.buyer.address:token==='stranger'?a(55):x.seller.address]};}},read:async id=>{reads++;assert.equal(id,x.payload.intent.orderId);if(fail)throw new Error('PRIVATE_PROVIDER_ERROR_MUST_NOT_LEAK');const order=x.snapshot(state);return malformed?{...order,buyer:a(55)}:order;}}});
  await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));const address=app.server.address();assert.ok(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`,path=`/api/orders/${x.payload.intent.orderId}/read-original`,proof=originalOrderReadProof(x.payload);
  const post=(body=JSON.stringify(proof),token='buyer',target=path,contentType='application/json')=>fetch(base+target,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':contentType},body});
  return {...x,base,path,proof,post,reads:()=>reads,setState:(value:OrderState)=>{state=value;},badSnapshot:()=>{malformed=true;},fail:()=>{fail=true;},close:()=>app.close()};
}
test('historical original read binds fixed deployment complete intent and signed Grant while excluding private recovery material',async()=>{
  const x=await originalAuthorizationFixture(),proof=originalOrderReadProof(x.payload);
  assert.deepEqual(Object.keys(proof).sort(),['grant','intent','ownerSignature']);assert.ok(!JSON.stringify(proof).includes('LOCAL PRIVATE'));assert.ok(BigInt(proof.grant.deadline)<BigInt(Math.floor(Date.now()/1000)));assert.deepEqual(await verifyOriginalOrderReadProof(proof,x.deployment),proof);
  for(const changed of [{...proof,intent:{...proof.intent,payee:a(55)}},{...proof,intent:{...proof.intent,purchaseEvidenceCommitment:h(55)}},{...proof,ownerSignature:'0x'+'0'.repeat(130)},{...proof,evidence:x.payload.evidence},{...proof,keyReference:{rpId:'localhost',credentialId:'AQ'}}])await assert.rejects(verifyOriginalOrderReadProof(changed,x.deployment));
  for(const change of [{chainId:'1'},{arbiter:a(55)},{asset:a(55)},{reviewer:a(55)},{executor:a(55)},{committee:[a(1),a(2),a(55)] as [string,string,string]}])await assert.rejects(verifyOriginalOrderReadProof(proof,{...x.deployment,...change}));
  for(const change of [{amount:'14'},{owner:x.seller.address},{executor:a(55)},{orderId:h(55)},{asset:a(55)},{contextHash:h(55)},{preparationHash:h(55)},{receiptHash:h(0)},{deadline:'2001'}]){const grant={...proof.grant,...change};const signed={...proof,grant,ownerSignature:await x.buyer.signTypedData(grantTypedData(grant))};await assert.rejects(verifyOriginalOrderReadProof(signed,x.deployment),/ORDER_READ_PROOF_INVALID/);}
});
test('authenticated actual HTTP returns canonical unregistered or funded original state without changing ordinary GET ACL or payment capability',async()=>{
  const f=await httpFixture(),client=new IntentPassClient(f.base,'buyer');
  try{const ordinary=await fetch(f.base+`/api/orders/${f.payload.intent.orderId}`,{headers:{Authorization:'Bearer buyer'}});assert.equal(ordinary.status,404);
    for(const state of ['UNREGISTERED','FUNDED','CERTIFIED','ALLOCATED_PAID'] as const){f.setState(state);const order=await client.originalOrder(f.proof,f.deployment);assert.equal(order.state,state);const result=await recoverAuthorization(f.payload,[f.buyer.address],f.deployment,{read:id=>{assert.equal(id,f.payload.intent.orderId);return client.originalOrder(f.proof,f.deployment);}});assert.equal(result.canSubmitPayment,false);assert.equal(result.continuation,state==='UNREGISTERED'?'NOT_FUNDED':state==='ALLOCATED_PAID'?'VIEW_ALLOCATION':'CONTINUE_ORIGINAL_ORDER');}
    assert.equal((await fetch(f.base+`/api/orders/${f.payload.intent.orderId}`,{headers:{Authorization:'Bearer stranger'}})).status,403);
    const response=await f.post();assert.equal(response.headers.get('cache-control'),'no-store');f.badSnapshot();const invalid=await f.post();assert.equal(invalid.status,503);assert.deepEqual(await invalid.json(),{code:'ORDER_SERVICE_UNAVAILABLE'});f.fail();const failed=await f.post();assert.equal(failed.status,503);assert.deepEqual(await failed.json(),{code:'ORDER_SERVICE_UNAVAILABLE'});assert.equal(f.reads(),13);
  }finally{await f.close();}
});
test('original read authenticates and rejects wrong wallet path signature full payload and oversized input before any chain request',async()=>{
  const f=await httpFixture();
  try{assert.equal((await fetch(f.base+f.path,{method:'POST'})).status,401);assert.equal((await f.post('{}','invalid')).status,401);assert.equal((await fetch(f.base+f.path)).status,405);assert.equal((await f.post('{}','buyer',f.path,'text/plain')).status,415);assert.equal((await f.post('{')).status,400);assert.equal((await f.post(JSON.stringify({padding:'x'.repeat(16385)}))).status,413);
    for(const [body,token,path,code] of [[JSON.stringify(f.proof),'seller',f.path,'ORDER_ACCESS_DENIED'],[JSON.stringify(f.proof),'buyer',`/api/orders/${h(55)}/read-original`,'ORDER_ID_MISMATCH'],[JSON.stringify(f.proof),'buyer','/api/orders/invalid/read-original','ORDER_ID_INVALID'],[JSON.stringify({...f.proof,ownerSignature:'0x'+'0'.repeat(130)}),'buyer',f.path,'ORDER_READ_PROOF_INVALID'],[JSON.stringify(f.payload),'buyer',f.path,'ORDER_READ_PROOF_INVALID']] as const){const response=await f.post(body,token,path);assert.equal(response.status,200);assert.deepEqual(await response.json(),{status:'REJECT',code});}
    assert.equal(f.reads(),0);
  }finally{await f.close();}
});
test('SDK independently rejects bad original responses and transport failures without treating 404 as unregistered',async()=>{
  const x=await originalAuthorizationFixture(),proof=originalOrderReadProof(x.payload),empty=x.snapshot('UNREGISTERED');let calls=0;
  const client=(response:()=>Response)=>new IntentPassClient('https://local-read.example','local-token',async(url,init)=>{calls++;assert.ok(String(url).endsWith('/read-original'));assert.equal(init?.method,'POST');assert.deepEqual(JSON.parse(String(init?.body)),proof);assert.ok(!String(init?.body).includes('LOCAL PRIVATE'));return response();});
  await assert.rejects(client(()=>new Response(JSON.stringify(empty))).originalOrder({...proof,ownerSignature:'0x'+'0'.repeat(130)},x.deployment));assert.equal(calls,0);
  for(const snapshot of [{...empty,chainId:'1'},{...empty,orderId:h(55)},{...empty,buyer:x.buyer.address},{...empty,contextHash:contextHash(x.payload.intent)},{...empty,credits:{buyer:'1',payee:'0'}},{...empty,voteMask:1},{...empty,price:'10'},{...x.snapshot('FUNDED'),payee:a(55)},{...x.snapshot('FUNDED'),accounting:{locked:'15',outstanding:'0',balance:'14'}}]){await assert.rejects(client(()=>new Response(JSON.stringify(snapshot))).originalOrder(proof,x.deployment),/ORDER_READ_RESPONSE_MISMATCH/);await assert.rejects(recoverAuthorization(x.payload,[x.buyer.address],x.deployment,{read:async()=>snapshot}),/RECOVERY_CHAIN_MISMATCH/);}
  await assert.rejects(client(()=>new Response('{}',{status:404})).originalOrder(proof,x.deployment),/HTTP_404/);await assert.rejects(client(()=>new Response('x'.repeat(65537))).originalOrder(proof,x.deployment),/ORDER_READ_RESPONSE_TOO_LARGE/);await assert.rejects(client(()=>new Response(new Uint8Array([0xff]))).originalOrder(proof,x.deployment));await assert.rejects(client(()=>new Response(JSON.stringify({status:'REJECT',code:'ORDER_ACCESS_DENIED'}))).originalOrder(proof,x.deployment),/ORDER_ACCESS_DENIED/);assert.deepEqual(checkOriginalOrderReadSnapshot(proof,empty),empty);const otherOrders={...empty,accounting:{locked:'30',outstanding:'20',balance:'50'}};assert.deepEqual(checkOriginalOrderReadSnapshot(proof,otherOrders),otherOrders);
});
test('configured original read shares the fixed finalized reader and requires an explicit executor without weakening ordinary read',async()=>{
  const x=await originalAuthorizationFixture(),env={PRIVY_APP_ID:'local-app',PRIVY_APP_SECRET:'local-not-a-real-secret',MONAD_RPC_URL:'http://127.0.0.1:1',CHAIN_ID:x.deployment.chainId,ARBITER_ADDRESS:x.deployment.arbiter,CVA_ADDRESS:x.deployment.asset,ELIGIBILITY_GATE_ADDRESS:a(56),REVIEWER_ADDRESS:x.deployment.reviewer,COMMITTEE_ADDRESSES:x.deployment.committee.join(',')};
  assert.equal(configuredOrderApi({}),undefined);assert.equal(configuredOrderApi(env)?.deployment,undefined);assert.deepEqual(configuredOrderApi({...env,PRIVY_EXECUTOR_ADDRESS:x.deployment.executor})?.deployment,x.deployment);assert.throws(()=>configuredOrderApi({...env,PRIVY_EXECUTOR_ADDRESS:'invalid'}));assert.equal(committeeHash(x.deployment.committee),x.payload.intent.committeeHash);
  const app=await createApp({dependencyPrebundling:false,orderApi:{auth:{authenticate:async()=>({subject:'buyer',wallets:[x.buyer.address]})},read:async()=>x.snapshot('UNREGISTERED')}});await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));const address=app.server.address();assert.ok(address&&typeof address==='object');try{const response=await fetch(`http://127.0.0.1:${address.port}/api/orders/${x.payload.intent.orderId}/read-original`,{method:'POST'});assert.equal(response.status,503);assert.deepEqual(await response.json(),{code:'AUTH_CONFIGURATION_REQUIRED',status:'BLOCKED'});}finally{await app.close();}
});
