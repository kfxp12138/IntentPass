import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {generateKeyPairSync} from 'node:crypto';
import {PrivyClient} from '@privy-io/node';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {type Hex} from 'viem';
import {PrivyReceiptSigner,receiptPolicy} from '../packages/adapters/src/privy-receipt-signer.js';
import {ReceiptStore} from '../packages/storage/src/receipt-store.js';
import {receiptTypedData,receiptHash,verifyReceiptSignature} from '../packages/protocol/src/typed-data.js';
import {questionConfigHash} from '../packages/adapters/src/jev-review.js';
import {configuredPurchaseApis} from '../apps/web/src/configured-purchase-api.js';
import {configuredReviewer} from '../apps/web/src/configured-reviewer.js';
import type {BrowserApi} from '../apps/web/src/browser-api.js';
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Hex,h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'intentpass-receipt-')),path=join(dir,'receipts.db'),store=new ReceiptStore(path),account=privateKeyToAccount(generatePrivateKey());
  const config={chainId:'10143' as const,arbiter:a(2),address:account.address,model:'jev-1.13.0',questionConfigHash:questionConfigHash(.9),walletId:'review-wallet',policyId:'review-policy',signerId:'review-signer',authorizationPrivateKey:'local-unused'};
  const domain={chainId:config.chainId,arbiter:config.arbiter},receipt={schemaVersion:1 as const,contextHash:h(1),purchaseEvidenceCommitment:h(3),policyHash:h(4),reviewer:account.address,modelId:config.model,questionConfigHash:config.questionConfigHash,decision:'PASS' as const,expiresAt:'1300'};
  const wallet={id:config.walletId,chain_type:'ethereum',address:account.address,owner_id:config.signerId,policy_ids:[config.policyId],additional_signers:[] as {signer_id:string;override_policy_ids:string[]}[]},policy={...receiptPolicy({chainId:config.chainId,arbiter:config.arbiter,address:config.address,model:config.model,questionConfigHash:config.questionConfigHash}),id:config.policyId};let calls=0,reads=0,lose=false,bad=false,time=1000n;
  const client={wallets:()=>({get:async()=>{reads++;return wallet;},ethereum:()=>({signTypedData:async()=>{calls++;if(lose)throw new Error('private SDK diagnostics');return {encoding:'hex',signature:await account.signTypedData(receiptTypedData(bad?{...receipt,policyHash:h(99)}:receipt,domain))};}})}),policies:()=>({get:async()=>policy})} as unknown as PrivyClient;
  return {dir,path,store,account,config,domain,receipt,wallet,policy,client,signer:new PrivyReceiptSigner(client,config,store,()=>time),calls:()=>calls,reads:()=>reads,lose:()=>{lose=true;},bad:()=>{bad=true;},time:(value:bigint)=>{time=value;},close:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('reviewer signer verifies exact receipt and durable global context slot survives restart without raw signature or evidence',async()=>{
  const x=fixture();try{const signature=await x.signer.sign(x.receipt,x.domain);assert.ok(await verifyReceiptSignature({...x.receipt,signature},x.domain));assert.equal(x.calls(),1);assert.equal(x.store.get(x.domain,h(1))!.status,'SIGNED');await assert.rejects(x.signer.sign(x.receipt,x.domain),/LOCKED/);assert.equal(x.reads(),1);
    x.store.close();const restarted=new ReceiptStore(x.path);try{await assert.rejects(new PrivyReceiptSigner(x.client,x.config,restarted,()=>1000n).sign({...x.receipt,expiresAt:'1299'},x.domain),/LOCKED/);assert.equal(x.calls(),1);}finally{restarted.close();}
    const bytes=readFileSync(x.path);assert.equal(bytes.includes(Buffer.from(signature)),false);assert.equal(bytes.includes(Buffer.from('private SDK diagnostics')),false);
  }finally{rmSync(x.dir,{recursive:true,force:true});}
});
test('reviewer scope rejects changed domain authority model rule decision expiry and broader remote policies before signing',async()=>{
  const x=fixture();try{
    for(const changed of [{reviewer:a(99)},{modelId:'jev-9.9.9'},{questionConfigHash:h(99)},{decision:'REJECT'},{expiresAt:'1000'},{expiresAt:'1301'},{privateKey:'forbidden'}])await assert.rejects(x.signer.sign({...x.receipt,...changed} as typeof x.receipt,x.domain));
    for(const changed of [{chainId:'143'},{arbiter:a(99)}])await assert.rejects(x.signer.sign(x.receipt,{...x.domain,...changed}));assert.equal(x.calls(),0);assert.equal(x.reads(),0);
    x.policy.rules[0].conditions[0].value='143';await assert.rejects(x.signer.sign(x.receipt,x.domain));assert.equal(x.calls(),0);assert.equal(x.store.get(x.domain,h(1)),undefined);
    x.policy.rules[0].conditions[0].value='10143';x.wallet.owner_id='other';x.wallet.additional_signers=[{signer_id:x.config.signerId,override_policy_ids:[]}];await assert.rejects(x.signer.sign(x.receipt,x.domain));assert.equal(x.calls(),0);
    x.wallet.additional_signers[0].override_policy_ids=[x.config.policyId];await x.signer.sign(x.receipt,x.domain);assert.equal(x.calls(),1);
  }finally{x.close();}
});
test('reviewer unknown and substituted signatures retain permanent send lock across instances and never expose provider diagnostics',async()=>{
  for(const mode of ['lost','wrong'] as const){const x=fixture();try{mode==='lost'?x.lose():x.bad();await assert.rejects(x.signer.sign(x.receipt,x.domain),/^Error: RECEIPT_SIGNING_OUTCOME_UNKNOWN$/);assert.equal(x.store.get(x.domain,h(1))!.status,'UNKNOWN');await assert.rejects(new PrivyReceiptSigner(x.client,x.config,x.store,()=>1000n).sign(x.receipt,x.domain),/LOCKED/);assert.equal(x.calls(),1);}finally{x.close();}}
});
test('actual Privy SDK serializes one fixed receipt RPC with authorization and no retry on connection loss',async()=>{
  const x=fixture();try{
    const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),config={...x.config,authorizationPrivateKey:privateKey.export({type:'pkcs8',format:'der'}).toString('base64')};let rpc=0;
    const client=new PrivyClient({appId:'test-app',appSecret:'local-only',maxRetries:0,logLevel:'off',fetch:async(input,init)=>{
      const path=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url).pathname;let body:unknown;
      if(path==='/v1/wallets/review-wallet')body=x.wallet;else if(path==='/v1/policies/review-policy')body=x.policy;else{assert.equal(path,'/v1/wallets/review-wallet/rpc');rpc++;const request=JSON.parse(String(init?.body)),headers=new Headers(init?.headers);assert.equal(request.method,'eth_signTypedData_v4');assert.equal(headers.get('privy-idempotency-key'),receiptHash(x.receipt,x.domain));assert.ok(headers.get('privy-authorization-signature'));assert.equal(request.params.typed_data.primary_type,'DecisionReceipt');assert.equal(request.params.typed_data.domain.chainId,10143);assert.equal(request.params.typed_data.domain.name,'IntentPass.Receipt');assert.equal(request.params.typed_data.message.expiresAt,'1300');assert.equal(request.params.typed_data.message.decision,'PASS');throw new Error('lost local response');}
      return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
    }});
    const signer=new PrivyReceiptSigner(client,config,x.store,()=>1000n);await assert.rejects(signer.sign(x.receipt,x.domain),/OUTCOME_UNKNOWN/);await assert.rejects(signer.sign(x.receipt,x.domain),/LOCKED/);assert.equal(rpc,1);
  }finally{x.close();}
});
test('reviewer configuration is opt-in and incomplete requests never silently enable financial signing',()=>{
  assert.deepEqual(configuredPurchaseApis({},undefined),{});
  for(const name of ['PRIVY_REVIEWER_WALLET_ID','PRIVY_REVIEWER_POLICY_ID','PRIVY_REVIEWER_SIGNER_ID','PRIVY_REVIEWER_AUTHORIZATION_PRIVATE_KEY','REVIEW_RECEIPT_DB_PATH'])assert.throws(()=>configuredPurchaseApis({[name]:'local'},undefined),/CONFIGURATION_INVALID/);
});
test('two independent reviewer connections race for one context and only one can request a signature',async()=>{
  const x=fixture(),other=new ReceiptStore(x.path);try{
    const competing=new PrivyReceiptSigner(x.client,x.config,other,()=>1000n);
    const results=await Promise.allSettled([x.signer.sign(x.receipt,x.domain),competing.sign(x.receipt,x.domain)]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(x.calls(),1);
    assert.equal(other.get(x.domain,h(1))!.status,'SIGNED');
  }finally{other.close();x.close();}
});
test('reviewer expiry or clock rollback during metadata reads stops before reserving or requesting signature',async()=>{
  for(const time of [999n,1300n]){const x=fixture();try{
    const client={wallets:()=>({get:async()=>{x.time(time);return x.wallet;}}),policies:()=>({get:async()=>x.policy})} as unknown as PrivyClient;
    await assert.rejects(new PrivyReceiptSigner(client,x.config,x.store,()=>time===999n?999n:1300n).sign(x.receipt,x.domain));
    assert.equal(x.calls(),0);assert.equal(x.store.get(x.domain,h(1)),undefined);
    let reads=0;
    await assert.rejects(new PrivyReceiptSigner(client,x.config,x.store,()=>reads++===0?1000n:time).sign(x.receipt,x.domain),/LOCKED/);
    assert.equal(x.calls(),0);assert.equal(x.store.get(x.domain,h(1)),undefined);
  }finally{x.close();}}
});
test('reviewer factory requires separate wallet policy and authority with an explicit durable database',()=>{
  const x=fixture();try{
    const env={PRIVY_APP_ID:'test-app',PRIVY_APP_SECRET:'local-only',PRIVY_WALLET_ID:'executor-wallet',PRIVY_POLICY_ID:'executor-policy',PRIVY_REVIEWER_WALLET_ID:x.config.walletId,PRIVY_REVIEWER_POLICY_ID:x.config.policyId,PRIVY_REVIEWER_SIGNER_ID:x.config.signerId,PRIVY_REVIEWER_AUTHORIZATION_PRIVATE_KEY:'local-unused',REVIEW_RECEIPT_DB_PATH:join(x.dir,'factory.db')};
    const browser={configuration:{recoveryDeployment:{chainId:'10143',arbiter:a(2),reviewer:x.account.address,executor:a(5)}}} as BrowserApi;
    const rule={model:x.config.model,questionConfigHash:x.config.questionConfigHash};
    const result=configuredReviewer(env,browser,rule);assert.equal(result.signer.address,x.account.address.toLowerCase());result.close();
    for(const changed of [{PRIVY_REVIEWER_WALLET_ID:'executor-wallet'},{PRIVY_REVIEWER_POLICY_ID:'executor-policy'},{REVIEW_RECEIPT_DB_PATH:'relative.db'}])assert.throws(()=>configuredReviewer({...env,...changed},browser,rule),/CONFIGURATION_INVALID/);
    browser.configuration.recoveryDeployment!.executor=x.account.address;assert.throws(()=>configuredReviewer(env,browser,rule),/CONFIGURATION_INVALID/);
  }finally{x.close();}
});
