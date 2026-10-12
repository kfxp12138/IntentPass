import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../apps/web/src/server.js';
import { integrationStatus } from '../packages/adapters/src/status.js';
test('presence of config never implies real integration PASS',()=>{
  assert.ok(integrationStatus({TYPESAFE_API_KEY:'not-a-real-key',JEV_MODEL:'fixture'}).every(x=>x.status==='BLOCKED'));
});
test('health is live but not ready; API refuses all financial actions',async()=>{
  const app=await createApp({dependencyPrebundling:false}); await new Promise<void>(r=>app.server.listen(0,'127.0.0.1',r));
  const address=app.server.address(); assert.ok(address && typeof address!=='string');
  const url=`http://127.0.0.1:${address.port}`;
  try {
    const response=await fetch(url+'/health'); assert.equal(response.status,200);
    const health=await response.json(); assert.equal(health.ready,false); assert.equal(health.liveness,'OK');
    assert.ok(health.integrations.every((x:{status:string})=>x.status==='BLOCKED'));
    assert.equal((await fetch(url+'/health',{method:'POST'})).status,405);
    for(const path of ['intent/propose','intent/review','orders/prepare','orders/submit','capsules/any']) {
      const response=await fetch(url+'/api/'+path,{method:'POST'}); assert.equal(response.status,503);
      assert.equal((await response.json()).code,'AUTH_CONFIGURATION_REQUIRED');
    }
    assert.match(await (await fetch(url+'/')).text(),/IntentPass/);
  } finally {await app.close();}
});
test('order API requires authenticated linked wallet; denies strangers and sanitizes provider failures',async()=>{
  const {AuthenticationRejected}=await import('../packages/adapters/src/privy-auth.js');
  const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as `0x${string}`,a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as `0x${string}`;
  const snapshot:import('../packages/protocol/src/escrow-read.js').OrderSnapshot={chainId:'10143',arbiter:a(9),asset:a(8),orderId:h(1),contextHash:h(2),buyer:a(1),seller:a(2),payee:a(2),price:'10',bond:'5',deliveryDeadline:'100',settlementDeadline:'200',datasetHash:h(3),serviceTermsHash:h(4),evidenceHash:h(5),voteMask:3,state:'CERTIFIED',credits:{buyer:'0',payee:'0'},withdrawn:{buyer:'0',payee:'0'},accounting:{locked:'15',outstanding:'0',balance:'15'},block:{number:'10',hash:h(10),timestamp:'50'}};
  let reads=0,fail=false;
  const app=await createApp({dependencyPrebundling:false,orderApi:{auth:{authenticate:async token=>{if(token==='invalid')throw new AuthenticationRejected();return {subject:'local-test-user',wallets:[token==='buyer'?a(1):token==='seller'?a(2):a(3)]};}},read:async()=>{reads++;if(fail)throw new Error('secret rpc URL must not leak');return snapshot;}}});
  await new Promise<void>(r=>app.server.listen(0,'127.0.0.1',r));const addr=app.server.address();assert.ok(addr&&typeof addr!=='string');const url=`http://127.0.0.1:${addr.port}/api/orders/${h(1)}`;
  const get=(token:string)=>fetch(url,{headers:{authorization:`Bearer ${token}`}});
  try {
    assert.equal((await fetch(url)).status,401);assert.equal((await get('invalid')).status,401);assert.equal(reads,0);
    assert.equal((await get('stranger')).status,403);
    for(const token of ['buyer','seller']){const response=await get(token);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),snapshot);}
    assert.equal((await fetch(url,{method:'POST',headers:{authorization:'Bearer buyer'}})).status,405);
    assert.equal((await fetch(url.replace(h(1),'invalid'),{headers:{authorization:'Bearer buyer'}})).status,400);
    fail=true;const response=await get('buyer');assert.equal(response.status,503);assert.deepEqual(await response.json(),{code:'ORDER_SERVICE_UNAVAILABLE'});
  }finally{await app.close();}
});
test('review HTTP authenticates before parsing and bounds JSON; principal comes from verified session',async()=>{
  const {AuthenticationRejected}=await import('../packages/adapters/src/privy-auth.js');let reviews=0;
  const app=await createApp({dependencyPrebundling:false,reviewApi:{auth:{authenticate:async token=>{if(token!=='valid')throw new AuthenticationRejected();return {subject:'verified-user',wallets:[]};}},service:{review:async(_input:unknown,principal:{subject:string})=>{assert.equal(principal.subject,'verified-user');reviews++;return {decision:'ABSTAIN',code:'LOCAL_HTTP_TEST_ONLY'};}} as unknown as import('../apps/web/src/services/review.js').ReviewService}});
  await new Promise<void>(r=>app.server.listen(0,'127.0.0.1',r));const addr=app.server.address();assert.ok(addr&&typeof addr!=='string');const url=`http://127.0.0.1:${addr.port}/api/intent/review`;
  const post=(body:string,token='valid',contentType='application/json')=>fetch(url,{method:'POST',headers:{authorization:`Bearer ${token}`,'Content-Type':contentType},body});
  try {
    assert.equal((await fetch(url)).status,405);assert.equal((await post('{}','invalid')).status,401);assert.equal((await post('{}','valid','text/plain')).status,415);assert.equal((await post('{')).status,400);assert.equal((await post(JSON.stringify({text:'x'.repeat(1048577)}))).status,413);assert.equal(reviews,0);
    const response=await post(JSON.stringify({buyer:'caller-claim'}));assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).decision,'ABSTAIN');assert.equal(reviews,1);
  }finally{await app.close();}
});
test('proposal HTTP uses authenticated principal and returns an unsigned draft only',async()=>{
  const app=await createApp({dependencyPrebundling:false,proposeApi:{auth:{authenticate:async()=>({subject:'verified-user',wallets:[]})},service:{propose:async(input:unknown,principal:{subject:string})=>{assert.equal(principal.subject,'verified-user');assert.deepEqual(input,{quoteRefs:['catalog-ref']});return {status:'DRAFT',citations:['provided-id']};}} as unknown as import('../apps/web/src/services/propose.js').ProposalService}});
  await new Promise<void>(r=>app.server.listen(0,'127.0.0.1',r));const addr=app.server.address();assert.ok(addr&&typeof addr!=='string');const url=`http://127.0.0.1:${addr.port}/api/intent/propose`;
  try{assert.equal((await fetch(url)).status,405);assert.equal((await fetch(url,{method:'POST'})).status,401);const response=await fetch(url,{method:'POST',headers:{authorization:'Bearer local-fixture','Content-Type':'application/json'},body:JSON.stringify({quoteRefs:['catalog-ref']})});assert.equal(response.status,200);assert.deepEqual(await response.json(),{status:'DRAFT',citations:['provided-id']});}finally{await app.close();}
});
