import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type {PublicClient} from 'viem';
import {PurchasePreflightReader,PreflightSnapshotSchema} from '../packages/protocol/src/purchase-preflight.js';
import {contextHash} from '../packages/protocol/src/index.js';
import {preparationHash,ALLOCATION_POLICY,RELEASE_POLICY,DELIVERY_SCHEMA,ZERO_HASH} from '../packages/protocol/src/escrow.js';
import {PurchaseClient} from '../packages/protocol/src/purchase-client.js';
import {createApp} from '../apps/web/src/server.js';
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as `0x${string}`,a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as `0x${string}`;
// Explicit read-port double. No network, official CVA/CVI, or real-chain claims.
function harness(){
  const base=JSON.parse(readFileSync('fixtures/dev/hash-vector.json','utf8')).envelope;
  const intent={...base,price:'10',bond:'5',allocationPolicyHash:ALLOCATION_POLICY,intentReleasePolicyHash:RELEASE_POLICY,deliverySchemaHash:DELIVERY_SCHEMA,pactPaymentPublicKeyHash:ZERO_HASH};
  const deployment={chainId:intent.chainId,arbiter:intent.arbiter,asset:intent.asset,gate:a(87),reviewer:intent.reviewer,committeeHash:intent.committeeHash};
  const grant={schemaVersion:1,owner:intent.buyer,executor:a(77),chainId:intent.chainId,arbiter:intent.arbiter,orderId:intent.orderId,asset:intent.asset,amount:'15',contextHash:contextHash(intent),preparationHash:preparationHash(contextHash(intent),intent.committeeHash),receiptHash:h(44),nonce:'7',deadline:'1500',maxUses:1};
  const calls:any[]=[],state={orderState:0,consumed:false,revoked:false,eligible:true,balance:100n,allowance:15n,timestamp:1000n,changedBlock:false,chainId:Number(intent.chainId),asset:deployment.asset,escrowBalance:15n,fail:false};
  const client={getChainId:async()=>state.chainId,getBlock:async(input:any)=>({number:100n,hash:input.blockNumber!==undefined&&state.changedBlock?h(2):h(1),timestamp:state.timestamp}),readContract:async(input:any)=>{
    calls.push(input);if(state.fail)throw new Error('private RPC credential');
    switch(input.functionName){case 'asset':return state.asset;case 'eligibility':return deployment.gate;case 'reviewer':return deployment.reviewer;case 'committeeHash':return deployment.committeeHash;
      case 'orders':return [h(0),a(0),a(0),a(0),0n,0n,0n,0n,h(0),h(0),h(0),0,state.orderState];case 'consumed':return state.consumed;case 'revoked':return state.revoked;
      case 'balanceOf':return input.args[0]===deployment.arbiter?state.escrowBalance:state.balance;case 'allowance':return state.allowance;case 'canTransfer':return state.eligible;case 'locked':return 10n;case 'outstanding':return 5n;default:throw new Error('unexpected call');}
  }} as unknown as PublicClient;
  const reader=new PurchasePreflightReader(client,deployment,grant.executor);
  return {intent,grant,input:{intent,grant},deployment,state,calls,reader,client};
}
test('purchase preflight binds exact funding and reads immutable configuration and all observations at one finalized block',async()=>{
  const x=harness(),snapshot=await x.reader.read(x.input);assert.deepEqual(snapshot.blockers,[]);assert.equal(snapshot.canSubmitPayment,false);assert.equal(snapshot.block.finality,'finalized');assert.equal(snapshot.nonce,'7');
  assert.equal(x.calls.length,13);assert.ok(x.calls.every(c=>c.blockNumber===100n));
  const gate=x.calls.find(c=>c.functionName==='canTransfer');assert.deepEqual(gate.args,[x.intent.asset,x.intent.buyer,x.intent.arbiter,15n,contextHash(x.intent)]);
  const allowance=x.calls.find(c=>c.functionName==='allowance');assert.deepEqual(allowance.args,[x.intent.buyer,x.intent.arbiter]);
  for(const method of ['consumed','revoked'])assert.deepEqual(x.calls.find(c=>c.functionName===method).args,[x.intent.buyer,7n]);
});
test('purchase preflight reports registration, consumed or revoked nonce, eligibility, balance, expiry and exact allowance independently',async()=>{
  const x=harness();Object.assign(x.state,{orderState:1,consumed:true,revoked:true,eligible:false,balance:14n,allowance:0n,timestamp:1500n});
  assert.deepEqual((await x.reader.read(x.input)).blockers,['ORDER_ALREADY_REGISTERED','NONCE_CONSUMED','NONCE_REVOKED','AUTHORIZATION_EXPIRED','BUYER_INELIGIBLE','INSUFFICIENT_BALANCE','EXACT_ALLOWANCE_REQUIRED']);
  x.state.allowance=2n**256n-1n;assert.ok((await x.reader.read(x.input)).blockers.includes('EXACT_ALLOWANCE_REQUIRED'));
  x.state.allowance=15n;assert.ok(!(await x.reader.read(x.input)).blockers.includes('EXACT_ALLOWANCE_REQUIRED'));
});
test('purchase preflight rejects substituted permission before RPC and chain drift, insolvency or RPC failure instead of fabricating readiness',async()=>{
  const x=harness();for(const changes of [{amount:'14'},{owner:a(25)},{executor:a(25)},{chainId:'1'},{contextHash:h(25)},{preparationHash:h(25)},{orderId:h(25)}])await assert.rejects(x.reader.read({...x.input,grant:{...x.grant,...changes}}));
  assert.equal(x.calls.length,0);
  x.state.chainId=1;await assert.rejects(x.reader.read(x.input),/CHAIN_MISMATCH/);x.state.chainId=Number(x.intent.chainId);
  x.state.asset=a(25);await assert.rejects(x.reader.read(x.input),/DEPLOYMENT_MISMATCH/);x.state.asset=x.deployment.asset;
  x.state.changedBlock=true;await assert.rejects(x.reader.read(x.input),/CHAIN_SNAPSHOT_CHANGED/);x.state.changedBlock=false;
  x.state.escrowBalance=14n;await assert.rejects(x.reader.read(x.input),/ESCROW_INSOLVENT/);x.state.escrowBalance=15n;
  x.state.fail=true;await assert.rejects(x.reader.read(x.input));
  assert.throws(()=>new PurchasePreflightReader(x.client,{...x.deployment,gate:a(0)},x.grant.executor));
});
test('authenticated preflight HTTP and SDK reject another owner before chain reads and sanitize provider failure',async()=>{
  const x=harness();let reads=0;const auth={authenticate:async()=>({subject:'local-owner',wallets:[x.intent.buyer]})};
  const app=await createApp({dependencyPrebundling:false,preflightApi:{auth,read:async input=>{reads++;return x.reader.read(input);}}});
  await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));const addr=app.server.address();assert.ok(addr&&typeof addr!=='string');const base=`http://127.0.0.1:${addr.port}`,client=new PurchaseClient(base,async()=>'local-token');
  try{
    assert.equal((await fetch(base+'/api/intent/preflight',{method:'POST',body:'bad'})).status,401);assert.equal(reads,0);
    assert.deepEqual(await client.preflight({...x.input,intent:{...x.intent,buyer:a(25)}}),{status:'REJECT',code:'OWNER_MISMATCH'});assert.equal(reads,0);
    const result=await client.preflight(x.input);assert.ok(!('status'in result));assert.equal(result.orderId,x.intent.orderId);assert.equal(result.canSubmitPayment,false);assert.equal(reads,1);
    x.state.fail=true;const failed=await fetch(base+'/api/intent/preflight',{method:'POST',headers:{Authorization:'Bearer local-token','Content-Type':'application/json'},body:JSON.stringify(x.input)});assert.equal(failed.status,503);assert.equal(failed.headers.get('cache-control'),'no-store');assert.deepEqual(await failed.json(),{code:'PREFLIGHT_SERVICE_UNAVAILABLE'});
  }finally{await app.close();}
});
test('preflight SDK matches response anchors and never retries a failed read',async()=>{
  const x=harness(),snapshot=await x.reader.read(x.input);let calls=0;
  const client=new PurchaseClient('https://intentpass.example',async()=>'local-token',async(_url,init)=>{calls++;assert.equal(init?.redirect,'error');assert.equal(init?.cache,'no-store');return new Response(JSON.stringify({...snapshot,nonce:'8'}));});
  await assert.rejects(client.preflight(x.input),/PREFLIGHT_RESPONSE_MISMATCH/);assert.equal(calls,1);
  const failed=new PurchaseClient('https://intentpass.example',async()=>'local-token',async()=>{calls++;throw new Error('connection lost');});await assert.rejects(failed.preflight(x.input));assert.equal(calls,2);
  assert.throws(()=>PreflightSnapshotSchema.parse({...snapshot,canSubmitPayment:true}));
  assert.throws(()=>PreflightSnapshotSchema.parse({...snapshot,consumed:true,blockers:[]}));
  const latest=new PurchaseClient('https://intentpass.example',async()=>'local-token',async()=>new Response(JSON.stringify({...snapshot,block:{...snapshot.block,finality:'latest'}})));await assert.rejects(latest.preflight(x.input),/PREFLIGHT_FINALITY_REQUIRED/);
});
