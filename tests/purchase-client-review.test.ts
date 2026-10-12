import test from 'node:test';
import assert from 'node:assert/strict';
import {PurchaseClient} from '../packages/protocol/src/purchase-client.js';
import {IntentPassClient} from '../packages/protocol/src/index.js';
import {ReviewRequestSchema} from '../packages/protocol/src/draft.js';
import {PreflightSnapshotSchema} from '../packages/protocol/src/purchase-preflight.js';
import {receiptTypedData} from '../packages/protocol/src/typed-data.js';
import {questionConfigHash,type JevResult} from '../packages/adapters/src/jev-review.js';
import {runExample} from '../examples/client/client.js';
import {originalAuthorizationFixture,readTestHash as h,readTestAddress as a} from './support/original-authorization.js';

function judgments(choice:'SUPPORTED'|'CONTRADICTED'|'INSUFFICIENT'='SUPPORTED',confidence=1):JevResult['answers']{
  const answer={type:'choice' as const,choice,confidence,probabilities:{SUPPORTED:choice==='SUPPORTED'?1:0,CONTRADICTED:choice==='CONTRADICTED'?1:0,INSUFFICIENT:choice==='INSUFFICIENT'?1:0}};
  return {service:answer,purpose:answer,provenance:answer};
}
/** Real temporary EOA receipt signatures; provider/configuration use only memory transport. */
async function fixture(version:1|2=1){
  const f=await originalAuthorizationFixture(),model='jev-1.13.0',rule={model,minConfidence:.9,questionVersion:version,questionConfigHash:questionConfigHash(.9,version)},request=ReviewRequestSchema.parse({policy:f.payload.policy,intent:f.payload.intent,quote:f.payload.quote,evidence:f.payload.evidence});
  const configuration={privyAppId:'local-sdk-app',meraRpId:null,recoveryDeployment:f.deployment,purchaseRule:rule};
  async function sign(changes:Record<string,unknown>={}){
    const {signature:_signature,...base}=f.payload.receipt,receipt={...base,modelId:model,questionConfigHash:rule.questionConfigHash,...changes};
    return {...receipt,signature:await f.reviewer.signTypedData(receiptTypedData(receipt,{chainId:f.deployment.chainId,arbiter:f.deployment.arbiter}))};
  }
  const response={decision:'PASS' as const,source:'JEV' as const,modelId:model,questionConfigHash:rule.questionConfigHash,answers:judgments(),usage:{input_tokens:12,output_tokens:3},executable:true as const,receipt:await sign()};
  let reply:unknown=response,config:unknown=configuration,reviews=0,configs=0;
  const transport:typeof fetch=async function(this:unknown,url,init){
    assert.equal(this,globalThis,'browser fetch must retain its global receiver');
    const path=new URL(String(url)).pathname;
    if(path==='/api/config'){assert.equal(init?.method,'GET');configs++;return new Response(JSON.stringify(config));}
    assert.equal(path,'/api/intent/review');assert.equal(init?.method,'POST');assert.deepEqual(JSON.parse(String(init?.body)),request);reviews++;return new Response(JSON.stringify(reply));
  };
  return {...f,request,rule,configuration,response,transport,sign,setResponse:(value:unknown)=>{reply=value;},setConfiguration:(value:unknown)=>{config=value;},counts:()=>({reviews,configs}),client:(clock:()=>bigint=()=>1000n)=>new PurchaseClient('https://local-sdk.invalid',async()=>'LOCAL_TEST_TOKEN',transport,clock)};
}
test('standalone protocol SDK binds the browser fetch receiver without changing its request URL',async()=>{
  const client=new IntentPassClient('https://local-sdk.invalid',undefined,async function(this:unknown,url){assert.equal(this,globalThis);assert.equal(String(url),'https://local-sdk.invalid/health');return new Response('{"ready":false}');});
  assert.deepEqual(await client.health(),{ready:false});
});

test('public purchase SDK rejects signed PASS contradicted by necessary answers for both question versions',async()=>{
  for(const version of [1,2] as const){
    const f=await fixture(version),client=f.client();assert.equal((await client.review(f.request)).decision,'PASS');
    for(const answers of [judgments('CONTRADICTED'),judgments('INSUFFICIENT'),judgments('SUPPORTED',.89),{...judgments(),service:{type:'choice',choice:'SUPPORTED',confidence:1,probabilities:{SUPPORTED:.5,CONTRADICTED:.5,INSUFFICIENT:0}}}]){
      f.setResponse({...f.response,answers});await assert.rejects(client.review(f.request),/REVIEW_RESPONSE_MISMATCH/);
    }
    f.setResponse({...f.response,executable:false,receipt:undefined,answers:judgments('CONTRADICTED')});await assert.rejects(client.review(f.request),/REVIEW_RESPONSE_MISMATCH/);
    assert.deepEqual(f.counts(),{reviews:6,configs:6});
  }
});

test('public purchase SDK binds review to configured model threshold question version and hash without retries',async()=>{
  const f=await fixture(2),client=f.client();
  for(const purchaseRule of [null,{...f.rule,questionConfigHash:h(66)},{...f.rule,questionVersion:1},{...f.rule,minConfidence:.8}]){
    f.setConfiguration({...f.configuration,purchaseRule});await assert.rejects(client.review(f.request),/REVIEW_CONFIGURATION_REQUIRED/);
  }
  assert.equal(f.counts().reviews,0);f.setConfiguration({...f.configuration,purchaseRule:{...f.rule,questionVersion:3}});await assert.rejects(client.review(f.request));assert.equal(f.counts().reviews,0);
  f.setConfiguration(f.configuration);
  for(const reply of [{...f.response,modelId:'jev-9.9.9'},{...f.response,questionConfigHash:questionConfigHash(.9,1)}]){f.setResponse(reply);await assert.rejects(client.review(f.request),/REVIEW_RESPONSE_MISMATCH/);}
  assert.equal(f.counts().reviews,2);
  let reviews=0;const transport:typeof fetch=async url=>{if(new URL(String(url)).pathname==='/api/config')return new Response(JSON.stringify(f.configuration));reviews++;throw new Error('LOCAL_LOST_MODEL_RESPONSE');};
  await assert.rejects(new PurchaseClient('https://local-sdk.invalid',async()=>'LOCAL_TEST_TOKEN',transport,()=>1000n).review(f.request),/LOCAL_LOST_MODEL_RESPONSE/);assert.equal(reviews,1);
});

test('public purchase SDK preserves explicit conservative pauses and verifies non-executable review decisions',async()=>{
  const f=await fixture(),client=f.client(),base={...f.response,executable:false,receipt:undefined};
  for(const code of ['REVIEW_EXPIRED','REVIEWER_UNAVAILABLE']){f.setResponse({...base,decision:'ABSTAIN',code});assert.equal((await client.review(f.request)).decision,'ABSTAIN');}
  for(const reply of [{...base,decision:'ABSTAIN',code:'OTHER_REASON'},{...base,decision:'ABSTAIN',answers:judgments('CONTRADICTED'),code:'REVIEW_EXPIRED'},{...base,decision:'REJECT',answers:judgments()}]){f.setResponse(reply);await assert.rejects(client.review(f.request),/REVIEW_RESPONSE_MISMATCH/);}
  for(const [choice,decision] of [['SUPPORTED','PASS'],['INSUFFICIENT','ABSTAIN'],['CONTRADICTED','REJECT']] as const){f.setResponse({...base,answers:judgments(choice),decision});assert.equal((await client.review(f.request)).decision,decision);}
  for(const reply of [{decision:'REJECT',source:'HARD_RULE',code:'OVER_BUDGET'},{decision:'ABSTAIN',source:'DEPENDENCY',code:'JEV_UNAVAILABLE_OR_INVALID'}]){f.setResponse(reply);assert.deepEqual(await client.review(f.request),reply);}
});

test('public purchase SDK rejects expired misbound or untrusted executable receipts and rechecks expiry after verification',async()=>{
  const f=await fixture(),client=f.client();
  for(const changes of [{expiresAt:'1000'},{expiresAt:'2001'},{contextHash:h(66)},{policyHash:h(66)},{purchaseEvidenceCommitment:h(66)},{reviewer:a(66)},{modelId:'jev-9.9.9'},{questionConfigHash:h(66)}]){
    f.setResponse({...f.response,receipt:await f.sign(changes)});await assert.rejects(client.review(f.request),/REVIEW_RESPONSE_MISMATCH/);
  }
  f.setResponse({...f.response,receipt:{...f.response.receipt,signature:'0x'+'0'.repeat(130)}});await assert.rejects(client.review(f.request),/REVIEW_RESPONSE_MISMATCH/);
  f.setResponse(f.response);
  for(const recoveryDeployment of [null,{...f.deployment,reviewer:a(66)},{...f.deployment,chainId:'143'},{...f.deployment,committee:[a(4),a(5),a(6)]}]){f.setConfiguration({...f.configuration,recoveryDeployment});await assert.rejects(client.review(f.request),/REVIEW_RESPONSE_MISMATCH/);}
  f.setConfiguration(f.configuration);
  for(const times of [[1000n,1800n],[1000n,999n],[1000n,1799n,1800n],[-1n,1000n]]){let i=0;await assert.rejects(f.client(()=>times[Math.min(i++,times.length-1)]).review(f.request),/REVIEW_RESPONSE_MISMATCH/);}
  assert.equal((await client.review(f.request)).decision,'PASS');
});

test('independent example rejects inconsistent signed PASS and blocked preflight while preserving snapshots and health liveness',async()=>{
  const f=await fixture(),errors:string[]=[],out:unknown[]=[];f.setResponse({...f.response,answers:judgments('CONTRADICTED')});
  const env={INTENTPASS_URL:'https://local-sdk.invalid',INTENTPASS_TOKEN:'LOCAL_TEST_TOKEN'};
  assert.equal(await runExample(['review'],env,{input:async()=>f.request,out:v=>out.push(v),error:v=>errors.push(v),transport:f.transport}),1);assert.deepEqual(out,[]);assert.deepEqual(errors,['EXAMPLE_OPERATION_UNAVAILABLE']);assert.equal(f.counts().reviews,1);
  const g=f.payload.grant,base={chainId:g.chainId,arbiter:g.arbiter,asset:g.asset,buyer:g.owner,orderId:g.orderId,contextHash:g.contextHash,nonce:g.nonce,amount:g.amount,deadline:g.deadline,state:'UNREGISTERED',consumed:false,revoked:false,transferEligible:true,balance:g.amount,allowance:g.amount,blockers:[],block:{number:'1',hash:h(11),timestamp:'1000',finality:'finalized'},canSubmitPayment:false};
  for(const [changes,expected] of [[{},0],[{transferEligible:false,balance:'0',allowance:'0',blockers:['BUYER_INELIGIBLE','INSUFFICIENT_BALANCE','EXACT_ALLOWANCE_REQUIRED']},1],[{state:'FUNDED',consumed:true,blockers:['ORDER_ALREADY_REGISTERED','NONCE_CONSUMED']},1]] as const){
    const snapshot=PreflightSnapshotSchema.parse({...base,...changes}),printed:unknown[]=[];
    const exit=await runExample(['preflight'],env,{input:async()=>({intent:f.payload.intent,grant:g}),out:v=>printed.push(v),error:()=>assert.fail('unexpected CLI error'),transport:async()=>new Response(JSON.stringify(snapshot))});
    assert.equal(exit,expected);assert.deepEqual(printed,[snapshot]);
  }
  const printed:unknown[]=[];assert.equal(await runExample(['health'],{INTENTPASS_URL:env.INTENTPASS_URL},{input:async()=>assert.fail('health has no input'),out:v=>printed.push(v),error:()=>assert.fail('unexpected health error'),transport:async()=>new Response(JSON.stringify({service:'intentpass',liveness:'OK',ready:false}))}),0);assert.deepEqual(printed,[{service:'intentpass',liveness:'OK',ready:false}]);
});

test('public purchase SDK refuses pending approval receipts paired with terminal original records',async()=>{
  const f=await fixture(),g=f.payload.grant,hash=h(77),record={orderId:g.orderId,contextHash:g.contextHash,nonce:g.nonce,chainId:g.chainId,asset:g.asset,owner:g.owner,spender:g.arbiter,amount:g.amount,step:'SET',status:'RESERVED',hash:null};let response:unknown={record,receipt:{status:'PENDING',hash,canSubmitPayment:false}};
  const client=new PurchaseClient('https://local-sdk.invalid',async()=>'LOCAL_TEST_TOKEN',async()=>new Response(JSON.stringify(response))),request={payload:f.payload,step:'SET',hash};assert.equal((await client.reconcileApproval(request) as any).receipt.status,'PENDING');
  for(const status of ['CONFIRMED','REVERTED']){response={record:{...record,status,hash},receipt:{status:'PENDING',hash,canSubmitPayment:false}};await assert.rejects(client.reconcileApproval(request),/APPROVAL_RESPONSE_MISMATCH/);}
  response={record:{...record,status:'CONFIRMED',hash},receipt:{status:'CONFIRMED',hash,orderId:g.orderId,step:'SET',approvedAmount:g.amount,currentAllowance:g.amount,exactAllowance:true,block:{number:'1',hash:h(11)},canSubmitPayment:false}};assert.equal((await client.reconcileApproval(request) as any).receipt.status,'CONFIRMED');
});
