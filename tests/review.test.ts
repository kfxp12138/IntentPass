import test from 'node:test';
import assert from 'node:assert/strict';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {JevHttp,type JevPort,type JevResult,questionConfigHash} from '../packages/adapters/src/jev-review.js';
import {purchaseEvidenceHash} from '../packages/protocol/src/review-evidence.js';
import {ReviewService,type ReceiptSigner} from '../apps/web/src/services/review.js';
import {policyHash,termsHash,quoteTypedData,receiptTypedData,verifyReceiptSignature} from '../packages/protocol/src/typed-data.js';
import {ALLOCATION_POLICY,RELEASE_POLICY,DELIVERY_SCHEMA,ZERO_HASH} from '../packages/protocol/src/escrow.js';
import {PrivyClient} from '@privy-io/node';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ReceiptStore} from '../packages/storage/src/receipt-store.js';
import {PrivyReceiptSigner,receiptPolicy} from '../packages/adapters/src/privy-receipt-signer.js';
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as `0x${string}`,h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as `0x${string}`;
function response(choice:'SUPPORTED'|'CONTRADICTED'|'INSUFFICIENT'='SUPPORTED',confidence=1):JevResult {
  const item={type:'choice' as const,choice,confidence,probabilities:{SUPPORTED:choice==='SUPPORTED'?1:0,CONTRADICTED:choice==='CONTRADICTED'?1:0,INSUFFICIENT:choice==='INSUFFICIENT'?1:0}};
  return {model:'jev-1.13.0',answers:{service:{...item},purpose:{...item},provenance:{...item}},usage:{input_tokens:100,output_tokens:10}};
}
async function harness(createSigner?:(account:ReturnType<typeof privateKeyToAccount>,deployment:{chainId:string;arbiter:string})=>ReceiptSigner) {
  const seller=privateKeyToAccount(generatePrivateKey()),reviewer=privateKeyToAccount(generatePrivateKey());
  const deployment={chainId:'10143',arbiter:a(5),asset:a(6),gate:a(7),reviewer:reviewer.address,committeeHash:h(8)};
  const policy={schemaVersion:1,taskId:h(1),datasetHash:h(2),action:'dataset-report',metrics:['count','sum','min','max'],purpose:'commercial',budget:'15',allowedAsset:deployment.asset,requiredFacts:['service-matches-task','commercial-use-permitted','evidence-belongs-to-service'],version:'1'};
  const evidence={schemaVersion:2,salt:h(55),taskText:'Compute count/sum/min/max for this dataset with commercial report rights.',documents:[{id:'statement',subjectQuoteId:h(3),text:'Current report and commercial rights.'}]};
  const unsigned={schemaVersion:1,quoteId:h(3),service:'dataset-report',seller:seller.address,payee:seller.address,asset:deployment.asset,amount:'10',serviceTerms:'Commercial report use explicitly permitted.',serviceTermsHash:termsHash('Commercial report use explicitly permitted.'),expiresAt:'1500'};
  const quote={...unsigned,signature:await seller.signTypedData(quoteTypedData(unsigned,{chainId:deployment.chainId,arbiter:deployment.arbiter}))};
  const intent={schemaVersion:1,...deployment,orderId:h(4),taskId:policy.taskId,attempt:'1',buyer:a(1),seller:seller.address,payee:seller.address,price:'10',bond:'5',datasetHash:policy.datasetHash,serviceTermsHash:quote.serviceTermsHash,purchaseEvidenceCommitment:purchaseEvidenceHash(evidence),policyHash:policyHash(policy),threshold:2,deliverySchemaHash:DELIVERY_SCHEMA,deliveryDeadline:'1600',settlementDeadline:'2000',allocationPolicyHash:ALLOCATION_POLICY,intentReleasePolicyHash:RELEASE_POLICY,pactPaymentPublicKeyHash:ZERO_HASH};
  // Gate is trusted deployment config, not a field in the frozen intent schema.
  delete (intent as Partial<typeof intent>).gate;
  let calls=0,signs=0,time=1000n,value:unknown=response(),failure:Error|undefined,after:bigint|undefined;
  const jev:JevPort={model:'jev-1.13.0',evaluate:async()=>{calls++;if(after!==undefined)time=after;if(failure)throw failure;return value as JevResult;}};
  const signer:ReceiptSigner={address:reviewer.address,sign:async(receipt,domain)=>{signs++;return reviewer.signTypedData(receiptTypedData(receipt,domain));}};
  const service=new ReviewService(jev,deployment,.9,createSigner?.(reviewer,deployment)??signer,()=>time),input={policy,intent,quote,evidence},principal={subject:'test-user',wallets:[a(1)]};
  return {service,input,principal,deployment,calls:()=>calls,signs:()=>signs,set:(v:unknown)=>{value=v;},fail:(error:Error=new Error('private provider error'))=>{failure=error;},time:(v:bigint)=>{time=v;},after:(v:bigint)=>{after=v;}};
}
test('all three supported judgments produce exact bounded cryptographically verifiable receipt',async()=>{
  const x=await harness(),result=await x.service.review(x.input,x.principal);assert.equal(result.decision,'PASS');assert.equal(result.executable,true);assert.ok('receipt' in result);
  assert.equal(result.receipt.expiresAt,'1300');assert.ok(await verifyReceiptSignature(result.receipt,{chainId:x.deployment.chainId,arbiter:x.deployment.arbiter}));assert.equal(x.signs(),1);
});
test('new review refuses unsalted evidence and altered salt before JEV or receipt signing',async()=>{
  const x=await harness(),{salt:_salt,...legacy}=x.input.evidence;
  assert.deepEqual(await x.service.review({...x.input,evidence:{...legacy,schemaVersion:1}},x.principal),{decision:'REJECT',source:'HARD_RULE',code:'EVIDENCE_SALT_REQUIRED'});
  assert.equal((await x.service.review({...x.input,evidence:{...x.input.evidence,salt:h(66)}},x.principal)).decision,'REJECT');assert.equal(x.signs(),0);assert.equal(x.calls(),0);
});
test('unknown, contradictory, low-confidence and failed JEV cannot sign executable receipts',async()=>{
  for(const [value,decision] of [[response('INSUFFICIENT'),'ABSTAIN'],[response('CONTRADICTED'),'REJECT'],[response('SUPPORTED',.5),'ABSTAIN'],[{model:'jev-1.13.0',answers:{}},'ABSTAIN'],[{...response(),model:'another-model'},'ABSTAIN']] as const){const x=await harness();x.set(value);assert.equal((await x.service.review(x.input,x.principal)).decision,decision);assert.equal(x.signs(),0);assert.equal(x.calls(),1);}
  for(const error of [new Error('private provider error'),new DOMException('local timeout','TimeoutError')]){const x=await harness();x.fail(error);assert.equal((await x.service.review(x.input,x.principal)).decision,'ABSTAIN');assert.equal(x.signs(),0);assert.equal(x.calls(),1);}
});
test('hard failures reject before JEV including budget, owner, quote signature, context and evidence tampering',async()=>{
  const x=await harness();
  for(const input of [{...x.input,intent:{...x.input.intent,bond:'6'}},{...x.input,quote:{...x.input.quote,amount:'11'}},{...x.input,quote:{...x.input.quote,signature:'0x'+'0'.repeat(130)}},{...x.input,intent:{...x.input.intent,chainId:'1'}},{...x.input,evidence:{...x.input.evidence,taskText:'Changed task'}}])assert.equal((await x.service.review(input,x.principal)).decision,'REJECT');
  assert.equal((await x.service.review(x.input,{subject:'stranger',wallets:[a(9)]})).decision,'REJECT');x.time(1500n);assert.equal((await x.service.review(x.input,x.principal)).decision,'REJECT');assert.equal(x.calls(),0);assert.equal(x.signs(),0);
});
test('evidence commitment binds exact content, ID, subject and ordering; question hash binds confidence policy',async()=>{
  const x=await harness(),original=purchaseEvidenceHash(x.input.evidence),document=x.input.evidence.documents[0];
  for(const change of [{id:'different'},{subjectQuoteId:h(9)},{text:document.text+' '}])assert.notEqual(purchaseEvidenceHash({...x.input.evidence,documents:[{...document,...change}]}),original);
  assert.throws(()=>purchaseEvidenceHash({...x.input.evidence,documents:[document,document]}));assert.notEqual(questionConfigHash(.9),questionConfigHash(.8));
});
test('JEV HTTP adapter validates full probability distributions and model and sends one fixed three-question request',async()=>{
  let calls=0;const transport:typeof fetch=async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));assert.equal(body.model,'jev-1.13.0');assert.deepEqual(Object.keys(body.questions),['service','purpose','provenance']);return new Response(JSON.stringify(response()),{headers:{'Content-Type':'application/json'}});};
  assert.equal((await new JevHttp('local-only-key','jev-1.13.0',transport).evaluate({untrusted:'document'})).model,'jev-1.13.0');assert.equal(calls,1);
  assert.throws(()=>new JevHttp('key','jev-latest',transport));
  for(const invalid of [{...response(),model:'jev-1.14.0'},{...response(),answers:{...response().answers,purpose:{...response().answers.purpose,probabilities:{SUPPORTED:.1,CONTRADICTED:.1,INSUFFICIENT:.1}}}}])await assert.rejects(new JevHttp('key','jev-1.13.0',async()=>new Response(JSON.stringify(invalid))).evaluate({}));
});

test('quote expiry during JEV call prevents receipt signing',async()=>{
  const x=await harness();x.after(1500n);const result=await x.service.review(x.input,x.principal);assert.equal(result.decision,'ABSTAIN');assert.equal(x.signs(),0);
});
test('review service reaches restricted Privy signer only after hard and semantic checks and never re-signs context',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'intentpass-review-signer-')),store=new ReceiptStore(join(dir,'receipts.db'));let rpc=0;
  try{
    const x=await harness((account,deployment)=>{
      const config={chainId:'10143' as const,arbiter:deployment.arbiter,address:account.address,model:'jev-1.13.0',questionConfigHash:questionConfigHash(.9),walletId:'review-wallet',policyId:'review-policy',signerId:'review-signer',authorizationPrivateKey:'local-unused'};
      const client={wallets:()=>({get:async()=>({id:config.walletId,address:account.address,chain_type:'ethereum',owner_id:config.signerId,policy_ids:[config.policyId],additional_signers:[]}),ethereum:()=>({signTypedData:async(_id:string,body:{params:{typed_data:{message:Record<string,string>}}})=>{rpc++;return {encoding:'hex',signature:await account.signTypedData(receiptTypedData({...body.params.typed_data.message,schemaVersion:1} as Parameters<typeof receiptTypedData>[0],{chainId:deployment.chainId,arbiter:deployment.arbiter}))};}})}),policies:()=>({get:async()=>({...receiptPolicy({chainId:config.chainId,arbiter:config.arbiter,address:config.address,model:config.model,questionConfigHash:config.questionConfigHash}),id:config.policyId})})} as unknown as PrivyClient;
      return new PrivyReceiptSigner(client,config,store,()=>1000n);
    });
    assert.equal((await x.service.review({...x.input,intent:{...x.input.intent,bond:'6'}},x.principal)).decision,'REJECT');assert.equal(rpc,0);
    x.set(response('INSUFFICIENT'));assert.equal((await x.service.review(x.input,x.principal)).decision,'ABSTAIN');assert.equal(rpc,0);
    x.input.evidence.documents.push({id:'added-license',subjectQuoteId:x.input.quote.quoteId,text:'New explicit commercial report license evidence.'});x.input.intent.purchaseEvidenceCommitment=purchaseEvidenceHash(x.input.evidence);
    x.set(response());const result=await x.service.review(x.input,x.principal);assert.ok('receipt' in result);assert.equal(result.executable,true);assert.ok(await verifyReceiptSignature(result.receipt,{chainId:x.deployment.chainId,arbiter:x.deployment.arbiter}));assert.equal(rpc,1);
    const repeated=await x.service.review(x.input,x.principal);assert.deepEqual(repeated,result);assert.equal(x.calls(),2);assert.equal(rpc,1);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
