import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {encodeFunctionData,keccak256,type Hex,type PublicClient} from 'viem';
import {originalAuthorizationFixture,readTestHash as h,readTestAddress as a} from './support/original-authorization.js';
import {recordedBroadcast,checkBroadcastResult,type ProviderSubmission} from '../packages/protocol/src/provider-submission.js';
import {FundingRecordSchema,checkFundingResponse} from '../packages/protocol/src/funding-api.js';
import {AllocationRecordSchema,checkAllocationResponse} from '../packages/protocol/src/allocation-api.js';
import {fundingCalldata} from '../packages/protocol/src/funding.js';
import {allocationPlan} from '../packages/protocol/src/allocation.js';
import {escrowAbi} from '../packages/protocol/src/escrow-abi.js';
import {FundingStore} from '../packages/storage/src/funding-store.js';
import {SettlementStore} from '../packages/storage/src/settlement-store.js';
import {FundingWorker,type FundingPort} from '../apps/worker/src/funding.js';
import {SettlementWorker,type SettlementPort} from '../apps/worker/src/settlement.js';
import {viemSettlementPort} from '../apps/worker/src/viem-port.js';
import type {EscrowReader} from '../packages/protocol/src/escrow-read.js';
import type {OrderSnapshot} from '../packages/protocol/src/escrow-read.js';
import {createApp} from '../apps/web/src/server.js';
import {PurchaseClient} from '../packages/protocol/src/purchase-client.js';
import {BrowserSession,type BrowserAuthPort} from '../apps/web/src/browser-session.js';
import {OriginalFundingFlow} from '../apps/web/src/original-funding-flow.js';
import {AllocationFlow} from '../apps/web/src/allocation-flow.js';
import {originalAllocationPort} from '../apps/worker/src/original-allocation-port.js';
import type {AllocationReader} from '../packages/capsule/src/allocation-read.js';
import {createPrivyClient} from '../packages/adapters/src/privy-auth.js';

type Original=Awaited<ReturnType<typeof originalAuthorizationFixture>>;
function metadata(f:Original,data:Hex,id='Original-ID'):ProviderSubmission{return {provider:'PRIVY',scope:'SDK_SEND_RESPONSE_ASSOCIATION_NOT_FINALIZED_OR_POLICY_PROVENANCE',transactionId:id,walletId:'Original-wallet',chainId:f.deployment.chainId,from:f.deployment.executor,to:f.deployment.arbiter,calldataHash:keccak256(data)};}
function fundingRecord(f:Original){const g=f.payload.grant;return {key:`${g.chainId}:${g.arbiter.toLowerCase()}:${g.orderId.toLowerCase()}`,anchor:{chainId:g.chainId,arbiter:g.arbiter,asset:g.asset,owner:g.owner,executor:g.executor,orderId:g.orderId,contextHash:g.contextHash,nonce:g.nonce,amount:g.amount,calldataHash:keccak256(fundingCalldata(f.payload))},status:'SUBMITTED' as const,attempt:randomUUID(),hash:h(20),leaseUntil:null,providerSubmission:metadata(f,fundingCalldata(f.payload))};}
function allocationResponse(f:Original){const order={...f.snapshot('CERTIFIED'),credits:{buyer:'0',payee:'0'},block:{number:'100',hash:h(11),timestamp:'1000'}},plan=allocationPlan({payload:f.payload},order),g=f.payload.grant;
  return {record:{key:`${g.chainId}:${g.arbiter.toLowerCase()}:${g.orderId.toLowerCase()}`,order:{chainId:g.chainId,arbiter:g.arbiter,orderId:g.orderId,contextHash:g.contextHash,buyer:order.buyer,seller:order.seller,payee:order.payee},status:'SUBMITTED' as const,attempt:randomUUID(),action:'settle' as const,leaseUntil:null,txHash:h(21),error:null,providerSubmission:metadata(f,plan.data as Hex,'Settle-ID')},preparation:{kind:'ALLOCATION_PREPARED' as const,...plan,gates:[{beneficiary:order.buyer,amount:'5',eligible:true},{beneficiary:order.payee,amount:'10',eligible:true}],finality:'finalized' as const,chainId:g.chainId,executor:g.executor,target:g.arbiter,value:'0' as const,canExecute:false as const},receipt:null,canExecute:false as const};
}
function session(f:Original){const auth:BrowserAuthPort={initialize:async()=>{},sendCode:async()=>{},login:async()=>{},token:async()=>'local-token',logout:async()=>{}};return new BrowserSession(async()=>auth,async path=>new Response(JSON.stringify(path==='/api/config'?{privyAppId:'local-app',meraRpId:null,recoveryDeployment:f.deployment}:{subject:'owner',wallets:[f.buyer.address]})));}

test('installed SDK server factory fixes official origin despite an ambient override and rejects redirects',async()=>{
  const previousFetch=globalThis.fetch,previousEndpoint=process.env.PRIVY_API_BASE_URL;let calls=0,observedUrl='',redirect:RequestRedirect|undefined;
  process.env.PRIVY_API_BASE_URL='https://synthetic-override.invalid';globalThis.fetch=async(input,init)=>{calls++;observedUrl=input instanceof Request?input.url:String(input);redirect=init?.redirect;return new Response(JSON.stringify({id:'local-wallet'}),{headers:{'content-type':'application/json'}});};
  try{await createPrivyClient({appId:'local-app',appSecret:'synthetic-secret'}).wallets().get('local-wallet');assert.equal(observedUrl,'https://api.privy.io/v1/wallets/local-wallet');assert.equal(redirect,'error');assert.equal(calls,1);}finally{globalThis.fetch=previousFetch;if(previousEndpoint===undefined)delete process.env.PRIVY_API_BASE_URL;else process.env.PRIVY_API_BASE_URL=previousEndpoint;}
});

test('broadcast normalizer snapshots a strict SDK association and keeps legacy hashes metadata-free',async()=>{
  const f=await originalAuthorizationFixture(),input={hash:h(20),providerSubmission:metadata(f,fundingCalldata(f.payload))},held=recordedBroadcast(input);input.providerSubmission.transactionId='Changed';assert.equal(held.providerSubmission?.transactionId,'Original-ID');assert.ok(Object.isFrozen(held.providerSubmission));assert.equal(recordedBroadcast(h(20)).providerSubmission,null);
  for(const invalid of [{...input,extra:true},{...input,providerSubmission:{...input.providerSubmission,transactionId:'apikey_invalid'}},{hash:'bad',providerSubmission:null}])assert.throws(()=>recordedBroadcast(invalid),/SUBMISSION_OUTCOME_UNKNOWN/);
});
test('broadcast scope rejects another executor target network and calldata without relaxing metadata-free legacy',async()=>{
  const f=await originalAuthorizationFixture(),data=fundingCalldata(f.payload),expected={chainId:f.deployment.chainId,from:f.deployment.executor,to:f.deployment.arbiter,data},m=metadata(f,data);
  for(const altered of [{...m,from:a(44)},{...m,to:a(44)},{...m,chainId:'10143'},{...m,calldataHash:h(77)}])assert.throws(()=>checkBroadcastResult({hash:h(20),providerSubmission:altered},expected),/MISMATCH/);
  assert.equal(checkBroadcastResult(h(20),expected).providerSubmission,null);
});
test('funding strict response binds optional provider metadata to the original attempt and signed anchors',async()=>{
  const f=await originalAuthorizationFixture(),record=fundingRecord(f);const checked=checkFundingResponse(f.payload,{record,canSubmitPayment:false});assert.ok('record'in checked);assert.equal(checked.record.providerSubmission?.transactionId,'Original-ID');
  for(const change of [{hash:null},{attempt:null},{providerSubmission:{...record.providerSubmission,from:a(22)}},{providerSubmission:{...record.providerSubmission,calldataHash:h(22)}},{providerSubmission:{...record.providerSubmission,finalized:true}}])assert.equal(FundingRecordSchema.safeParse({...record,...change}).success,false);
  const {providerSubmission,...legacy}=record;assert.equal(FundingRecordSchema.parse(legacy).providerSubmission,undefined);
});
test('allocation response validates exact settle versus timeout and the signed executor',async()=>{
  const f=await originalAuthorizationFixture(),r=allocationResponse(f);const checked=checkAllocationResponse({payload:f.payload},r);assert.ok('record'in checked);assert.equal(checked.record?.providerSubmission?.transactionId,'Settle-ID');
  assert.equal(AllocationRecordSchema.safeParse({...r.record,action:'timeout'}).success,false);
  assert.throws(()=>checkAllocationResponse({payload:f.payload},{...r,record:{...r.record,providerSubmission:{...r.record.providerSubmission,from:a(33)}}}),/RESPONSE_MISMATCH/);
  assert.equal(AllocationRecordSchema.safeParse({...r.record,attempt:null}).success,false);
});
test('funding browser refuses changed or omitted original provider IDs and never repeats a send',async()=>{
  const f=await originalAuthorizationFixture(),record=fundingRecord(f);let response:unknown={record,canSubmitPayment:false},sends=0;
  const flow=new OriginalFundingFlow(f.payload,'owner',()=>true,session(f),{submitOriginal:async()=>{sends++;return response;},reconcileFunding:async()=>response});await flow.submit(true);
  response={record:{...record,providerSubmission:{...record.providerSubmission,transactionId:'Other-ID'}},canSubmitPayment:false};await assert.rejects(flow.reconcile(),/PROVIDER_SUBMISSION_LOCKED/);
  const {providerSubmission,...omitted}=record;response={record:omitted,canSubmitPayment:false};await assert.rejects(flow.reconcile(),/PROVIDER_SUBMISSION_LOCKED/);await assert.rejects(flow.submit(true),/RECONCILIATION_REQUIRED/);assert.equal(sends,1);assert.equal(flow.state.result?.record.providerSubmission?.transactionId,'Original-ID');
});
test('allocation browser preserves opaque ID case and ignores neither replacement nor omission',async()=>{
  const f=await originalAuthorizationFixture(),r=allocationResponse(f);let response:unknown=r;const flow=new AllocationFlow({payload:f.payload},'owner',session(f),{queryAllocation:async()=>response,triggerAllocation:async()=>{throw Error('UNEXPECTED_SEND');},reconcileAllocation:async()=>response});await flow.query();
  response={...r,record:{...r.record,providerSubmission:{...r.record.providerSubmission,transactionId:'settle-ID'}}};await assert.rejects(flow.query(),/PROVIDER_SUBMISSION_LOCKED/);
  const {providerSubmission,...omitted}=r.record;response={...r,record:omitted};await assert.rejects(flow.query(),/PROVIDER_SUBMISSION_LOCKED/);assert.equal(flow.observation?.record?.providerSubmission?.transactionId,'Settle-ID');assert.equal(flow.locked,true);
});
test('funding browser preserves independently confirmed status even when the same original metadata is returned',async()=>{
  const f=await originalAuthorizationFixture(),record=fundingRecord(f);let response:unknown={record:{...record,status:'CONFIRMED'},snapshot:f.snapshot('FUNDED'),canSubmitPayment:false};
  const flow=new OriginalFundingFlow(f.payload,'owner',()=>true,session(f),{submitOriginal:async()=>{throw Error('UNEXPECTED_SEND');},reconcileFunding:async()=>response});await flow.reconcile();
  response={record,snapshot:f.snapshot('FUNDED'),canSubmitPayment:false};await assert.rejects(flow.reconcile(),/FUNDING_RECORD_LOCKED/);assert.equal(flow.state.result?.record.status,'CONFIRMED');
  response={record:{...record,status:'CONFIRMED'},snapshot:f.snapshot('FUNDED'),error:'CONFIRMATION_LOST',canSubmitPayment:false};await flow.reconcile();assert.equal(flow.state.result?.record.status,'CONFIRMED');assert.equal(flow.state.unknown,true);
});
test('fixed settlement port captures original sender and propagates recorded response without a legacy fallback',async()=>{
  const f=await originalAuthorizationFixture(),data=encodeFunctionData({abi:escrowAbi,functionName:'settle',args:[f.payload.intent.orderId as Hex]});let legacy=0,recorded=0;
  const sender={address:f.deployment.executor as `0x${string}`,send:async()=>{legacy++;return h(20);},sendRecorded:async()=>{recorded++;return {hash:h(20),providerSubmission:metadata(f,data)};}};
  const reader={client:{} as PublicClient,deployment:{...f.deployment,gate:a(90)},read:async()=>f.snapshot('CERTIFIED')} as unknown as EscrowReader,port=viemSettlementPort(reader,sender);sender.address=a(22);sender.sendRecorded=async()=>{throw Error('REPLACED');};
  const result=recordedBroadcast(await port.send('settle',f.payload.intent.orderId,'original-attempt'));assert.equal(result.providerSubmission?.transactionId,'Original-ID');assert.equal(recorded,1);assert.equal(legacy,0);
});
test('settlement recorded metadata stays SUBMITTED until an independent receipt and survives store reopen',async()=>{
  const f=await originalAuthorizationFixture(),r=allocationResponse(f),directory=mkdtempSync(join(tmpdir(),'intentpass-submission-flow-')),path=join(directory,'settle.db');let store=new SettlementStore(path),state=r.preparation.order,sends=0;
  const port:SettlementPort={read:async()=>structuredClone(state) as OrderSnapshot,simulate:async()=>{},send:async()=>{sends++;return {hash:h(21),providerSubmission:r.record.providerSubmission};},receipt:async()=>({status:'PENDING'}),blockHash:async()=>h(11)};
  try{const key=store.register(r.record.order).key;assert.equal((await new SettlementWorker(store,port,()=>1000).runOnce(key)).status,'SUBMITTED');assert.equal(store.get(key)?.providerSubmission?.transactionId,'Settle-ID');store.close();store=new SettlementStore(path);assert.equal((await new SettlementWorker(store,port,()=>1000).runOnce(key,false)).status,'SUBMITTED');assert.equal(sends,1);assert.equal(store.get(key)?.providerSubmission?.transactionId,'Settle-ID');}finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
test('late worker acknowledgement preserves concurrent reconciled state and its original historical ID',async()=>{
  const f=await originalAuthorizationFixture(),r=allocationResponse(f),store=new SettlementStore(':memory:'),key=store.register(r.record.order).key;let sends=0;
  const port:SettlementPort={read:async()=>structuredClone(r.preparation.order) as OrderSnapshot,simulate:async()=>{},send:async()=>{sends++;store.expire(key,31000);store.reconcile(key);return {hash:h(21),providerSubmission:r.record.providerSubmission};},receipt:async()=>({status:'PENDING'}),blockHash:async()=>h(11)};
  try{const worker=new SettlementWorker(store,port,()=>1000),result=await worker.runOnce(key);assert.equal(result.status,'RECONCILED');assert.equal(result.txHash,undefined);assert.equal(store.listSubmissions(key)[0].providerSubmission?.transactionId,'Settle-ID');await worker.runOnce(key);assert.equal(sends,1);}finally{store.close();}
});
test('original allocation wrapper rejects another executor in a recorded response and does not fallback or resend',async()=>{
  const f=await originalAuthorizationFixture(),r=allocationResponse(f);let sends=0;
  const reader={prepare:async()=>r.preparation} as unknown as AllocationReader,base:SettlementPort={read:async()=>r.preparation.order as OrderSnapshot,simulate:async()=>{},send:async()=>{sends++;return {hash:h(21),providerSubmission:{...r.record.providerSubmission,from:a(66)}};},receipt:async()=>({status:'PENDING'}),blockHash:async()=>h(11)};
  const port=originalAllocationPort(reader,base,f.payload,[f.buyer.address],'settle');await assert.rejects(port.send('settle',f.payload.intent.orderId,'original-attempt'),/PROVIDER_SUBMISSION_MISMATCH/);assert.equal(sends,1);
});
test('authenticated funding HTTP and SDK retain original provider metadata through confirmation and database reopen',async()=>{
  const f=await originalAuthorizationFixture(),g=f.payload.grant,directory=mkdtempSync(join(tmpdir(),'intentpass-submission-http-')),path=join(directory,'fund.db');let store=new FundingStore(path),funded=false,sends=0,wallet=f.buyer.address;
  const snapshot=()=>({...f.snapshot(funded?'FUNDED':'UNREGISTERED'),block:{number:'100',hash:h(11),timestamp:'1000'}}),port:FundingPort={read:async()=>snapshot(),preflight:async()=>({chainId:g.chainId,arbiter:g.arbiter,asset:g.asset,buyer:g.owner,orderId:g.orderId,contextHash:g.contextHash,nonce:g.nonce,amount:g.amount,deadline:g.deadline,state:funded?'FUNDED':'UNREGISTERED',consumed:funded,revoked:false,transferEligible:true,balance:'15',allowance:'15',blockers:funded?['ORDER_ALREADY_REGISTERED','NONCE_CONSUMED']:[],block:{number:'100',hash:h(11),timestamp:'1000',finality:'finalized'},canSubmitPayment:false}),simulate:async()=>{},send:async()=>{sends++;funded=true;return {hash:h(20),providerSubmission:metadata(f,fundingCalldata(f.payload),'Funding-ID')};},receipt:async()=>({status:'SUCCESS',blockNumber:'100',blockHash:h(11)}),blockHash:async()=>h(11)};
  const app=await createApp({dependencyPrebundling:false,fundingApi:{auth:{authenticate:async()=>({subject:'owner',wallets:[wallet]})},worker:new FundingWorker(store,port,f.deployment,()=>1000000)}});await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));const bound=app.server.address();assert.ok(bound&&typeof bound!=='string');const client=new PurchaseClient(`http://127.0.0.1:${bound.port}`,async()=>'local-token');
  try{const sent=await client.submitOriginal({payload:f.payload,confirm:true});assert.ok('record'in sent);assert.equal(sent.record.status,'SUBMITTED');assert.equal(sent.record.providerSubmission?.transactionId,'Funding-ID');const done=await client.reconcileFunding({payload:f.payload});assert.ok('record'in done);assert.equal(done.record.status,'CONFIRMED');assert.equal(done.record.providerSubmission?.transactionId,'Funding-ID');wallet=a(66);assert.deepEqual(await client.reconcileFunding({payload:f.payload}),{status:'REJECT',code:'OWNER_MISMATCH'});assert.equal(sends,1);await app.close();store.close();store=new FundingStore(path);assert.equal(store.get(sent.record.key)?.providerSubmission?.transactionId,'Funding-ID');assert.equal(store.get(sent.record.key)?.status,'CONFIRMED');}finally{await app.close();store.close();rmSync(directory,{recursive:true,force:true});}
});
