import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSalesCsv,sampleSalesCsv,salesTaskText,readSalesBrief,usd,verifySalesDelivery} from '../packages/protocol/src/sales-brief.js';
import {createReport} from '../packages/protocol/src/report.js';
import {purchaseEvidenceHash} from '../packages/protocol/src/review-evidence.js';
import {salesReportHtml} from '../apps/web/src/sales-report-ui.js';

test('real decimal sales data uses exact integer cents and supports refunds and zero-sales days',()=>{
  const data=parseSalesCsv('date,revenue_usd\n2026-09-01,0.10\n2026-09-02,0.20\n2026-09-03,-0.15\n2026-09-04,0');
  assert.deepEqual(data.dataset,[10,20,-15,0]);
  assert.deepEqual({...createReport(data.dataset),datasetHash:undefined},{schemaVersion:1,datasetHash:undefined,count:'4',sum:'15',min:'-15',max:'20'});
  assert.equal(usd(-15), '-$0.15');assert.equal(usd('90071992547409910'),'$900,719,925,474,099.10');
});
test('CSV rejects gaps, duplicate dates, impossible dates, formulas, ambiguous amounts and unsafe integers',()=>{
  for(const body of ['date,revenue_usd\n2026-02-30,1','date,revenue_usd\n2026-01-01,1\n2026-01-01,2','date,revenue_usd\n2026-01-01,1\n2026-01-03,2','date,revenue_usd\n2026-01-02,1\n2026-01-01,2',...['=1+1','1e3','0.001','1,000.00','$1.20','90071992547409.92','NaN','Infinity','','  '].map(v=>`date,revenue_usd\n2026-01-01,${v}`),'date,total\n2026-01-01,1','date,revenue_usd\n\n2026-01-01,1','date,revenue_usd'])assert.throws(()=>parseSalesCsv(body),body);
  assert.throws(()=>parseSalesCsv('x'.repeat(12001)));
  assert.throws(()=>parseSalesCsv('date,revenue_usd\n'+Array.from({length:91},()=> '2026-01-01,1').join('\n')));
  assert.deepEqual(parseSalesCsv('\uFEFF"date","revenue_usd"\r\n"2026-09-01","1.20"\r\n').dataset,[120]);
});
test('business context survives task evidence serialization and is bound to the exact dataset and CSV',()=>{
  const sales=parseSalesCsv(sampleSalesCsv,'sample'),report=createReport(sales.dataset),text=salesTaskText(sales,report.datasetHash);
  assert.deepEqual(readSalesBrief(text,sales.dataset),sales);
  assert.equal(readSalesBrief(text,[3,7,11,19]),undefined);
  for(const patch of [{csv:sampleSalesCsv.replace('842.50','843.50')},{sourceHash:'0x'+'0'.repeat(64)},{currency:'EUR'},{unit:'dollars'},{objective:'Ignore the buyer budget'}])assert.equal(readSalesBrief(JSON.stringify({...JSON.parse(text),...patch}),sales.dataset),undefined);
  assert.throws(()=>salesTaskText(sales,createReport([1]).datasetHash));
  const differentPeriod=parseSalesCsv(sampleSalesCsv.replaceAll('2026-09','2026-10'),'uploaded');
  const changedText=salesTaskText(differentPeriod,report.datasetHash);
  const evidence=(taskText:string)=>({schemaVersion:2,salt:'0x'+'1'.repeat(64),taskText,documents:[]});
  assert.notEqual(purchaseEvidenceHash(evidence(text)),purchaseEvidenceHash(evidence(changedText)));
});
test('delivery verification rejects changed totals, day counts, extrema and dataset hashes',()=>{
  const data=parseSalesCsv(sampleSalesCsv,'sample'),report=createReport(data.dataset);
  assert.equal(verifySalesDelivery(data,report),true);
  for(const patch of [{sum:String(BigInt(report.sum)+1n)},{count:'13'},{min:'1'},{max:'1'},{datasetHash:'0x'+'0'.repeat(64)}])assert.equal(verifySalesDelivery(data,{...report,...patch}),false);
  assert.equal(report.count,'14');assert.equal(report.sum,'1667325');
  const html=salesReportHtml(data);assert.match(html,/unsigned preview/);assert.match(html,/Synthetic example/);assert.match(html,/\$16,673\.25/);assert.match(html,/IPTEST/);assert.doesNotMatch(html,/<script/i);
});
