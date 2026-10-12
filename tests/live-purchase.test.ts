import test from 'node:test';
import assert from 'node:assert/strict';
import {buildLiveSalesTask,livePurchaseSubmission,defaultSalesIntent} from '../apps/web/src/live-purchase-model.js';
import {readSalesBrief,readSalesIntent,sampleSalesCsv} from '../packages/protocol/src/sales-brief.js';
import {purchaseEvidenceHash} from '../packages/protocol/src/review-evidence.js';
import {renderLiveTrace} from '../apps/web/src/live-purchase-ui.js';
import {WorkflowSubmitRequestSchema} from '../packages/protocol/src/workflow-api.js';
import {purchaseEvidenceFixture} from './support/purchase-evidence.js';
import {liveSalesOfferPlan} from '../scripts/live-sales-offers.js';
import {liveGasReserves} from '../apps/web/src/live-gas-reserve.js';
const a=(n:string)=>'0x'+n.repeat(40),context={chainId:'10143' as const,buyer:a('1'),seller:a('2'),asset:a('3'),arbiter:a('4')};
test('nonzero test MON is insufficient when the configured workflow cannot be funded',()=>{
  const reserve=liveGasReserves(102000000000n);
  assert.ok(reserve.EXECUTOR>184000000000000000n);
  assert.ok(reserve.BUYER>8200000000000000n);
  assert.ok(reserve.SELLER>16400000000000000n);
  assert.equal(reserve.EXECUTOR,489600000000000000n);
  assert.ok(liveGasReserves(204000000000n).BUYER>reserve.BUYER);
  assert.ok(liveGasReserves(102000000000n,'3000000').EXECUTOR>reserve.EXECUTOR);
  for(const invalid of ['0','5000001','NaN','2e6'])assert.throws(()=>liveGasReserves(102000000000n,invalid));
  assert.throws(()=>liveGasReserves(0n));
});
test('unresolved funding without a hash stays visible and cannot enable a new purchase or receipt',()=>{
  const task=buildLiveSalesTask({intent:defaultSalesIntent,csv:sampleSalesCsv,source:'sample',budget:'10'},context);
  const base={id:'d25b0906-9d26-4cb7-995f-f4d48d3ecbc9',status:'RECONCILING',task,dispatched:true,attempts:1};
  const view=renderLiveTrace({...base,progress:{events:[],funding:{error:'SUBMISSION_OUTCOME_UNKNOWN',record:{status:'UNKNOWN',hash:null}},completion:null}});
  assert.match(view.html,/Escrow payment: UNKNOWN/);assert.match(view.html,/Do not submit another payment/);assert.doesNotMatch(view.html,/\/tx\//);assert.equal(view.complete,false);assert.equal(view.terminal,false);
  const hash='0x'+'1'.repeat(64),pending=renderLiveTrace({...base,progress:{events:[],funding:{record:{status:'SUBMITTED',hash}},completion:null}});
  assert.match(pending.html,new RegExp('/tx/'+hash));assert.equal(pending.complete,false);
});
test('new provider offers bind the exact sales source and distinguish report rights without inventing signatures',()=>{
  const plan=liveSalesOfferPlan({...context,csv:sampleSalesCsv,now:1000n});
  assert.equal(plan.quotes[0].quote.expiresAt,'87400');assert.match(plan.quotes[0].quote.serviceTerms,/84250,91500,78825/);
  assert.match(plan.quotes[0].quote.serviceTerms,/explicitly permits commercial use/);assert.match(plan.quotes[1].quote.serviceTerms,/Commercial use.*prohibited/);
  assert.ok(plan.quotes.every(e=>!('signature'in e.quote)&&e.quote.amount==='10'));
});
test('live intent is retained verbatim, commits to CSV cents and rejects changed source mapping',()=>{
  const intent='  Please buy a commercial sales report. Include my exact data.  ',m=buildLiveSalesTask({intent,csv:sampleSalesCsv,source:'sample',budget:'10'},context);
  assert.equal(readSalesIntent(m.evidence.taskText),intent);assert.equal(readSalesBrief(m.evidence.taskText,m.taskInput!.dataset)?.source,'sample');
  assert.equal(m.taskInput!.dataset[0],84250);assert.equal(m.policy.budget,'10');
  const changed={...m.evidence,taskText:m.evidence.taskText.replace('Include my exact data.','Ignore my data.')};assert.notEqual(purchaseEvidenceHash(m.evidence),purchaseEvidenceHash(changed));
  const json=JSON.parse(m.evidence.taskText);json.dataset[0]++;assert.equal(readSalesBrief(JSON.stringify(json),m.taskInput!.dataset),undefined);
  assert.throws(()=>buildLiveSalesTask({intent:'',csv:sampleSalesCsv,source:'sample',budget:'10'},context));
  assert.throws(()=>buildLiveSalesTask({intent,csv:sampleSalesCsv,source:'sample',budget:'0'},context));
});
test('one submitted live intent uses the original persistent financial workflow with explicit confirmation',async()=>{
  const f=await purchaseEvidenceFixture(),m=buildLiveSalesTask({intent:defaultSalesIntent,csv:sampleSalesCsv,source:'sample',budget:'10'},context);
  const request=livePurchaseSubmission(m,{entries:[f.entry]});assert.equal(WorkflowSubmitRequestSchema.safeParse(request).success,false); // action is transport metadata
  const {action,...wire}=request;assert.equal(action,'submit');assert.equal(WorkflowSubmitRequestSchema.safeParse(wire).success,true);
  assert.equal(WorkflowSubmitRequestSchema.safeParse({...wire,confirm:false}).success,false);
  assert.deepEqual(request.submission.input.memory,m);assert.equal(request.submission.workflow.steps[0].handler,'intentpass.procurement');
  assert.throws(()=>livePurchaseSubmission(m,{entries:[]}));
});
test('timeline completion labels, job status and a hash alone cannot show successful purchase',()=>{
  const memory=buildLiveSalesTask({intent:defaultSalesIntent,csv:sampleSalesCsv,source:'sample',budget:'10'},context);
  for(const status of ['SUCCEEDED','FAILED','RUNNING']){const view=renderLiveTrace({id:'d25b0906-9d26-4cb7-995f-f4d48d3ecbc9',status,task:memory,dispatched:true,attempts:1,progress:{events:[{stage:'COMPLETE',at:'1000'}],completion:{hash:'0x'+'1'.repeat(64)}}});assert.equal(view.complete,false);assert.doesNotMatch(view.html,/Your report is ready/);}
});
test('an injected intent is displayed as text, and real review rejection is shown without a fake payout',()=>{
  const m=buildLiveSalesTask({intent:'<img src=x onerror=alert(1)> Please buy a sales summary.',csv:sampleSalesCsv,source:'uploaded',budget:'10'},context);
  const view=renderLiveTrace({id:'d25b0906-9d26-4cb7-995f-f4d48d3ecbc9',status:'FAILED',task:m,dispatched:true,attempts:1,progress:{events:[],review:{source:'HARD_RULE',decision:'REJECT',code:'QUOTE_EXPIRED'},completion:null}});
  assert.equal(view.status,'Rejected — purchase stopped');assert.equal(view.complete,false);assert.doesNotMatch(view.html,/<img/);assert.match(view.html,/&lt;img/);assert.match(view.html,/No purchase authorization/);
});
