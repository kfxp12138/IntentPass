import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { hashStruct, verifyTypedData } from 'viem';
import { policyHash, termsHash, quoteTypedData, receiptTypedData, receiptHash, grantTypedData,
  contextHash, quoteSigningHash, grantSigningHash, verifyQuoteSignature, verifyReceiptSignature, verifyGrantSignature } from '../packages/protocol/src/index.js';
const digest=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
const addr=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
const deployment={chainId:'31337',arbiter:addr(1)};
const policy={schemaVersion:1,taskId:digest(1),datasetHash:digest(2),action:'dataset-report',
  metrics:['count','sum','min','max'],purpose:'commercial',budget:'10',allowedAsset:addr(2),
  requiredFacts:['service-matches-task','commercial-use-permitted','evidence-belongs-to-service'],version:'1'};
const seller=privateKeyToAccount(generatePrivateKey());
const reviewer=privateKeyToAccount(generatePrivateKey());
const buyer=privateKeyToAccount(generatePrivateKey());
const quote={schemaVersion:1,quoteId:digest(3),service:'dataset-report',seller:seller.address,payee:seller.address,
  asset:addr(2),amount:'10',serviceTerms:'Commercial use of this report is permitted.',
  serviceTermsHash:termsHash('Commercial use of this report is permitted.'),expiresAt:'2000000000'};
const receipt={schemaVersion:1,contextHash:digest(4),purchaseEvidenceCommitment:digest(5),policyHash:policyHash(policy),
  reviewer:reviewer.address,modelId:'local-crypto-fixture-only',questionConfigHash:digest(6),decision:'PASS',expiresAt:'2000000000'};
const grant={schemaVersion:1,owner:buyer.address,executor:addr(7),chainId:deployment.chainId,arbiter:deployment.arbiter,
  orderId:digest(8),asset:quote.asset,amount:quote.amount,contextHash:receipt.contextHash,
  preparationHash:digest(9),receiptHash:receiptHash(receipt,deployment),nonce:'0',deadline:'2000000000',maxUses:1};

test('frozen authorization vectors match TypeScript; Solidity independently checks the same fixture',()=>{
  const v=JSON.parse(readFileSync('fixtures/dev/authorization-vector.json','utf8'));
  assert.equal(policyHash(v.policy),v.hashes.policy);
  assert.equal(quoteSigningHash(v.quote,v.deployment),v.hashes.quoteSigning);
  assert.equal(receiptHash(v.receipt,v.deployment),v.hashes.receiptSigning);
  assert.equal(grantSigningHash(v.grant),v.hashes.grantSigning);
  const q=quoteTypedData(v.quote,v.deployment),r=receiptTypedData(v.receipt,v.deployment),g=grantTypedData(v.grant);
  assert.equal(hashStruct({data:q.message,types:q.types,primaryType:q.primaryType}),v.hashes.quoteStruct);
  assert.equal(hashStruct({data:r.message,types:r.types,primaryType:r.primaryType}),v.hashes.receiptStruct);
  assert.equal(hashStruct({data:g.message,types:g.types,primaryType:g.primaryType}),v.hashes.grantStruct);
});

test('policy commitment ignores object-key order and binds every variable requirement',()=>{
  const reordered=Object.fromEntries(Object.entries(policy).reverse());
  assert.equal(policyHash(reordered),policyHash(policy));
  for(const changed of [{budget:'11'},{datasetHash:digest(99)},{allowedAsset:addr(99)},{taskId:digest(99)},{version:'2'}]) {
    assert.notEqual(policyHash({...policy,...changed}),policyHash(policy));
  }
  assert.throws(()=>policyHash({...policy,requiredFacts:['service-matches-task']}));
});
test('signed quote is valid only for original seller, terms, amount, payee, chain and arbiter',async()=>{
  const signature=await seller.signTypedData(quoteTypedData(quote,deployment));
  assert.equal(await verifyQuoteSignature({...quote,signature},deployment),true);
  for(const changed of [{seller:buyer.address},{payee:buyer.address},{amount:'11'},{asset:addr(99)},{expiresAt:'2000000001'},
    {serviceTerms:'Analysis code is open source.'}, {serviceTerms:'Analysis code is open source.',serviceTermsHash:termsHash('Analysis code is open source.')}]) {
    assert.equal(await verifyQuoteSignature({...quote,...changed,signature},deployment),false);
  }
  assert.equal(await verifyQuoteSignature({...quote,signature},{...deployment,chainId:'1'}),false);
  assert.equal(await verifyQuoteSignature({...quote,signature},{...deployment,arbiter:addr(99)}),false);
});
test('terms digest uses exact UTF-8 text and quote builder rejects substituted plaintext',()=>{
  assert.notEqual(termsHash(quote.serviceTerms),termsHash(quote.serviceTerms+' '));
  assert.throws(()=>quoteTypedData({...quote,serviceTerms:'No commercial use.'},deployment),/QUOTE_TERMS_MISMATCH/);
});
test('receipt binds reviewer, evidence, policy, model, questions and PASS',async()=>{
  const signature=await reviewer.signTypedData(receiptTypedData(receipt,deployment));
  assert.equal(await verifyReceiptSignature({...receipt,signature},deployment),true);
  for(const changed of [{reviewer:seller.address},{contextHash:digest(99)},{purchaseEvidenceCommitment:digest(99)},
    {policyHash:digest(99)},{modelId:'other-model'},{questionConfigHash:digest(99)},{decision:'ABSTAIN'},{expiresAt:'2000000001'}]) {
    assert.equal(await verifyReceiptSignature({...receipt,...changed,signature},deployment),false);
  }
  assert.notEqual(receiptHash(receipt,{...deployment,chainId:'1'}),receiptHash(receipt,deployment));
});
test('grant binds original owner, executor, order, exact amount, preparation, receipt and nonce',async()=>{
  const signature=await buyer.signTypedData(grantTypedData(grant));
  assert.equal(await verifyGrantSignature(grant,signature),true);
  for(const changed of [{owner:seller.address},{executor:addr(99)},{orderId:digest(99)},{asset:addr(99)},{amount:'11'},
    {contextHash:digest(99)},{preparationHash:digest(99)},{receiptHash:digest(99)},{nonce:'1'},
    {deadline:'2000000001'},{chainId:'1'},{arbiter:addr(99)},{maxUses:2}]) {
    assert.equal(await verifyGrantSignature({...grant,...changed},signature),false);
  }
});
test('quote, receipt and grant use distinct domains; another domain rejects an otherwise valid signature',async()=>{
  const q=quoteTypedData(quote,deployment);
  const signature=await seller.signTypedData(q);
  for(const name of ['IntentPass.Receipt','IntentPass.Grant','IntentPass.Intent']) {
    assert.equal(await verifyTypedData({...q,domain:{...q.domain,name},signature,address:seller.address}),false);
  }
  assert.equal(new Set([q.domain.name,receiptTypedData(receipt,deployment).domain.name,grantTypedData(grant).domain.name]).size,3);
  assert.notEqual(quoteSigningHash(quote,deployment),receiptHash(receipt,deployment));
  assert.notEqual(grantSigningHash(grant),receiptHash(receipt,deployment));
});

test('changing the intent payee invalidates its already signed Grant context',async()=>{
  const envelope=JSON.parse(readFileSync('fixtures/dev/hash-vector.json','utf8')).envelope;
  const original={...grant,contextHash:contextHash(envelope)},signature=await buyer.signTypedData(grantTypedData(original));
  assert.equal(await verifyGrantSignature(original,signature),true);
  assert.equal(await verifyGrantSignature({...original,contextHash:contextHash({...envelope,payee:addr(99)})},signature),false);
});
