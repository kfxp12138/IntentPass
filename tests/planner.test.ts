import test from 'node:test';
import assert from 'node:assert/strict';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {ChatPlanner,type PlannerPort} from '../packages/adapters/src/planner.js';
import {ProposalService} from '../apps/web/src/services/propose.js';
import {quoteTypedData,policyHash,termsHash} from '../packages/protocol/src/typed-data.js';
import {SaltedEvidenceBundleSchema,purchaseEvidenceHash} from '../packages/protocol/src/review-evidence.js';
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as `0x${string}`,h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as `0x${string}`;
async function harness(startedAt?:string){
  const seller=privateKeyToAccount(generatePrivateKey()),deployment={chainId:'10143',arbiter:a(5),asset:a(6),gate:a(7),reviewer:a(8),committeeHash:h(9)};
  const policy={schemaVersion:1,taskId:h(1),datasetHash:h(2),action:'dataset-report',metrics:['count','sum','min','max'],purpose:'commercial',budget:'15',allowedAsset:a(6),requiredFacts:['service-matches-task','commercial-use-permitted','evidence-belongs-to-service'],version:'1'};
  const unsigned={schemaVersion:1,quoteId:h(3),service:'dataset-report',seller:seller.address,payee:seller.address,asset:a(6),amount:'10',serviceTerms:'Current report permits commercial use.',serviceTermsHash:termsHash('Current report permits commercial use.'),expiresAt:'2000'};
  const quote={...unsigned,signature:await seller.signTypedData(quoteTypedData(unsigned,{chainId:deployment.chainId,arbiter:deployment.arbiter}))};
  const entry={quote,documents:[{id:'terms',subjectQuoteId:h(3),text:'Current report commercial use.'},{id:'contradiction',subjectQuoteId:h(3),text:'A conflicting statement must remain available to reviewer.'}]};
  const input={policy,taskText:'Compute the fixed metrics with commercial use rights.',buyer:a(1),quoteRefs:[h(3)]},principal={subject:'local-user',wallets:[a(1)]};
  let result:unknown={quoteId:h(3),evidenceIds:['terms']},calls=0,time=1000n,after:bigint|undefined;
  const planner:PlannerPort={model:'test-model-2026-01-01',select:async()=>{calls++;if(after!==undefined)time=after;return result;}};
  const service=new ProposalService(planner,{get:async id=>id===h(3)?entry:undefined},deployment,{bond:'5',deliverySeconds:'600',settlementSeconds:'1200',...(startedAt===undefined?{}:{startedAt})},()=>time);
  return {service,input,principal,entry,policy,calls:()=>calls,set:(v:unknown)=>{result=v;},time:(v:bigint)=>{time=v;},after:(v:bigint)=>{after=v;},quoteExpires:async(value:string)=>{quote.expiresAt=value;const {signature:_old,...updated}=quote;quote.signature=await seller.signTypedData(quoteTypedData(updated,{chainId:deployment.chainId,arbiter:deployment.arbiter}));}};
}
test('planner selects only references; code retains policy, exact price/payee and ALL supplied evidence',async()=>{
  const x=await harness(),result=await x.service.propose(x.input,x.principal);assert.equal(result.status,'DRAFT');assert.ok('intent' in result);
  assert.deepEqual(result.policy,x.policy);assert.equal(result.intent.price,'10');assert.equal(result.intent.bond,'5');assert.equal(result.intent.payee,x.entry.quote.payee);assert.equal(result.intent.policyHash,policyHash(x.policy));assert.equal(result.evidence.documents.length,2);assert.equal(result.intent.purchaseEvidenceCommitment,purchaseEvidenceHash(result.evidence));assert.equal(result.intent.deliveryDeadline,'1600');assert.equal(result.intent.settlementDeadline,'2200');assert.equal('receipt' in result,false);
});
test('new proposals preserve caller salt and legacy clients receive fresh salted evidence without planner salt control',async()=>{
  const x=await harness(),salt=h(55),first=await x.service.propose({...x.input,evidenceSalt:salt},x.principal);assert.ok(first.status==='DRAFT');assert.equal(SaltedEvidenceBundleSchema.parse(first.evidence).salt,salt);
  const a=await x.service.propose(x.input,x.principal),b=await x.service.propose(x.input,x.principal);assert.ok(a.status==='DRAFT'&&b.status==='DRAFT');assert.notEqual(SaltedEvidenceBundleSchema.parse(a.evidence).salt,SaltedEvidenceBundleSchema.parse(b.evidence).salt);const before=x.calls();
  assert.equal((await x.service.propose({...x.input,evidenceSalt:h(0)},x.principal)).status,'REJECT');assert.equal(x.calls(),before);
  x.set({quoteId:h(3),evidenceIds:['terms'],salt:h(99)});assert.notEqual((await x.service.propose({...x.input,evidenceSalt:salt},x.principal)).status,'DRAFT');
});
test('planner fabricated quote/evidence IDs or attempts to rewrite policy/calldata never become an intent',async()=>{
  const x=await harness();for(const value of [{quoteId:h(99),evidenceIds:[]},{quoteId:h(3),evidenceIds:['invented']},{quoteId:h(3),evidenceIds:['terms'],budget:'999'},{quoteId:h(3),evidenceIds:['terms'],calldata:'0xdead'},{quoteId:h(3),evidenceIds:['terms','terms']}]){x.set(value);assert.notEqual((await x.service.propose(x.input,x.principal)).status,'DRAFT');}
});
test('invalid authenticated buyer, budget, quote signature or missing catalog rejects before planner',async()=>{
  const x=await harness();for(const input of [{...x.input,buyer:a(99)},{...x.input,quoteRefs:[h(99)]},{...x.input,policy:{...x.policy,budget:'14'}}])assert.equal((await x.service.propose(input,x.principal)).status,'REJECT');
  x.entry.quote.signature=('0x'+'0'.repeat(130)) as `0x${string}`;assert.equal((await x.service.propose(x.input,x.principal)).status,'REJECT');assert.equal(x.calls(),0);
});
test('quote expiring during model call pauses without emitting draft intent',async()=>{const x=await harness();x.after(2000n);assert.equal((await x.service.propose(x.input,x.principal)).status,'ABSTAIN');});
test('background task deadlines retain the original job start across provider delay and never exceed its scope end',async()=>{const x=await harness('1000');x.time(1060n);x.after(1120n);const result=await x.service.propose(x.input,x.principal);assert.equal(result.status,'DRAFT');assert.ok('intent' in result);assert.equal(result.intent.deliveryDeadline,'1600');assert.equal(result.intent.settlementDeadline,'2200');});
test('fixed task start cannot admit an expired quote, exhausted delivery window or a backwards clock',async()=>{const x=await harness('1000');x.time(2000n);assert.equal((await x.service.propose(x.input,x.principal)).status,'ABSTAIN');assert.equal(x.calls(),0);x.time(999n);assert.equal((await x.service.propose(x.input,x.principal)).status,'ABSTAIN');x.time(1500n);await x.quoteExpires('1499');assert.deepEqual(await x.service.propose(x.input,x.principal),{status:'REJECT',code:'QUOTE_EXPIRED'});assert.equal(x.calls(),0);x.time(1060n);x.after(1059n);assert.equal((await x.service.propose(x.input,x.principal)).status,'ABSTAIN');});
test('Chat planner performs one credential-isolated finite JSON selection request',async()=>{
  let calls=0;const port=new ChatPlanner('https://example.invalid/v1/chat/completions','local-only-secret','test-model-2026-01-01',async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));assert.equal(body.stream,false);assert.equal(body.n,1);assert.equal('tools' in body,false);assert.equal(JSON.stringify(body).includes('local-only-secret'),false);assert.equal(body.messages.length,2);return new Response(JSON.stringify({model:body.model,choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({quoteId:h(3),evidenceIds:['terms']})}}]}));});
  assert.deepEqual(await port.select({policy:'fixed',catalog:[]}),{quoteId:h(3),evidenceIds:['terms']});assert.equal(calls,1);
});
test('Chat planner rejects refusal, truncation, model drift, invalid JSON and oversized response without retry',async()=>{
  const valid={model:'test-model-2026-01-01',choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({quoteId:h(3),evidenceIds:[]})}}]};
  for(const body of [{...valid,model:'different'},{...valid,choices:[{...valid.choices[0],finish_reason:'length'}]},{...valid,choices:[{...valid.choices[0],message:{...valid.choices[0].message,refusal:'Denied'}}]},'not-json','x'.repeat(65537)]){let calls=0;const port=new ChatPlanner('https://example.invalid/v1/chat/completions','key',valid.model,async()=>{calls++;return new Response(typeof body==='string'?body:JSON.stringify(body));});await assert.rejects(port.select({}));assert.equal(calls,1);}
  assert.throws(()=>new ChatPlanner('http://example.invalid/api','key','model'));assert.throws(()=>new ChatPlanner('https://example.invalid/api','key','latest'));
});
