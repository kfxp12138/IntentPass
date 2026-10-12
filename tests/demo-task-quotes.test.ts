import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync,rmSync,unlinkSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {prepareTaskQuoteBook,inspectQuoteBookSwitch} from '../scripts/demo-task-quotes.js';
import {createReport} from '../packages/protocol/src/report.js';
import {quoteTypedData,termsHash,verifyQuoteSignature} from '../packages/protocol/src/typed-data.js';
import {DemoQuoteBook} from '../apps/web/src/demo-quote-api.js';
const address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
const hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
function fixture(){
  const root=mkdtempSync(join(realpathSync(tmpdir()),'intentpass-task-quotes-'));mkdirSync(join(root,'.tools'),{mode:0o700});
  const seller=privateKeyToAccount(generatePrivateKey()),scope={schemaVersion:1,taskId:hash(1),buyer:address(1),dataset:[3,7,11,19],datasetHash:createReport([3,7,11,19]).datasetHash};
  const options={root,scope,seller:seller.address,asset:address(2),arbiter:address(3),now:1000n};
  return {root,seller,scope,options,close:()=>rmSync(root,{recursive:true,force:true})};
}
test('the original dataset commitment is validated before a quote directory can be created',()=>{
  const f=fixture();try{assert.throws(()=>prepareTaskQuoteBook({...f.options,scope:{...f.scope,datasetHash:hash(9)}}),/ORIGINAL_TASK_DATASET_MISMATCH/);assert.deepEqual(readdirSync(join(f.root,'.tools')),[]);}finally{f.close();}
});
test('a real quote signature cannot be moved to another dataset/task and no raw dataset is published',async()=>{
  const f=fixture();try{
    const first=prepareTaskQuoteBook(f.options),otherDataset=[1,2],second=prepareTaskQuoteBook({...f.options,scope:{...f.scope,taskId:hash(2),dataset:otherDataset,datasetHash:createReport(otherDataset).datasetHash}});
    const domain={chainId:'10143',arbiter:f.options.arbiter},signed={...first.plan.quotes[0].quote,signature:await f.seller.signTypedData(quoteTypedData(first.plan.quotes[0].quote,domain))};
    assert(await verifyQuoteSignature(signed,domain));assert.equal(await verifyQuoteSignature({...second.plan.quotes[0].quote,signature:signed.signature},domain),false);
    for(const {quote} of first.plan.quotes){assert(quote.serviceTerms.includes(f.scope.datasetHash));assert(quote.serviceTerms.includes(f.scope.taskId));assert(quote.serviceTerms.includes(f.scope.buyer));assert(!quote.serviceTerms.includes(JSON.stringify(f.scope.dataset)));}
    assert.equal(first.plan.quotes[0].quote.amount,'10');assert.equal(first.plan.quotes[1].quote.amount,'10');
  }finally{f.close();}
});
test('reruns preserve the exact expired plan and unknown signature reservation',async()=>{
  const f=fixture();try{const first=prepareTaskQuoteBook(f.options),book=new DemoQuoteBook(first.directory,first.catalogue,()=>1001n),principal={subject:'test-seller',wallets:[f.seller.address]};
    book.reserve(first.plan.quotes[0].quote.quoteId,principal);const files=readdirSync(first.directory),bytes=files.map(name=>readFileSync(join(first.directory,name),'utf8'));
    const rerun=prepareTaskQuoteBook({...f.options,now:999999999n});assert.deepEqual(rerun.plan,first.plan);assert.deepEqual(readdirSync(first.directory),files);assert.deepEqual(files.map(name=>readFileSync(join(first.directory,name),'utf8')),bytes);
    await assert.rejects(inspectQuoteBookSwitch({DEMO_QUOTE_DIRECTORY:first.directory,QUOTE_CATALOG_PATH:first.catalogue},join(f.root,'new-book')),/ORIGINAL_SIGNING_UNRESOLVED/);
  }finally{f.close();}
});
test('a completed book can be retained during an explicit switch without modifying any original records',async()=>{
  const f=fixture();try{const first=prepareTaskQuoteBook({...f.options,now:BigInt(Math.floor(Date.now()/1000))}),book=new DemoQuoteBook(first.directory,first.catalogue),principal={subject:'test-seller',wallets:[f.seller.address]},domain={chainId:'10143',arbiter:f.options.arbiter};
    for(const {quote} of first.plan.quotes){book.reserve(quote.quoteId,principal);await book.record({...quote,signature:await f.seller.signTypedData(quoteTypedData(quote,domain))},principal);}
    const files=readdirSync(first.directory),bytes=files.map(name=>readFileSync(join(first.directory,name),'utf8'));
    await inspectQuoteBookSwitch({DEMO_QUOTE_DIRECTORY:first.directory,QUOTE_CATALOG_PATH:first.catalogue},join(f.root,'new-book'));
    assert.deepEqual(files.map(name=>readFileSync(join(first.directory,name),'utf8')),bytes);
    await assert.rejects(inspectQuoteBookSwitch({DEMO_QUOTE_DIRECTORY:first.directory,QUOTE_CATALOG_PATH:join(first.directory,'another.json')},join(f.root,'new-book')),/ORIGINAL_CATALOGUE_REQUIRED/);
  }finally{f.close();}
});
test('changed task data, tampered terms, or a missing plan with an unknown slot never regenerate inputs',()=>{
  const f=fixture();try{const first=prepareTaskQuoteBook(f.options),planFile=join(first.directory,'plan.json'),original=readFileSync(planFile,'utf8');
    assert.throws(()=>prepareTaskQuoteBook({...f.options,scope:{...f.scope,dataset:[1,2],datasetHash:createReport([1,2]).datasetHash}}),/EXISTING_TASK_SCOPE_MISMATCH/);assert.equal(readFileSync(planFile,'utf8'),original);
    const tampered=structuredClone(first.plan);tampered.quotes[0].quote.serviceTerms='Unbound generic report';tampered.quotes[0].quote.serviceTermsHash=termsHash(tampered.quotes[0].quote.serviceTerms);writeFileSync(planFile,JSON.stringify(tampered),{mode:0o600});
    assert.throws(()=>prepareTaskQuoteBook(f.options),/EXISTING_TASK_SCOPE_MISMATCH/);
    unlinkSync(planFile);writeFileSync(join(first.directory,'original.reserved.json'),'{}',{mode:0o600});assert.throws(()=>prepareTaskQuoteBook(f.options),/ORIGINAL_PLAN_REQUIRED/);assert.equal(readdirSync(first.directory).includes('plan.json'),false);
  }finally{f.close();}
});
