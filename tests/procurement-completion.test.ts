import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {writePrivateServiceJsonOnce} from '../scripts/create-privy-service-wallets.js';
import {readProcurementCompletion} from '../apps/worker/src/procurement-completion.js';
const id='2a2dc5f8-7fb2-41ea-ae44-73a664e5c71e',other='d25b0906-9d26-4cb7-995f-f4d48d3ecbc9',hex=(n:string)=>'0x'+n.repeat(64),result={status:'CONFIRMED',orderId:hex('1'),payoutHash:hex('2')},reservation={jobId:id,taskId:hex('3'),scopeHash:'4'.repeat(64)},verified={...result,...reservation,proofHash:'5'.repeat(64),finalizedBlock:'100'};
test('runtime response alone cannot turn a failed procurement into completion; verified records must bind the original job task scope and payout',()=>{
  for(const patch of [undefined,{}, {jobId:other},{taskId:hex('6')},{scopeHash:'7'.repeat(64)},{orderId:hex('8')},{payoutHash:hex('9')}]){
    const root=mkdtempSync(resolve(realpathSync(tmpdir()),'intentpass-completion-')),path=resolve(root,'procurements',id,'evidence-continuation-v1');mkdirSync(path,{recursive:true,mode:0o700});
    try{writePrivateServiceJsonOnce(resolve(path,'continuation-result.json'),result);writePrivateServiceJsonOnce(resolve(path,'continuation-reserved.json'),reservation);if(patch!==undefined)writePrivateServiceJsonOnce(resolve(path,'verified-result.json'),{...verified,...patch});assert.deepEqual(readProcurementCompletion(root,id),patch&&Object.keys(patch).length===0?result:undefined);assert.equal(readProcurementCompletion(root,'../'+id),undefined);}finally{rmSync(root,{recursive:true,force:true});}
  }
});
test('legacy completion stays readable and conflicting continuation outcomes are not reported as paid',()=>{
  const root=mkdtempSync(resolve(realpathSync(tmpdir()),'intentpass-completion-')),legacy=resolve(root,'procurements',id,'review-namespace-recovery-v1'),next=resolve(root,'procurements',id,'evidence-continuation-v1');mkdirSync(legacy,{recursive:true,mode:0o700});mkdirSync(next,{mode:0o700});
  try{writePrivateServiceJsonOnce(resolve(legacy,'recovery-result.json'),result);writePrivateServiceJsonOnce(resolve(legacy,'recovery-reserved.json'),{jobId:id});assert.deepEqual(readProcurementCompletion(root,id),result);const conflict={...result,orderId:hex('8')};writePrivateServiceJsonOnce(resolve(next,'continuation-result.json'),conflict);writePrivateServiceJsonOnce(resolve(next,'continuation-reserved.json'),reservation);writePrivateServiceJsonOnce(resolve(next,'verified-result.json'),{...verified,...conflict});assert.equal(readProcurementCompletion(root,id),undefined);}finally{rmSync(root,{recursive:true,force:true});}
});
