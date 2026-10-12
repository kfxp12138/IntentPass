import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {verifiedCase} from '../apps/web/src/showcase.js';
import {verifiedSales,salesProofSection} from '../apps/web/src/sales-proof.js';
import {transactionLink} from '../apps/web/src/presentation.js';
import {workflowCard,workflowOutputPresentation} from '../apps/web/src/workflow-presentation.js';
import {createReport} from '../packages/protocol/src/report.js';
import {OrderSnapshotSchema,type OrderSnapshot} from '../packages/protocol/src/escrow-read.js';
import {orderSnapshotPresentation} from '../apps/web/src/order-view.js';

const evidence=JSON.parse(readFileSync(new URL('../artifacts/acceptance/general-automation/first-background-purchase.json',import.meta.url),'utf8'));
test('sales purchase presentation is bound to independently verified numeric data, transfers, both votes and preserved review history',()=>{
  const record=JSON.parse(readFileSync(new URL('../artifacts/acceptance/sales-report-purchase/verified-purchase.json',import.meta.url),'utf8')),proof=record.chainProof;
  assert.deepEqual(verifiedSales.dataset,record.dataset);assert.deepEqual(verifiedSales.report,createReport(record.dataset));assert.equal(verifiedSales.orderId,proof.orderId);assert.equal(verifiedSales.taskId,record.taskId);assert.equal(verifiedSales.block,proof.finalizedAnchor.number);assert.equal(verifiedSales.verifiedAt,record.verifiedAt);
  for(const [key,source] of [['funding','funding'],['allocation','allocation'],['payout','withdrawal']] as const)assert.equal(verifiedSales[key],proof.transactions[source].hash);
  assert.equal(verifiedSales.delivery,record.additionalTransactionRecords.DELIVERY_DB_PATH[0].hash);assert.deepEqual(verifiedSales.votes,record.additionalTransactionRecords.VOTE_DB_PATH.map((v:{hash:string})=>v.hash));assert.equal(proof.finalOrder.withdrawn.payee,'10');assert.equal(proof.finalOrder.credits.payee,'0');assert.equal(verifiedSales.amount,'0.000010');
  assert.match(salesProofSection,/first review abstained/);assert.match(salesProofSection,/synthetic/);assert.match(salesProofSection,/\$16,673\.25/);assert.ok(salesProofSection.includes(verifiedSales.payout));
});
test('historical showcase fields stay bound to the public verified purchase and exact token denomination',()=>{
  const proof=evidence.chainProof;
  assert.deepEqual(verifiedCase.dataset,evidence.dataset);assert.deepEqual(verifiedCase.report,(({count,sum,min,max})=>({count,sum,min,max}))(evidence.report));
  assert.equal(verifiedCase.orderId,proof.orderId);assert.equal(verifiedCase.escrow,proof.arbiter);assert.equal(verifiedCase.payee,proof.finalOrder.payee);
  assert.equal(verifiedCase.verifiedAt,evidence.verifiedAt);assert.equal(verifiedCase.block,proof.finalizedAnchor.number);
  for(const [key,transaction] of [['funding','funding'],['allocation','allocation'],['payout','withdrawal']] as const)assert.equal(verifiedCase[key],proof.transactions[transaction].hash);
  assert.equal(verifiedCase.delivery,evidence.additionalTransactionRecords.DELIVERY_DB_PATH[0].hash);
  assert.equal(BigInt(verifiedCase.amount.replace('.','')),BigInt(evidence.paidMinimalUnits));assert.equal(verifiedCase.amount.split('.')[1].length,evidence.assetDecimals);
});
test('workflow names and job IDs cannot introduce markup and unknown states never imply completion',()=>{
  const html=workflowCard({id:'<img src=x onerror=alert(1)>',workflow:'<script>steal()</script>',status:'MADE_UP',step:900,stepCount:2});
  assert.ok(!html.includes('<script>')&&!html.includes('<img'));assert.match(html,/&lt;script&gt;/);assert.match(html,/Unverified/);assert.match(html,/value="0"/);assert.ok(!html.includes('pill success'));
});
test('report completion and partial procurement output do not create a paid result',()=>{
  const report=workflowOutputPresentation({report:createReport([2,4,6])});assert.match(report,/Report result/);assert.ok(!report.includes('/tx/')&&!report.includes('original withdrawal'));
  for(const status of ['UNKNOWN','WAITING','CONFIRMED']){
    const output=workflowOutputPresentation({procurement:{status,orderId:verifiedCase.orderId,payoutHash:'javascript:alert(1)'}});
    assert.ok(!output.includes('href=')&&!output.includes('Original procurement verified'));
  }
  assert.ok(!workflowOutputPresentation({report:{count:'<script>'}}).includes('<script>'));
});
test('confirmed procurement exposes only a validated original payout hash on the Monad explorer',()=>{
  const html=workflowOutputPresentation({procurement:{status:'CONFIRMED',orderId:verifiedCase.orderId,payoutHash:verifiedCase.payout}});
  assert.ok(html.includes(`https://testnet.monadexplorer.com/tx/${verifiedCase.payout}`));assert.match(html,/saved confirmation record/);
  assert.equal(transactionLink('javascript:alert(1)','交易'),'');assert.ok(!transactionLink(verifiedCase.payout,'<script>').includes('<script>'));
});
test('refund and compensation presentation never claims completed report acceptance or payee withdrawal',()=>{
  const original=OrderSnapshotSchema.parse(evidence.chainProof.finalOrder) as OrderSnapshot;
  for(const state of ['ALLOCATED_REFUND','ALLOCATED_COMPENSATION'] as const){
    const html=orderSnapshotPresentation({...original,state,credits:{buyer:'10',payee:'0'},withdrawn:{buyer:'0',payee:'0'}});
    assert.ok(!/class="order-stage done"[^>]*>.*?<\/svg>Acceptance/.test(html));
    assert.ok(!/class="order-stage done"[^>]*>.*?<\/svg>Withdrawal/.test(html));
    assert.match(html,/Credits, allocation and withdrawal are recorded separately/);
  }
});
