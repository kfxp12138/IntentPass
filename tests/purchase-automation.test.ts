import test from 'node:test';
import assert from 'node:assert/strict';
import {AutomaticPreparation,AutomaticPayment} from '../apps/web/src/purchase-automation.js';
import {purchaseEvidenceFixture} from './support/purchase-evidence.js';
import {originalAuthorizationFixture,readTestHash as h} from './support/original-authorization.js';
import type {AssetApprovalFlow} from '../apps/web/src/asset-approval-flow.js';
import type {OriginalFundingFlow} from '../apps/web/src/original-funding-flow.js';
import {receiptTypedData} from '../packages/protocol/src/index.js';

test('automatic preparation completes real proposal review and preflight code without requesting a wallet and reuses the exact candidate',async()=>{
  const f=await purchaseEvidenceFixture();f.setChoice('SUPPORTED');const run=new AutomaticPreparation(f.flow,f.clock),phases:string[]=[];
  assert.equal(await run.run([f.entry.quote.quoteId],'300',x=>phases.push(x)),'READY');
  assert.deepEqual(phases,['CANDIDATE','REVIEW','PERMISSION','PREFLIGHT']);assert.deepEqual(f.counts(),{planner:1,jev:1,signatures:0});
  const original=structuredClone(f.flow.authorization);assert.equal(await run.run([], '300'),'READY');assert.deepEqual(f.flow.authorization,original);assert.deepEqual(f.counts(),{planner:1,jev:1,signatures:0});
  f.setTime(1300n);assert.equal(await run.run([],'300'),'RECEIPT_EXPIRED');assert.deepEqual(f.counts(),{planner:1,jev:1,signatures:0});
});
test('automatic preparation stops at a non-PASS and cannot repeat an unknown original proposal',async()=>{
  const f=await purchaseEvidenceFixture(),run=new AutomaticPreparation(f.flow,f.clock);assert.equal(await run.run([f.entry.quote.quoteId],'300'),'REVIEW_STOPPED');assert.equal(f.flow.authorization,undefined);assert.equal(f.counts().signatures,0);
  const other=await purchaseEvidenceFixture();other.port.propose=async()=>{throw Error('PRIVATE_PROVIDER_SENTINEL');};const blocked=new AutomaticPreparation(other.flow,other.clock);await assert.rejects(blocked.run([other.entry.quote.quoteId],'300'));await assert.rejects(blocked.run([other.entry.quote.quoteId],'300'),/RECONCILIATION_REQUIRED/);
});
test('device preparation happens before review and a rejected device operation requests neither receipt nor wallet permission',async()=>{
  const f=await purchaseEvidenceFixture();f.setChoice('SUPPORTED');let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;}),waiting=new Promise<void>(r=>{release=r;});
  const run=new AutomaticPreparation(f.flow,f.clock,async()=>{entered();await waiting;});const operation=run.run([f.entry.quote.quoteId],'300');await started;
  assert.deepEqual(f.counts(),{planner:1,jev:0,signatures:0});assert.equal(f.flow.authorization,undefined);release();assert.equal(await operation,'READY');assert.deepEqual(f.counts(),{planner:1,jev:1,signatures:0});
  const cancelled=await purchaseEvidenceFixture();cancelled.setChoice('SUPPORTED');const stop=new AutomaticPreparation(cancelled.flow,cancelled.clock,async()=>{throw Error('PASSKEY_CANCELLED');});
  await assert.rejects(stop.run([cancelled.entry.quote.quoteId],'300'),/PASSKEY_CANCELLED/);assert.deepEqual(cancelled.counts(),{planner:1,jev:0,signatures:0});assert.ok(cancelled.flow.draft);assert.equal(cancelled.flow.authorization,undefined);
});
test('expired same-context review is renewed only with explicit readiness, without another model or user signature',async()=>{
  const f=await purchaseEvidenceFixture();f.setChoice('SUPPORTED');const run=new AutomaticPreparation(f.flow,f.clock);await run.run([f.entry.quote.quoteId],'300');f.setTime(1300n);let renewals=0;
  f.flow.recoverReceipt=async confirmation=>{assert.equal(confirmation,true);renewals++;const r=f.flow.reviewResult;if(!r||r.source!=='JEV'||!r.executable)throw Error('LOCAL_PASS_REQUIRED');const {signature:_old,...fields}=r.receipt,unsigned={...fields,expiresAt:'1600'},signature=await f.reviewer.signTypedData(receiptTypedData(unsigned,{chainId:f.deployment.chainId,arbiter:f.deployment.arbiter}));f.flow.invalidateAuthorization();f.flow.reviewResult={...r,receipt:{...unsigned,signature}};return {} as Awaited<ReturnType<typeof f.flow.recoverReceipt>>;};
  assert.equal(await run.run([],'300'),'RECEIPT_EXPIRED');assert.equal(renewals,0);
  // A concrete SIGNED result is required, not merely a changed local expiry.
  const original=f.flow.recoverReceipt;f.flow.recoverReceipt=async confirmation=>{await original(confirmation);return {status:'SIGNED'} as Awaited<ReturnType<typeof original>>;};
  assert.equal(await run.run([],'300',()=>{},true),'READY');assert.equal(renewals,1);assert.deepEqual(f.counts(),{planner:1,jev:1,signatures:0});
});

// These payment lifecycle doubles test orchestration only. Existing wallet,
// durable journal and chain-proof checks are exercised by their own suites.
async function paymentFixture(allowance='0'){
  const f=await originalAuthorizationFixture('10143'),g=f.payload.grant;let now=1000n,approve=0,approvalQueries=0,submit=0,fundingQueries=0;
  let approvalMode:'NORMAL'|'UNKNOWN'|'REVERTED'='NORMAL',fundingMode:'NORMAL'|'UNKNOWN'='NORMAL',changeSession=false;
  const preflight=async()=>({chainId:g.chainId,arbiter:g.arbiter,asset:g.asset,buyer:g.owner,orderId:g.orderId,contextHash:g.contextHash,nonce:g.nonce,amount:g.amount,deadline:g.deadline,state:'UNREGISTERED',consumed:false,revoked:false,transferEligible:true,balance:'100',allowance,blockers:allowance===g.amount?[]:['EXACT_ALLOWANCE_REQUIRED'],block:{number:'100',hash:h(11),timestamp:'1000',finality:'finalized'},canSubmitPayment:false});
  const approval={approve:async()=>{approve++;if(changeSession)throw Error('SESSION_CHANGED');return approvalMode==='UNKNOWN'?{status:'ALREADY_RECORDED',record:{hash:null}}:{hash:h(20)};},reconcile:async()=>{approvalQueries++;return {receipt:approvalMode==='REVERTED'?{status:'REVERTED'}:approvalQueries===1?{status:'PENDING'}:{status:'CONFIRMED',exactAllowance:true}};}} as unknown as AssetApprovalFlow;
  const fundingResult=(status:string)=>({record:{status,hash:h(21)},snapshot:f.snapshot('FUNDED'),canSubmitPayment:false});
  const funding={submit:async()=>{submit++;return fundingResult(fundingMode==='UNKNOWN'?'UNKNOWN':'SUBMITTED');},reconcile:async()=>{fundingQueries++;return fundingResult('CONFIRMED');}} as unknown as OriginalFundingFlow;
  const run=new AutomaticPayment(f.payload,approval,funding,preflight,()=>now,async()=>{},3);
  return {f,g,run,counts:()=>({approve,approvalQueries,submit,fundingQueries}),expire:()=>{now=BigInt(g.deadline);},unknownApproval:()=>{approvalMode='UNKNOWN';},revertedApproval:()=>{approvalMode='REVERTED';},unknownFunding:()=>{fundingMode='UNKNOWN';},changeSession:()=>{changeSession=true;}};
}
test('one explicit payment action waits for the original approval then submits and reconciles original funding exactly once',async()=>{
  const f=await paymentFixture();await assert.rejects(f.run.run(false),/CONFIRMATION_REQUIRED/);assert.deepEqual(f.counts(),{approve:0,approvalQueries:0,submit:0,fundingQueries:0});
  const [a,b]=await Promise.all([f.run.run(true),f.run.run(true)]);assert.equal(a.status,'CONFIRMED');assert.deepEqual(a,b);assert.deepEqual(f.counts(),{approve:1,approvalQueries:2,submit:1,fundingQueries:1});assert.equal((await f.run.run(true)).status,'ATTENTION');assert.equal(f.counts().submit,1);
});
test('accurate existing allowance skips another wallet approval; different nonzero allowance and expiry stop before sends',async()=>{
  const original=await originalAuthorizationFixture('10143'),exact=await paymentFixture(original.payload.grant.amount);assert.equal((await exact.run.run(true)).status,'CONFIRMED');assert.equal(exact.counts().approve,0);
  const different=await paymentFixture('1');assert.equal((await different.run.run(true)).status,'BLOCKED');assert.equal(different.counts().approve,0);assert.equal(different.counts().submit,0);
  const expired=await paymentFixture();expired.expire();assert.equal((await expired.run.run(true)).status,'EXPIRED');assert.equal(expired.counts().approve,0);assert.equal(expired.counts().submit,0);
});
test('unknown or reverted approval, unknown funding and session changes do not reopen a send',async()=>{
  for(const mode of ['unknownApproval','revertedApproval','unknownFunding','changeSession'] as const){const f=await paymentFixture();f[mode]();try{const result=await f.run.run(true);assert.equal(result.status,'ATTENTION');}catch{assert.equal(mode,'changeSession');}
    await f.run.run(true);assert.equal(f.counts().approve,1);assert.equal(f.counts().submit,mode==='unknownFunding'?1:0);assert.equal(f.counts().fundingQueries,0);}
});
