import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {keccak256} from 'viem';
import {BrowserSession,type BrowserAuthPort} from '../apps/web/src/browser-session.js';
import {RestoredOrderContext} from '../apps/web/src/restored-order-context.js';
import {RestoredFundingReader,restoredFundingText} from '../apps/web/src/restored-funding.js';
import {attachRestoredOrderControls,restoredOrderControls} from '../apps/web/src/restored-order-ui.js';
import {fundingCalldata} from '../packages/protocol/src/funding.js';
import type {FundingResult} from '../packages/protocol/src/funding-api.js';
import {originalAuthorizationFixture,readTestHash as h,readTestAddress as a} from './support/original-authorization.js';

// Generated signatures, fake authenticated responses and fake DOM only. These
// fixtures are not evidence of a real browser, Privy session or chain payment.
async function fixture(status:FundingResult['record']['status']='SUBMITTED'){
  const f=await originalAuthorizationFixture('10143'),g=f.payload.grant;
  const anchor={chainId:g.chainId,arbiter:g.arbiter,asset:g.asset,owner:g.owner,executor:g.executor,orderId:g.orderId,contextHash:g.contextHash,nonce:g.nonce,amount:g.amount,calldataHash:keccak256(fundingCalldata(f.payload))};
  const attempt=randomUUID();
  const result=(next:FundingResult['record']['status']):FundingResult=>({record:{key:`${g.chainId}:${g.arbiter.toLowerCase()}:${g.orderId.toLowerCase()}`,anchor:structuredClone(anchor),status:next,attempt:next==='IDLE'?null:attempt,hash:['SUBMITTED','CONFIRMED','REVERTED'].includes(next)?h(20):null,leaseUntil:next==='IN_FLIGHT'?1:null},snapshot:f.snapshot(['CONFIRMED','RECONCILED'].includes(next)?'FUNDED':'UNREGISTERED'),canSubmitPayment:false});
  let response=result(status),subject='LOCAL_SUBJECT_SENTINEL',buyer=f.buyer.address,readFailure=false,hold:(()=>Promise<void>)|undefined;
  let queries=0,forbidden=0,sessionReads=0;
  const auth:BrowserAuthPort={initialize:async()=>{},sendCode:async()=>{forbidden++;},login:async()=>{forbidden++;},token:async()=>'LOCAL_TOKEN_SENTINEL',logout:async()=>{},signGrant:async()=>{forbidden++;throw new Error('FORBIDDEN');},approveAsset:async()=>{forbidden++;throw new Error('FORBIDDEN');},withdrawOrder:async()=>{forbidden++;throw new Error('FORBIDDEN');}};
  const session=new BrowserSession(async()=>auth,async url=>{if(url==='/api/config')return new Response(JSON.stringify({privyAppId:'local-test-app',meraRpId:'localhost',recoveryDeployment:f.deployment}));sessionReads++;return new Response(JSON.stringify({subject,wallets:[buyer]}));});
  const port={reconcileFunding:async(request:unknown)=>{queries++;assert.deepEqual(request,{payload:f.payload});if(hold)await hold();if(readFailure)throw new Error('LOCAL_PRIVATE_PROVIDER_ERROR');return structuredClone(response);},submitOriginal:async()=>{forbidden++;throw new Error('FORBIDDEN');},reserve:async()=>{forbidden++;throw new Error('FORBIDDEN');},simulate:async()=>{forbidden++;throw new Error('FORBIDDEN');},send:async()=>{forbidden++;throw new Error('FORBIDDEN');}};
  const context=new RestoredOrderContext();
  await context.restoreAuthorization(f.payload,{rpId:'localhost',credentialId:'AQID'},[f.buyer.address],f.deployment,{read:async()=>f.snapshot('UNREGISTERED')});
  return {...f,anchor,attempt,session,port,context,result,setResult:(value:FundingResult)=>{response=structuredClone(value);},fail:()=>{readFailure=true;},hold:(fn:()=>Promise<void>)=>{hold=fn;},changeSubject:()=>{subject='DIFFERENT_SUBJECT';},changeBuyer:()=>{buyer=a(66);},counts:()=>({queries,forbidden,sessionReads})};
}

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
async function until(predicate:()=>boolean){const deadline=Date.now()+5000;while(!predicate()){if(Date.now()>deadline)throw new Error('LOCAL_UI_TIMEOUT');await new Promise(resolve=>setTimeout(resolve,5));}}
function dom(){
  const nodes=new Map<string,{isConnected:boolean;disabled:boolean;checked:boolean;textContent:string;writes:number;addEventListener:(event:string,callback:()=>void)=>void;emit:(event:string)=>void}>();
  for(const match of restoredOrderControls.matchAll(/id="([^"]+)"/g)){
    const handlers=new Map<string,(()=>void)[]>();let text='';
    const node={isConnected:true,disabled:false,checked:false,writes:0,get textContent(){return text;},set textContent(value:string){text=value;this.writes++;},addEventListener:(event:string,callback:()=>void)=>{handlers.set(event,[...(handlers.get(event)??[]),callback]);},emit:(event:string)=>{assert.ok(!(event==='click'&&node.disabled),'disabled local DOM button');for(const callback of handlers.get(event)??[])callback();}};
    nodes.set(match[1],node);
  }
  return {nodes,document:{querySelector:(selector:string)=>nodes.get(selector.slice(1))},detach:()=>{for(const node of nodes.values())node.isConnected=false;}};
}
async function withDom(f:Awaited<ReturnType<typeof fixture>>,work:(d:ReturnType<typeof dom>)=>Promise<void>){
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document'),d=dom();
  Object.defineProperty(globalThis,'document',{configurable:true,value:d.document});
  try{attachRestoredOrderControls(f.context,f.session,undefined,()=>{throw new Error('NO_EXPORT');},f.port);await work(d);}finally{if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');}
}
async function query(d:ReturnType<typeof dom>){d.nodes.get('restored-funding-query')!.emit('click');await until(()=>!d.nodes.get('restored-funding-query')!.disabled);return d.nodes.get('restored-funding-preview')!.textContent;}

test('restored NOT_FUNDED DOM explicitly queries only its original durable SUBMITTED attempt and publishes an allowlist',async()=>{
  const f=await fixture(),r=f.result('SUBMITTED');
  r.record.providerSubmission={provider:'PRIVY',scope:'SDK_SEND_RESPONSE_ASSOCIATION_NOT_FINALIZED_OR_POLICY_PROVENANCE',transactionId:'LOCAL_PROVIDER_ID_SENTINEL',walletId:'LOCAL_WALLET_ID_SENTINEL',chainId:f.anchor.chainId,from:f.anchor.executor,to:f.anchor.arbiter,calldataHash:f.anchor.calldataHash};f.setResult(r);
  await withDom(f,async d=>{
    assert.equal(f.context.order?.state,'UNREGISTERED');assert.throws(()=>f.context.continuationInput(),/FUNDED_ORDER_REQUIRED/);
    assert.equal(f.counts().queries,0);assert.equal(f.counts().sessionReads,0);assert.equal(d.nodes.get('restored-handoff')!.disabled,true);
    const text=await query(d);assert.ok(text.includes(f.attempt)&&text.includes(h(20))&&text.includes('SUBMITTED')&&text.includes('NOT_FUNDED')&&text.includes('尚不代表最终入金或到账')&&text.includes('已保存原 SDK'));
    for(const privateValue of [f.payload.quote.serviceTerms,f.payload.evidence.taskText,...f.payload.evidence.documents.map(x=>x.text),'LOCAL_SUBJECT_SENTINEL','LOCAL_TOKEN_SENTINEL','LOCAL_PROVIDER_ID_SENTINEL','LOCAL_WALLET_ID_SENTINEL'])assert.ok(!text.includes(privateValue));
    assert.equal(f.counts().queries,1);assert.equal(f.counts().forbidden,0);assert.equal(d.nodes.get('restored-handoff')!.disabled,true);
  });
});

test('restored UNKNOWN and IN_FLIGHT remain distinct from NOT_FUNDED without a new authorization or payment entry',async()=>{
  for(const status of ['UNKNOWN','IN_FLIGHT'] as const){const f=await fixture(status);await withDom(f,async d=>{const text=await query(d);assert.ok(text.includes(`原发送状态：${status}`)&&text.includes('NOT_FUNDED')&&text.includes('未知')&&text.includes('不能再次付款'));assert.equal(f.counts().forbidden,0);assert.equal(f.counts().queries,1);});}
  assert.ok(!restoredOrderControls.includes('funding-hash'));assert.ok(!restoredOrderControls.includes('submit-original'));
});

test('IDLE does not prove never broadcast and RECONCILED does not claim an exact confirmed funding hash',async()=>{
  const f=await fixture('IDLE');await withDom(f,async d=>{const idle=await query(d);assert.ok(idle.includes('原发送状态：IDLE')&&idle.includes('不能据此证明外部从未广播'));f.setResult(f.result('RECONCILED'));const reconciled=await query(d);assert.ok(reconciled.includes('原发送状态：RECONCILED')&&reconciled.includes('没有绑定准确的原入金交易 hash')&&reconciled.includes('原链订单：FUNDED'));assert.equal(f.counts().forbidden,0);});
});

test('read errors keep the original attempt and hash visible only as an explicitly stale result without private error text',async()=>{
  const f=await fixture();await withDom(f,async d=>{await query(d);f.fail();const text=await query(d);assert.ok(text.includes('保留的原发送记录')&&text.includes('不代表当前链状态')&&text.includes(f.attempt)&&text.includes(h(20)));assert.ok(!text.includes('LOCAL_PRIVATE_PROVIDER_ERROR'));assert.ok(d.nodes.get('restored-funding-feedback')!.textContent.includes('核对失败'));assert.equal(f.counts().forbidden,0);});
});

test('CONFIRMATION_LOST retains the durable CONFIRMED label while refusing to render a current chain confirmation',async()=>{
  const f=await fixture('CONFIRMED');await withDom(f,async d=>{await query(d);const lost=f.result('CONFIRMED');lost.error='CONFIRMATION_LOST';f.setResult(lost);const text=await query(d);assert.ok(text.includes('原发送状态：CONFIRMED')&&text.includes('本次链快照不可用')&&text.includes('不能确认当前入金状态')&&text.includes('保留的原发送记录'));assert.ok(!text.includes('\n核对区块：'));assert.ok(d.nodes.get('restored-funding-feedback')!.textContent.includes('核对失败'));assert.equal(f.counts().forbidden,0);});
});

test('first recovery with CONFIRMATION_LOST preserves the original stored attempt and hash as failed verification',async()=>{
  const f=await fixture('CONFIRMED'),lost=f.result('CONFIRMED');lost.error='CONFIRMATION_LOST';f.setResult(lost);
  await withDom(f,async d=>{const text=await query(d);assert.ok(text.includes(f.attempt)&&text.includes(h(20))&&text.includes('保留的原发送记录')&&text.includes('本次核对失败')&&text.includes('本次链快照不可用'));assert.ok(!text.includes('上次链订单')&&!text.includes('本次原记录核对结果'));assert.ok(d.nodes.get('restored-funding-feedback')!.textContent.includes('核对失败'));assert.equal(f.counts().forbidden,0);});
});

test('original attempt hash provider and terminal status conflicts cannot replace the last safe readonly observation',async()=>{
  for(const mutation of ['status','hash','attempt','provider'] as const){
    const f=await fixture('CONFIRMED'),first=f.result('CONFIRMED');first.record.providerSubmission={provider:'PRIVY',scope:'SDK_SEND_RESPONSE_ASSOCIATION_NOT_FINALIZED_OR_POLICY_PROVENANCE',transactionId:'Original-Response',walletId:'Original-Wallet',chainId:f.anchor.chainId,from:f.anchor.executor,to:f.anchor.arbiter,calldataHash:f.anchor.calldataHash};f.setResult(first);
    const reader=new RestoredFundingReader(f.payload,f.session,f.port);await reader.query();const before=reader.state.observation!,changed=structuredClone(first);
    if(mutation==='status')changed.record.status='SUBMITTED';if(mutation==='hash')changed.record.hash=h(21);if(mutation==='attempt')changed.record.attempt=randomUUID();if(mutation==='provider')changed.record.providerSubmission!.transactionId='Changed-Response';f.setResult(changed);
    await assert.rejects(reader.query(),/^Error: RESTORED_FUNDING_UNAVAILABLE$/);assert.equal(reader.state.phase,'STALE');assert.deepEqual(reader.state.observation,before);assert.equal(f.counts().forbidden,0);
  }
});

test('a first read failure reports unavailable rather than IDLE or an invitation to send',async()=>{
  const f=await fixture();f.fail();await withDom(f,async d=>{const text=await query(d);assert.ok(text.includes('发送状态未知'));assert.ok(!text.includes('原发送状态：IDLE'));assert.equal(f.counts().forbidden,0);});
});

test('same-generation subject or buyer replacement discards the late response without any DOM repaint',async t=>{
  for(const changed of ['subject','buyer'] as const)await t.test(changed,async()=>{
    const f=await fixture(),waiting=deferred();f.hold(()=>waiting.promise);
    await withDom(f,async d=>{const button=d.nodes.get('restored-funding-query')!,preview=d.nodes.get('restored-funding-preview')!,feedback=d.nodes.get('restored-funding-feedback')!;button.emit('click');await until(()=>f.counts().queries===1);const before={text:preview.textContent,writes:preview.writes,feedback:feedback.textContent,feedbackWrites:feedback.writes};if(changed==='subject')f.changeSubject();else f.changeBuyer();waiting.resolve();await new Promise(resolve=>setTimeout(resolve,30));assert.deepEqual({text:preview.textContent,writes:preview.writes,feedback:feedback.textContent,feedbackWrites:feedback.writes},before);assert.equal(button.disabled,true);assert.equal(f.counts().forbidden,0);});
  });
});

test('logout generation or detached restored DOM discards the late response without repaint or send',async t=>{
  for(const changed of ['logout','detach','clear'] as const)await t.test(changed,async()=>{
    const f=await fixture(),waiting=deferred();f.hold(()=>waiting.promise);
    await withDom(f,async d=>{const button=d.nodes.get('restored-funding-query')!,preview=d.nodes.get('restored-funding-preview')!,feedback=d.nodes.get('restored-funding-feedback')!;button.emit('click');await until(()=>f.counts().queries===1);const writes=[preview.writes,feedback.writes];if(changed==='logout')await f.session.logout();else if(changed==='detach')d.detach();else f.context.clear();waiting.resolve();await new Promise(resolve=>setTimeout(resolve,30));assert.deepEqual([preview.writes,feedback.writes],writes);assert.equal(f.counts().forbidden,0);});
  });
});

test('failed provider read after changing account cannot mark a previous account observation stale in the new session',async()=>{
  const f=await fixture(),reader=new RestoredFundingReader(f.payload,f.session,f.port);await reader.query();const before=reader.state,waiting=deferred();f.hold(()=>waiting.promise);f.fail();const pending=reader.query();await until(()=>f.counts().queries===2);f.changeSubject();waiting.resolve();await assert.rejects(pending,/SESSION_CHANGED/);assert.deepEqual(reader.state,before);assert.equal(f.counts().forbidden,0);
});

test('readonly reader snapshots original authorization and captures the reconciliation method before an await',async()=>{
  const f=await fixture(),input=structuredClone(f.payload),reader=new RestoredFundingReader(input,f.session,f.port);input.grant.amount='999';f.port.reconcileFunding=async()=>{throw new Error('REPLACED_METHOD');};assert.equal((await reader.query()).observation?.orderId,f.payload.intent.orderId);const published=reader.state;published.observation!.hash=h(66);assert.equal(reader.state.observation?.hash,h(20));assert.equal('submit'in reader,false);assert.equal(f.counts().forbidden,0);
});
