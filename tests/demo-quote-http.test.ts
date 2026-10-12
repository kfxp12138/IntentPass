import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {DemoQuoteBook} from '../apps/web/src/demo-quote-api.js';
import {AuthenticationRejected} from '../packages/adapters/src/privy-auth.js';
import {createApp} from '../apps/web/src/server.js';
import {termsHash,quoteTypedData} from '../packages/protocol/src/typed-data.js';
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as `0x${string}`;
test('quote API authenticates seller mutations, rejects duplicate/body changes and publishes only verified original signatures',async()=>{
  const directory=mkdtempSync(join(realpathSync(tmpdir()),'intentpass-quote-http-')),seller=privateKeyToAccount(generatePrivateKey()),catalogue=join(directory,'catalogue.json');
  const make=(n:number)=>{const serviceTerms='Test report '+n;return {schemaVersion:1 as const,quoteId:'0x'+String(n).padStart(64,'0'),service:'dataset-report' as const,seller:seller.address,payee:seller.address,asset:a(1),amount:'10',serviceTerms,serviceTermsHash:termsHash(serviceTerms),expiresAt:'2000'};};const quotes=[make(1),make(2)];
  writeFileSync(join(directory,'plan.json'),JSON.stringify({schemaVersion:1,planId:randomUUID(),chainId:'10143',arbiter:a(2),asset:a(1),seller:seller.address,assetSymbol:'IPTEST',assetDecimals:6,quotes:[{label:'完整报告许可',quote:quotes[0]},{label:'仅代码许可',quote:quotes[1]}]}),{mode:0o600});writeFileSync(catalogue,'{"entries":[]}',{mode:0o600});
  const api={book:new DemoQuoteBook(directory,catalogue,()=>1000n),auth:{authenticate:async(token:string)=>{if(token==='seller')return {subject:'seller-user',wallets:[seller.address]};if(token==='other')return {subject:'other-user',wallets:[a(99)]};throw new AuthenticationRejected();}}};
  const app=await createApp({webMode:'production',demoQuoteApi:api}),server=app.server;
  try{
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const address=server.address();assert.ok(address&&typeof address==='object');const base='http://127.0.0.1:'+address.port;
    const request=(path:string,token?:string,body?:unknown)=>fetch(base+'/api/demo-quotes'+(path==='/'?'':path),{method:body===undefined?'GET':'POST',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
    assert.equal((await request('/')).status,401);assert.equal((await request('/','invalid')).status,401);assert.equal((await(await request('/','other')).json()).canSign,false);
    assert.equal((await request('/reserve','other',{quoteId:quotes[0].quoteId})).status,403);
    assert.equal((await request('/reserve','seller',`{"quoteId":"${quotes[0].quoteId}","quoteId":"${quotes[1].quoteId}"}`)).status,409);
    assert.equal((await request('/reserve','seller','x'.repeat(65537))).status,413);
    for(const q of quotes){assert.equal((await(await request('/reserve','seller',{quoteId:q.quoteId})).json()).created,true);assert.equal((await(await request('/reserve','seller',{quoteId:q.quoteId})).json()).created,false);const signature=await seller.signTypedData(quoteTypedData(q,{chainId:'10143',arbiter:a(2)}));assert.equal((await request('/record','seller',{quote:{...q,amount:'11',signature}})).status,409);assert.equal((await request('/record','seller',{quote:{...q,signature}})).status,200);}
    assert.equal((await(await request('/','seller')).json()).catalogReady,true);
  }finally{await app.close();rmSync(directory,{recursive:true,force:true});}
});
