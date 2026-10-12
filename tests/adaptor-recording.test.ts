import test from 'node:test';
import assert from 'node:assert/strict';
import {keccak256,toHex} from 'viem';
import {adaptorSalesRecording as recording} from '../apps/web/src/generated/adaptor-sales-recording.js';
import {inspectRecordedBindings} from '../packages/protocol/src/adaptor-recording.js';
import {readSalesBrief} from '../packages/protocol/src/sales-brief.js';
import {createReport} from '../packages/protocol/src/report.js';

const pass=recording.cases.find(c=>c.decision==='PASS')!;
test('public replay binds the supplied sales brief and all three scenario outcomes',async()=>{
  assert.equal(recording.remoteModelCalls,0);assert.equal(recording.transactions,0);
  for(const item of recording.cases){
    const dataset=JSON.parse(item.request.evidence.taskText).csv.split('\n').slice(1).map((line:string)=>Math.round(Number(line.split(',')[1])*100));
    const brief=readSalesBrief(item.request.evidence.taskText,dataset);assert.ok(brief);
    assert.deepEqual(createReport(brief.dataset),recording.sales.report);
    assert.equal(item.request.intent.datasetHash,recording.sales.report.datasetHash);
    assert.equal(item.evaluation.answers.service.choice,'SUPPORTED');
    assert.equal(item.evaluation.answers.provenance.choice,'SUPPORTED');
    assert.equal(item.certificate!==null,item.decision==='PASS');
    assert.equal(item.state,item.decision==='PASS'?'COMPLETE':'STOPPED');
    assert.ok(Object.values(item.checks).every(Boolean));
    assert.equal(await inspectRecordedBindings(item.certificate,item.request,recording.trust),item.decision==='PASS');
  }
});
test('browser replay rejects changed order, exact answers, missing release and substituted trust',async()=>{
  assert.ok(pass.certificate);
  const order=structuredClone(pass.certificate);order.candidate.orderId=keccak256(toHex('other'));
  const result=structuredClone(pass.certificate);result.evaluation.answers.purpose.confidence=.5;
  const source=structuredClone(pass.request);source.evidence.taskText+=' changed';
  const model=structuredClone(pass.certificate);model.candidate.modelId='other-model';
  for(const proof of [order,result,model,{...pass.certificate,releaseSignature:undefined}])assert.equal(await inspectRecordedBindings(proof,pass.request,recording.trust),false);
  assert.equal(await inspectRecordedBindings(pass.certificate,source,recording.trust),false);
  assert.equal(await inspectRecordedBindings(pass.certificate,pass.request,{...recording.trust,attestor:pass.request.intent.buyer}),false);
  assert.equal(await inspectRecordedBindings(pass.certificate,pass.request,recording.trust),true);
});
