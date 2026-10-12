import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generatePrivateKey,privateKeyToAccount } from 'viem/accounts';
import { contextHash,policyHash,termsHash,quoteTypedData,receiptTypedData,grantTypedData,verifyGrantSignature } from '../packages/protocol/src/index.js';
import { ALLOCATION_POLICY,RELEASE_POLICY,DELIVERY_SCHEMA,ZERO_HASH,committeeHash,preparationHash,compileGrant,deliveryHash } from '../packages/protocol/src/index.js';
import { createReport,reportHash,verifyReport } from '../packages/protocol/src/report.js';
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
async function request() {
  const buyer=privateKeyToAccount(generatePrivateKey()),seller=privateKeyToAccount(generatePrivateKey()),reviewer=privateKeyToAccount(generatePrivateKey());
  const deployment={chainId:'31337',arbiter:a(99),reviewer:reviewer.address,committee:[a(1),a(2),a(3)]};
  const domain={chainId:deployment.chainId,arbiter:deployment.arbiter};
  const policy={schemaVersion:1,taskId:h(1),datasetHash:h(2),action:'dataset-report',metrics:['count','sum','min','max'],purpose:'commercial',budget:'15',allowedAsset:a(88),requiredFacts:['service-matches-task','commercial-use-permitted','evidence-belongs-to-service'],version:'1'};
  const unsignedQuote={schemaVersion:1,quoteId:h(3),service:'dataset-report',seller:seller.address,payee:seller.address,asset:policy.allowedAsset,amount:'10',serviceTerms:'Commercial use permitted.',serviceTermsHash:termsHash('Commercial use permitted.'),expiresAt:'1900'};
  const quote={...unsignedQuote,signature:await seller.signTypedData(quoteTypedData(unsignedQuote,domain))};
  const base=JSON.parse(readFileSync('fixtures/dev/hash-vector.json','utf8')).envelope;
  const intent={...base,...domain,buyer:buyer.address,seller:seller.address,payee:seller.address,asset:policy.allowedAsset,taskId:policy.taskId,datasetHash:policy.datasetHash,price:'10',bond:'5',policyHash:policyHash(policy),reviewer:reviewer.address,committeeHash:committeeHash(deployment.committee),serviceTermsHash:quote.serviceTermsHash,allocationPolicyHash:ALLOCATION_POLICY,intentReleasePolicyHash:RELEASE_POLICY,deliverySchemaHash:DELIVERY_SCHEMA,pactPaymentPublicKeyHash:ZERO_HASH,deliveryDeadline:'2000',settlementDeadline:'3000'};
  const unsignedReceipt={schemaVersion:1,contextHash:contextHash(intent),purchaseEvidenceCommitment:intent.purchaseEvidenceCommitment,policyHash:intent.policyHash,reviewer:reviewer.address,modelId:'LOCAL_TEST_ONLY',questionConfigHash:h(4),decision:'PASS',expiresAt:'1800'};
  const receipt={...unsignedReceipt,signature:await reviewer.signTypedData(receiptTypedData(unsignedReceipt,domain))};
  return {buyer,input:{policy,intent,quote,receipt,deployment,authenticatedOwner:buyer.address,executor:a(77),nonce:'0',deadline:'1700',now:1000n}};
}
test('compiler derives exact one-use authorization bound to authenticated owner and trusted deployment',async()=>{
  const {input,buyer}=await request(),g=await compileGrant(input);
  assert.equal(g.amount,'15');assert.equal(g.maxUses,1);assert.equal(g.owner,buyer.address);
  assert.equal(g.preparationHash,preparationHash(contextHash(input.intent),input.intent.committeeHash));
  const sig=await buyer.signTypedData(grantTypedData(g));assert.equal(await verifyGrantSignature(g,sig),true);
});
test('compiler rejects unauthenticated owner, substituted deployment, overbudget, expiry and missing signatures',async()=>{
  const {input}=await request();
  for(const changes of [
    {authenticatedOwner:a(20)}, {deployment:{...input.deployment,chainId:'1'}},
    {deployment:{...input.deployment,committee:[a(1),a(2),a(4)]}},
    {policy:{...input.policy,budget:'14'}}, {intent:{...input.intent,payee:a(30)}},
    {quote:{...input.quote,signature:'0x'}}, {receipt:{...input.receipt,signature:'0x'}},
    {deadline:'1900'}, {now:2001n}, {intent:{...input.intent,pactPaymentPublicKeyHash:h(100)}},
  ]) await assert.rejects(()=>compileGrant({...input,...changes}));
});
test('committee enforces three unique nonzero members; delivery freezes all report fields',()=>{
  for(const m of [[],[a(1),a(2)],[a(1),a(1),a(2)],[a(0),a(1),a(2)]]) assert.throws(()=>committeeHash(m));
  const d={schemaVersion:1,orderId:h(1),datasetHash:h(2),reportHash:h(3),serviceTermsHash:h(4)};
  for(const key of ['orderId','datasetHash','reportHash','serviceTermsHash']) assert.notEqual(deliveryHash(d),deliveryHash({...d,[key]:h(99)}));
});
test('reports recompute all metrics, reject tampering and preserve aggregate integer precision',()=>{
  const data=[Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER,-1],r=createReport(data);
  assert.equal(r.sum,'18014398509481981');assert.equal(r.count,'3');assert.equal(r.min,'-1');
  assert.equal(verifyReport(data,r),true);
  for(const changes of [{sum:'1'},{count:'2'},{min:'0'},{max:'1'},{datasetHash:h(5)},{extra:true}]) assert.equal(verifyReport(data,{...r,...changes}),false);
  assert.equal(verifyReport([...data,1],r),false);
  for(const invalid of [[],[1.1],[Number.MAX_SAFE_INTEGER+1],[NaN],[Infinity]]) assert.throws(()=>createReport(invalid));
  assert.throws(()=>reportHash({...r,sum:(2n**255n).toString()}));
});
