import test from 'node:test';
import assert from 'node:assert/strict';
import {checkExpiredUnfunded,inspectExpiredUnfunded} from '../apps/worker/src/expired-procurement.js';
import {originalAuthorizationFixture,readTestHash} from './support/original-authorization.js';
import type {PreflightSnapshot} from '../packages/protocol/src/purchase-preflight.js';
import {orderStates} from '../packages/protocol/src/escrow-read.js';
import {mkdtempSync,realpathSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {BackgroundVault} from '../packages/storage/src/background-vault.js';
import {writePrivateServiceJsonOnce} from '../scripts/create-privy-service-wallets.js';
import {readProcurementProgress} from '../apps/worker/src/procurement-progress.js';
import {renderLiveTrace} from '../apps/web/src/live-purchase-ui.js';
import {WorkflowStore} from '../packages/storage/src/workflow-store.js';
import {FundingStore} from '../packages/storage/src/funding-store.js';
import {WorkflowRegistry,WorkflowWorker} from '../apps/worker/src/workflow-worker.js';
import {EncryptedWorkflowVault} from '../apps/worker/src/workflow-vault.js';

export function expiredSnapshot(p:Awaited<ReturnType<typeof originalAuthorizationFixture>>['payload']):PreflightSnapshot{
  const g=p.grant;
  return {chainId:g.chainId,arbiter:g.arbiter,asset:g.asset,buyer:g.owner,orderId:g.orderId,contextHash:g.contextHash,nonce:g.nonce,amount:g.amount,deadline:g.deadline,state:'UNREGISTERED',consumed:false,revoked:false,transferEligible:true,balance:'100',allowance:g.amount,blockers:['AUTHORIZATION_EXPIRED'],block:{number:'101',hash:readTestHash(11),timestamp:String(BigInt(g.deadline)+1n),finality:'finalized'},canSubmitPayment:false};
}
test('expiry proof authenticates original signatures and binds the exact read without resigning',async()=>{
  const f=await originalAuthorizationFixture('10143',{singleReportBackground:true}),before=JSON.stringify(f.payload),s=expiredSnapshot(f.payload);let reads=0;
  const result=await inspectExpiredUnfunded(f.payload,f.deployment,async input=>{reads++;assert.deepEqual(input,{intent:f.payload.intent,grant:f.payload.grant});return s;});
  assert.deepEqual(result,s);assert.equal(reads,1);assert.equal(JSON.stringify(f.payload),before);
  await assert.rejects(inspectExpiredUnfunded({...f.payload,ownerSignature:'0x'+'11'.repeat(65)},f.deployment,async()=>{reads++;return s;}));assert.equal(reads,1);
  await assert.rejects(inspectExpiredUnfunded(f.payload,{...f.deployment,asset:f.buyer.address},async()=>s));
  await assert.rejects(inspectExpiredUnfunded(f.payload,f.deployment,async()=>{throw Error('RPC unavailable');}),/RPC unavailable/);
});
test('nonfinal, funded, consumed and deadline-equality observations cannot close an original job',async()=>{
  const {payload}=await originalAuthorizationFixture('10143',{singleReportBackground:true}),s=expiredSnapshot(payload);
  assert.equal(checkExpiredUnfunded(payload,{...s,block:{...s.block,finality:'latest'}}),undefined);
  assert.equal(checkExpiredUnfunded(payload,{...s,block:{...s.block,timestamp:payload.grant.deadline}}),undefined);
  assert.equal(checkExpiredUnfunded(payload,{...s,blockers:[],block:{...s.block,timestamp:String(BigInt(payload.grant.deadline)-1n)}}),undefined);
  for(const state of orderStates.filter(s=>s!=='UNREGISTERED')){
    const observation={...s,state,blockers:['ORDER_ALREADY_REGISTERED','AUTHORIZATION_EXPIRED']};
    assert.equal(checkExpiredUnfunded(payload,observation),undefined);
  }
  assert.equal(checkExpiredUnfunded(payload,{...s,consumed:true,blockers:['NONCE_CONSUMED','AUTHORIZATION_EXPIRED']}),undefined);
  for(const key of ['chainId','arbiter','asset','buyer','orderId','contextHash','nonce','amount','deadline'] as const){
    const value=key==='nonce'?'1':['chainId','amount','deadline'].includes(key)?'1':key==='orderId'||key==='contextHash'?readTestHash(999):fauxAddress;
    assert.throws(()=>checkExpiredUnfunded(payload,{...s,[key]:value}),key);
  }
});
const fauxAddress='0x'+'ff'.repeat(20);
test('encrypted expiry projection keeps UNKNOWN visible and only renders the matching finalized proof',async()=>{
  const f=await originalAuthorizationFixture('10143',{singleReportBackground:true}),root=mkdtempSync(resolve(realpathSync(tmpdir()),'intentpass-expiry-')),binding='a'.repeat(64),vault=new BackgroundVault(resolve(root,'vault'));
  const id=(name:string)=>createHash('sha256').update(`${binding}:${name}`).digest('hex'),p=f.payload,candidate={status:'DRAFT',modelId:'LOCAL_DOUBLE',citations:[],policy:p.policy,evidence:p.evidence,intent:p.intent,quote:p.quote};
  try{
    writePrivateServiceJsonOnce(resolve(root,'job-reference.json'),{scopeHash:binding});
    vault.save('authorization',p.intent.orderId.slice(2),binding,{payload:p,dataset:f.dataset});
    vault.save('checkpoint',id('trace:preparation'),binding,{candidate});
    vault.save('checkpoint',id('trace:funding'),binding,{status:'ATTENTION',funding:{error:'SUBMISSION_OUTCOME_UNKNOWN',record:{status:'UNKNOWN',hash:null}}});
    const original=readFileSync(resolve(root,'vault',`authorization-${p.intent.orderId.slice(2)}.json`));
    vault.save('checkpoint',id('trace:expired-unfunded'),binding,expiredSnapshot(p));
    assert.throws(()=>vault.save('checkpoint',id('trace:expired-unfunded'),binding,expiredSnapshot(p)),/ORIGINAL_BACKUP_LOCKED/);
    const progress=readProcurementProgress(root),base={id:'d25b0906-9d26-4cb7-995f-f4d48d3ecbc9',status:'FAILED',task:{schemaVersion:1,kind:'memory',policy:p.policy,evidence:p.evidence,taskInput:{dataset:f.dataset,buyer:p.intent.buyer,seller:p.intent.seller}},dispatched:true,attempts:1,progress};
    const view=renderLiveTrace(base);assert.equal(view.status,'Expired before payment');assert.equal(view.complete,false);assert.equal(view.terminal,true);assert.match(view.html,/Escrow payment: UNKNOWN/);assert.match(view.html,/original attempt remains locked/);assert.doesNotMatch(view.html,/Your report is ready/);
    for(const altered of [{...expiredSnapshot(p),orderId:readTestHash(999)},{...expiredSnapshot(p),block:{...expiredSnapshot(p).block,finality:'latest'}}])assert.notEqual(renderLiveTrace({...base,progress:{...progress,expiration:altered}}).status,'Expired before payment');
    assert.notEqual(renderLiveTrace({...base,status:'RECONCILING'}).status,'Expired before payment');
    assert.deepEqual(readFileSync(resolve(root,'vault',`authorization-${p.intent.orderId.slice(2)}.json`)),original);
    assert.equal(progress.funding?.record?.status,'UNKNOWN');assert.equal(progress.completion,null);
  }finally{vault.dispose();rmSync(root,{recursive:true,force:true});}
});
test('expired reconciliation appends a failed job across restart without unlocking or sending the old attempt',async()=>{
  const f=await originalAuthorizationFixture('10143',{singleReportBackground:true}),root=mkdtempSync(resolve(realpathSync(tmpdir()),'intentpass-expiry-queue-')),store=new WorkflowStore(resolve(root,'queue.db')),funding=new FundingStore(resolve(root,'funding.db')),raw=new BackgroundVault(resolve(root,'vault')),vault=new EncryptedWorkflowVault(raw,'a'.repeat(64)),registry=new WorkflowRegistry();
  const {deadline,receiptHash,preparationHash,maxUses,schemaVersion,...g}=f.payload.grant,anchor={...g,calldataHash:readTestHash(66)},record=funding.register(anchor);let now=1000,sends=0;
  registry.register('purchase',{effect:'WRITE',execute:async c=>{await c.dispatch(async()=>{sends++;const attempt=funding.acquire(record.key,now)!;funding.stop(record.key,attempt,'UNKNOWN');throw Error('lost response');});return {status:'FAILED'};},reconcile:async c=>{await assert.rejects(c.dispatch(async()=>{sends++;return null;}),/ORIGINAL_DISPATCH_LOCKED/);assert.ok(await inspectExpiredUnfunded(f.payload,f.deployment,async()=>expiredSnapshot(f.payload)));return {status:'FAILED'};}});
  try{
    const worker=new WorkflowWorker(store,vault,registry,()=>now),request={idempotencyKey:'one-original',workflow:{name:'purchase',version:'1',steps:[{id:'buy',handler:'purchase',effect:'WRITE',retryDelayMs:100}]},input:{},runAt:0};
    const job=await worker.submit(request);assert.equal((await worker.tick())?.status,'RECONCILING');const original=funding.get(record.key);now=2000;
    const restarted=new WorkflowWorker(store,vault,registry,()=>now);assert.equal((await restarted.tick())?.status,'FAILED');assert.equal((await restarted.submit(request)).id,job.id);assert.equal(await restarted.tick(),null);
    assert.equal(sends,1);assert.equal(store.step(job.id,0).attempts,1);assert.equal(store.step(job.id,0).dispatched,true);assert.deepEqual(funding.get(record.key),original);assert.equal(funding.acquire(record.key,now),undefined);
  }finally{store.close();funding.close();raw.dispose();rmSync(root,{recursive:true,force:true});}
});
