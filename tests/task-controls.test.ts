import test from 'node:test';
import assert from 'node:assert/strict';
import {attachTaskControls,type ConfirmedTask} from '../apps/web/src/task-ui.js';
import {purchaseEvidenceFixture} from './support/purchase-evidence.js';
import {parseSalesCsv,sampleSalesCsv,salesTaskText,readSalesBrief} from '../packages/protocol/src/sales-brief.js';
// Local DOM controls; the final production wiring is checked separately in Chrome.
function dom(){
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document'),fields=Object.fromEntries(['dataset','buyer','seller','asset','budget'].map(name=>[name,{value:name==='dataset'?'[3, 7, 11, 19]':name==='budget'?'10':'',disabled:false}])),feedback={textContent:''},button={disabled:false},handlers:((event:{preventDefault:()=>void})=>void)[]=[];
  const form={querySelector:(selector:string)=>selector==='button[type="submit"]'?button:fields[selector.match(/^\[name="(\w+)"\]$/)![1]],addEventListener:(_event:string,handler:typeof handlers[number])=>handlers.push(handler)};
  Object.defineProperty(globalThis,'document',{configurable:true,value:{querySelector:(selector:string)=>selector==='#task-form'?form:selector==='#feedback'?feedback:null}});
  return {fields,feedback,button,submit:()=>handlers.forEach(handler=>handler({preventDefault:()=>{}})),close:()=>{if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');}};
}
function valid(d:ReturnType<typeof dom>){Object.assign(d.fields.dataset,{value:'[2, 5, 8]'});d.fields.buyer.value='0x'+'11'.repeat(20);d.fields.seller.value='0x'+'22'.repeat(20);d.fields.asset.value='0x'+'33'.repeat(20);d.fields.budget.value='7';}
async function until(done:()=>boolean){const deadline=Date.now()+3000;while(!done()){if(Date.now()>deadline)throw Error('LOCAL_WALLET_DID_NOT_START');await new Promise(resolve=>setTimeout(resolve,1));}}

test('task controls restore confirmed RAM values across navigation without new policy IDs salts or automatic review',()=>{
  let current:ConfirmedTask|undefined,confirmed=0,d=dom();const port={current:()=>current,locked:()=>false,confirm:(task:ConfirmedTask)=>{current=task;confirmed++;}};
  try{attachTaskControls(port);valid(d);d.submit();assert.equal(confirmed,1);const original=structuredClone(current!);assert.equal(original.policy.budget,'7');assert.deepEqual(original.taskInput.dataset,[2,5,8]);assert.equal(original.evidence.schemaVersion,2);
    d.close();d=dom();attachTaskControls(port);assert.deepEqual(current,original);assert.equal(confirmed,1);assert.equal(d.fields.dataset.value,'[2,5,8]');assert.equal(d.fields.buyer.value,original.taskInput.buyer);assert.equal(d.fields.seller.value,original.taskInput.seller);assert.equal(d.fields.asset.value,original.policy.allowedAsset);assert.equal(d.fields.budget.value,'7');assert.match(d.feedback.textContent,/confirmed task/);d.submit();assert.equal(confirmed,1);assert.deepEqual(current,original);assert.match(d.feedback.textContent,/task is unchanged/);
    d.fields.budget.value='8';assert.deepEqual(current,original);d.submit();assert.equal(confirmed,2);assert.equal(current!.policy.budget,'8');assert.notEqual(current!.policy.taskId,original.policy.taskId);assert.notEqual(current!.evidence.salt,original.evidence.salt);
  }finally{d.close();}
});
test('invalid task submissions retain the original confirmed context even when native form validation is bypassed',()=>{
  const d=dom();let current:ConfirmedTask|undefined,confirmed=0;try{attachTaskControls({current:()=>current,locked:()=>false,confirm:task=>{current=task;confirmed++;}});valid(d);d.submit();const original=structuredClone(current!);
    for(const [name,value] of [['dataset','[3,"invalid"]'],['dataset','[]'],['dataset','[9007199254740992]'],['buyer','not-an-address'],['asset','<script>'],['budget','0'],['budget',String(2n**256n)]] as const){valid(d);d.fields[name].value=value;d.submit();assert.equal(confirmed,1,name);assert.deepEqual(current,original);assert.match(d.feedback.textContent,/Check the dataset/);}
  }finally{d.close();}
});
test('sales source confirmation binds dates and currency, retains unchanged tasks and preserves signing locks',()=>{
  const d=dom();let current:ConfirmedTask|undefined,count=0,locked=false,sourceLocked=false;
  let sales=parseSalesCsv(sampleSalesCsv,'sample');let numeric=false;
  const source={read:()=>numeric?undefined:{dataset:sales.dataset,describe:(hash:string)=>salesTaskText(sales,hash)},lock:(value:boolean)=>{sourceLocked=value;}};
  try{
    attachTaskControls({current:()=>current,locked:()=>locked,confirm:task=>{current=task;count++;}},source);valid(d);d.submit();
    assert.equal(count,1);assert.deepEqual(current!.taskInput.dataset,sales.dataset);assert.ok(readSalesBrief(current!.evidence.taskText,current!.taskInput.dataset));
    const original=structuredClone(current!);d.submit();assert.equal(count,1);assert.deepEqual(current,original);
    sales=parseSalesCsv(sampleSalesCsv.replaceAll('2026-09','2026-10'));d.submit();assert.equal(count,2);assert.equal(current!.policy.datasetHash,original.policy.datasetHash);assert.notEqual(current!.policy.taskId,original.policy.taskId);assert.notEqual(current!.evidence.salt,original.evidence.salt);
    const dated=structuredClone(current!);locked=true;d.submit();assert.equal(sourceLocked,true);assert.equal(count,2);assert.deepEqual(current,dated);
    locked=false;numeric=true;d.fields.dataset.value=JSON.stringify(sales.dataset);d.submit();assert.equal(count,3);assert.equal(readSalesBrief(current!.evidence.taskText,current!.taskInput.dataset),undefined);assert.notEqual(current!.policy.taskId,dated.policy.taskId);
  }finally{d.close();}
});
test('invalid or pending sales source cannot silently confirm stale numeric inputs',()=>{
  const d=dom();let count=0;
  try{attachTaskControls({current:()=>undefined,locked:()=>false,confirm:()=>{count++;}},{read:()=>{throw Error('CSV_NOT_READY');},lock:()=>{}});valid(d);d.submit();assert.equal(count,0);assert.match(d.feedback.textContent,/Check the dataset/);}finally{d.close();}
});
test('task navigation and forced submits cannot discard a real PurchaseFlow owner request while signing or its result remains unknown',async()=>{
  const f=await purchaseEvidenceFixture();f.setChoice('SUPPORTED');await f.flow.catalog();await f.flow.propose([f.entry.quote.quoteId]);await f.flow.review();f.updateEvidence(f.flow.draft!.evidence);const unchanged=dom();let repeated=0;try{attachTaskControls({current:f.task,locked:()=>f.flow.authorizationLocked,confirm:()=>{repeated++;}});unchanged.submit();assert.equal(repeated,0);assert.equal(f.task().evidence.documents.length,2);assert.equal(f.flow.reviewHistory.length,1);assert.deepEqual(f.counts(),{planner:1,jev:1,signatures:0});}finally{unchanged.close();}await f.flow.prepare('0','1200');const original=structuredClone(f.task()),draft=structuredClone(f.flow.draft);let started=false,calls=0,release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});f.session.signGrant=async()=>{started=true;calls++;await gate;throw Error('LOCAL_SIGNATURE_OUTCOME_UNKNOWN');};const signing=f.flow.sign().then(()=>false,()=>true);await until(()=>started);let confirms=0,d=dom();const port={current:f.task,locked:()=>f.flow.authorizationLocked,confirm:()=>{confirms++;}};
  try{attachTaskControls(port);assert.equal(d.button.disabled,true);assert.ok(Object.values(d.fields).every(field=>field.disabled));assert.equal(d.fields.buyer.value,original.taskInput.buyer);valid(d);d.submit();assert.equal(confirms,0);assert.deepEqual(f.task(),original);assert.deepEqual(f.flow.draft,draft);
    release();assert.equal(await signing,true);assert.equal(f.flow.signedAuthorization,undefined);assert.equal(f.flow.authorizationLocked,true);d.close();d=dom();attachTaskControls(port);valid(d);d.submit();assert.equal(confirms,0);assert.deepEqual(f.task(),original);assert.deepEqual(f.flow.draft,draft);assert.match(d.feedback.textContent,/awaiting reconciliation/);await assert.rejects(f.flow.sign(),/OUTCOME_UNKNOWN/);assert.equal(calls,1);assert.deepEqual(f.counts(),{planner:1,jev:1,signatures:0});
  }finally{release();await signing;d.close();}
});
