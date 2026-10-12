import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,realpathSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {DemoQuoteBook} from '../apps/web/src/demo-quote-api.js';
import {FileQuoteCatalog} from '../apps/web/src/catalog-api.js';
import {quoteTypedData,termsHash} from '../packages/protocol/src/typed-data.js';
import {DemoQuotePlanSchema} from '../packages/protocol/src/demo-quotes.js';
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as `0x${string}`;
function fixture(){
  const directory=mkdtempSync(join(realpathSync(tmpdir()),'intentpass-demo-quote-')),seller=privateKeyToAccount(generatePrivateKey()),other=privateKeyToAccount(generatePrivateKey()),catalogue=join(directory,'catalogue.json');
  const quote=(n:number)=>{const serviceTerms='Test report terms '+n;return {schemaVersion:1,quoteId:'0x'+String(n).padStart(64,'0'),service:'dataset-report',seller:seller.address,payee:seller.address,asset:a(8),amount:'10',serviceTerms,serviceTermsHash:termsHash(serviceTerms),expiresAt:'2000'};};
  const plan=DemoQuotePlanSchema.parse({schemaVersion:1,planId:randomUUID(),chainId:'10143',arbiter:a(9),asset:a(8),seller:seller.address,assetSymbol:'IPTEST',assetDecimals:6,quotes:[{label:'完整报告许可',quote:quote(1)},{label:'仅代码许可',quote:quote(2)}]});
  writeFileSync(join(directory,'plan.json'),JSON.stringify(plan),{mode:0o600});writeFileSync(catalogue,'{"entries":[]}',{mode:0o600});let now=1000n;
  const book=new DemoQuoteBook(directory,catalogue,()=>now),principal={subject:'verified-seller',wallets:[seller.address]},foreign={subject:'other',wallets:[other.address]},domain={chainId:'10143',arbiter:a(9)};
  const sign=async(i:number,account=seller)=>({...plan.quotes[i].quote,signature:await account.signTypedData(quoteTypedData(plan.quotes[i].quote,domain))});
  return {directory,catalogue,plan,book,principal,foreign,domain,seller,other,sign,time:(n:bigint)=>{now=n;},close:()=>rmSync(directory,{recursive:true,force:true})};
}
test('only the declared seller can reserve and each quote has one durable original slot across restart',async()=>{
  const f=fixture();try{const id=f.plan.quotes[0].quote.quoteId;assert.throws(()=>f.book.reserve(id,f.foreign),/SELLER_LOGIN_REQUIRED/);assert.equal(readdirSync(f.directory).some(x=>x.endsWith('.reserved.json')),false);
    assert.equal(f.book.reserve(id,f.principal).created,true);assert.equal(f.book.reserve(id,f.principal).created,false);const restarted=new DemoQuoteBook(f.directory,f.catalogue,()=>1000n);assert.equal(restarted.reserve(id,f.principal).created,false);assert.equal((await restarted.status(f.principal)).quotes[0].status,'RESERVED');
  }finally{f.close();}
});
test('two real signatures publish the exact catalogue atomically and an existing catalogue reader sees the update',async()=>{
  const f=fixture();try{const reader=new FileQuoteCatalog(f.catalogue);assert.equal((await reader.list()).entries.length,0);for(let i=0;i<2;i++){f.book.reserve(f.plan.quotes[i].quote.quoteId,f.principal);await f.book.record(await f.sign(i),f.principal);if(i===0)assert.equal((await reader.list()).entries.length,0);}
    const state=await f.book.status(f.principal);assert.equal(state.catalogReady,true);assert.equal((await reader.list()).entries.length,2);assert.equal((await reader.get(f.plan.quotes[0].quote.quoteId))?.quote.seller,f.seller.address);
    await f.book.record(await f.sign(0),f.principal);assert.equal((await reader.list()).entries.length,2);
  }finally{f.close();}
});
test('signature substitution and any changed amount asset payee expiry or terms cannot enter the catalogue',async()=>{
  const f=fixture();try{f.book.reserve(f.plan.quotes[0].quote.quoteId,f.principal);await assert.rejects(f.book.record(await f.sign(0,f.other),f.principal),/SIGNATURE_INVALID/);const signed=await f.sign(0);
    for(const change of [{amount:'11'},{asset:a(99)},{payee:a(99)},{expiresAt:'2001'},{serviceTerms:'Changed text'}])await assert.rejects(f.book.record({...signed,...change},f.principal),/SCOPE_MISMATCH/);
    assert.equal((await f.book.status(f.principal)).quotes[0].status,'RESERVED');assert.equal(JSON.parse(readFileSync(f.catalogue,'utf8')).entries.length,0);
  }finally{f.close();}
});
test('a signature for another contract and an unreserved or foreign-subject signature are rejected',async()=>{
  const f=fixture();try{const q=f.plan.quotes[0].quote;await assert.rejects(f.book.record(await f.sign(0),f.principal));f.book.reserve(q.quoteId,f.principal);const signature=await f.seller.signTypedData(quoteTypedData(q,{...f.domain,arbiter:a(99)}));await assert.rejects(f.book.record({...q,signature},f.principal),/SIGNATURE_INVALID/);await assert.rejects(f.book.record(await f.sign(0),{...f.principal,subject:'different-subject'}),/RESERVATION_MISMATCH/);}finally{f.close();}
});
test('expiry stops new signatures and unknown original slots remain reserved',async()=>{
  const f=fixture();try{f.book.reserve(f.plan.quotes[0].quote.quoteId,f.principal);f.time(2000n);await assert.rejects(f.book.record(await f.sign(0),f.principal),/SIGNATURE_INVALID/);assert.throws(()=>f.book.reserve(f.plan.quotes[1].quote.quoteId,f.principal),/EXPIRED/);assert.equal((await f.book.status(f.principal)).quotes[0].status,'RESERVED');}finally{f.close();}
});
test('private record tampering cannot be reported as a valid signature on restart',async()=>{
  const f=fixture();try{f.book.reserve(f.plan.quotes[0].quote.quoteId,f.principal);const q=await f.sign(0);await f.book.record(q,f.principal);writeFileSync(join(f.directory,q.quoteId.slice(2)+'.signed.json'),JSON.stringify({...q,signature:'0x'+'00'.repeat(65)}));const restarted=new DemoQuoteBook(f.directory,f.catalogue,()=>1000n);await assert.rejects(restarted.status(f.principal),/RECORD_SIGNATURE_INVALID/);}finally{f.close();}
});
test('changed plan or another catalogue path cannot repurpose the signed quote book',async()=>{
  const f=fixture();try{assert.throws(()=>new DemoQuoteBook(f.directory,join(f.directory,'other.json'),()=>1000n),/CATALOGUE_PATH_INVALID/);const changed=structuredClone(f.plan);changed.quotes[0].quote.expiresAt='2001';writeFileSync(join(f.directory,'plan.json'),JSON.stringify(changed));await assert.rejects(f.book.status(f.principal),/PLAN_CHANGED/);}finally{f.close();}
});
