import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {runPlannerSmokeOnce,plannerSmokeQuoteId,plannerSmokeEvidenceId,plannerSmokeFailure,PlannerSmokeReportSchema,
  plannerSmokeReportBytes,plannerSmokeLimits,assertPlannerSmokePublicBytes,type PlannerSmokeResult} from '../scripts/planner-smoke-evidence.js';

// Entirely local HTTP/model/source doubles. No private environment, network,
// wallet, compiler, source capture or real planner invocation is used here.
const config={endpoint:'https://planner.example.invalid/api/plan/v3/chat/completions',key:'local-synthetic-planner-credential',model:'configured-synthetic-model'};
const sourceBytes=Buffer.from('LOCAL_SYNTHETIC_SOURCE\n');
const source={sourceCommit:'a'.repeat(40),bindings:[{path:'scripts/synthetic-planner.ts',bytes:sourceBytes.length,sha256:createHash('sha256').update(sourceBytes).digest('hex')}]};
function report(result:PlannerSmokeResult){return {schemaVersion:1,invocationId:'8b0abf3d-7ce2-45c3-a3ea-3e558f41c8dc',scope:'REAL_PLANNER_SYNTHETIC_FINITE_SELECTION_ONLY',
  startedAt:'2026-10-03T12:00:00.000Z',endedAt:'2026-10-03T12:00:01.000Z',source:structuredClone(source),sourceStable:true,worktreeDirty:true,...result,
  retries:0,credentialsRecorded:false,authorizationHeadersRecorded:false,providerBodyRecorded:false,providerReasoningRecorded:false,privateTaskPayloadRecorded:false,
  canExecute:false,financialAcceptanceStatus:'BLOCKED',signaturesRequested:0,transactionsSent:0,exitCode:result.status==='PASS'?0:1,limits:plannerSmokeLimits};}
function answer(selection:unknown={quoteId:plannerSmokeQuoteId,evidenceIds:[plannerSmokeEvidenceId]},patch:Record<string,unknown>={}){
  return new Response(JSON.stringify({model:config.model,choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(selection),reasoning_content:'LOCAL_SYNTHETIC_REASONING_MUST_NOT_BE_RECORDED'}}],...patch}),{status:200});
}
async function valid(){return runPlannerSmokeOnce(config,async()=>answer());}

test('synthetic planner smoke sends exactly one unchanged configured request and only a fixed unsigned finite catalog',async()=>{
  let calls=0;const result=await runPlannerSmokeOnce(config,async(input,init)=>{
    calls++;assert.equal(String(input),config.endpoint);assert.equal((init?.headers as Record<string,string>).Authorization,`Bearer ${config.key}`);
    assert.equal(init?.method,'POST');assert.equal(init?.redirect,'error');
    const body=JSON.parse(String(init?.body)),state=JSON.parse(body.messages[1].content);
    assert.equal(body.model,config.model);assert.equal(body.stream,false);assert.equal(body.n,1);assert.equal('tools' in body,false);
    assert.equal(state.catalog.length,1);assert.equal(state.catalog[0].quote.quoteId,plannerSmokeQuoteId);
    assert.deepEqual(state.catalog[0].documents.map((d:{id:string})=>d.id),[plannerSmokeEvidenceId]);
    assert.equal(state.policy.executionAllowed,false);assert.equal(state.catalog[0].quote.amount,'0');
    assert.doesNotMatch(JSON.stringify(state),/"(?:ownerSignature|authorization|privateKey|buyer|payee|grant|receipt|calldata)"\s*:/);
    assert.equal(String(init?.body).includes(config.key),false);return answer();
  });
  assert.equal(calls,1);assert.equal(result.status,'PASS');assert.equal(result.requestAttempts,1);assert.equal(result.httpStatus,200);
  assert.deepEqual(result.selection,{quoteId:plannerSmokeQuoteId,evidenceIds:[plannerSmokeEvidenceId]});
  const bytes=plannerSmokeReportBytes(report(result),[config.key]),text=bytes.toString('utf8');
  for(const value of [config.key,config.model,config.endpoint,'LOCAL_SYNTHETIC_REASONING_MUST_NOT_BE_RECORDED'])assert.equal(text.includes(value),false);
  assert.equal(JSON.parse(text).financialAcceptanceStatus,'BLOCKED');assert.equal(JSON.parse(text).canExecute,false);
});

test('synthetic missing and invalid configuration stop before any transport call',async()=>{
  let calls=0;const transport:typeof fetch=async()=>{calls++;return answer();};
  for(const value of [{},{endpoint:config.endpoint},{...config,key:''},{...config,model:' '}]){
    const result=await runPlannerSmokeOnce(value,transport);assert.equal(result.status,'BLOCKED');assert.equal(result.code,'PLANNER_CONFIGURATION_MISSING');assert.equal(result.requestAttempts,0);
  }
  for(const value of [{...config,endpoint:'not-a-url'},{...config,endpoint:'http://planner.example.invalid/chat'},
    {...config,endpoint:['https://','user:password','@planner.example.invalid/chat'].join('')},{...config,endpoint:config.endpoint+'?secret=synthetic'},
    {...config,model:'latest-model'}]){
    const result=await runPlannerSmokeOnce(value,transport);assert.equal(result.code,'PLANNER_CONFIGURATION_INVALID');assert.equal(result.requestAttempts,0);
  }
  assert.equal(calls,0);
});

test('synthetic success requires both the only quote and its exact one evidence reference',async()=>{
  for(const selected of [{quoteId:'0x'+'2'.repeat(64),evidenceIds:[plannerSmokeEvidenceId]},
    {quoteId:plannerSmokeQuoteId,evidenceIds:[]},{quoteId:plannerSmokeQuoteId,evidenceIds:['invented']},
    {quoteId:plannerSmokeQuoteId,evidenceIds:[plannerSmokeEvidenceId,'other']},
    {quoteId:plannerSmokeQuoteId,evidenceIds:[plannerSmokeEvidenceId,plannerSmokeEvidenceId]},
    {quoteId:plannerSmokeQuoteId,evidenceIds:[plannerSmokeEvidenceId],canExecute:true}]){
    let calls=0;const result=await runPlannerSmokeOnce(config,async()=>{calls++;return answer(selected);});
    assert.equal(calls,1);assert.equal(result.status,'FAIL');assert.equal(result.selection,null);
    assert.ok(['PLANNER_SELECTION_OUT_OF_CATALOG','PLANNER_RESPONSE_INVALID'].includes(result.code));
  }
});

test('synthetic actual HTTP rejections retain only bounded status and fixed code with no retry',async()=>{
  for(const status of [401,403,429,500,503]){
    let calls=0;const result=await runPlannerSmokeOnce(config,async()=>{calls++;return new Response('LOCAL_PRIVATE_PROVIDER_BODY '+config.key,{status});});
    assert.equal(calls,1);assert.equal(result.httpStatus,status);assert.equal(result.code,'PLANNER_HTTP_REJECTED');assert.equal(result.selection,null);
    assert.equal(result.status,status>=500?'BLOCKED':'FAIL');
    const bytes=plannerSmokeReportBytes(report(result),[config.key]);assert.equal(bytes.includes(Buffer.from('LOCAL_PRIVATE_PROVIDER_BODY')),false);
  }
});

test('synthetic network errors cannot leak private messages or invent an HTTP status',async()=>{
  let calls=0;const result=await runPlannerSmokeOnce(config,async()=>{calls++;throw Error('LOCAL_PRIVATE_NETWORK_ERROR '+config.key);});
  assert.equal(calls,1);assert.equal(result.status,'BLOCKED');assert.equal(result.code,'PLANNER_UNAVAILABLE');assert.equal(result.httpStatus,null);
  assert.equal(result.requestAttempts,1);assert.equal(plannerSmokeReportBytes(report(result),[config.key]).includes(Buffer.from('LOCAL_PRIVATE_NETWORK_ERROR')),false);
});

test('synthetic refusal, model drift, truncation, invalid or oversized bodies never pass or retry',async()=>{
  for(const response of [answer(undefined,{model:'different-model'}),
    answer(undefined,{choices:[{finish_reason:'stop',message:{role:'assistant',content:'{}',refusal:'LOCAL_PRIVATE_REFUSAL '+config.key}}]}),
    answer(undefined,{choices:[{finish_reason:'length',message:{role:'assistant',content:'{}'}}]}),
    new Response('LOCAL_PRIVATE_INVALID_JSON '+config.key),new Response('x'.repeat(65537))]){
    let calls=0;const result=await runPlannerSmokeOnce(config,async()=>{calls++;return response;});
    assert.equal(calls,1);assert.equal(result.status,'FAIL');assert.equal(result.selection,null);
    assert.ok(['PLANNER_RESPONSE_INVALID','PLANNER_RESPONSE_TOO_LARGE'].includes(result.code));plannerSmokeReportBytes(report(result),[config.key]);
  }
});

test('synthetic source instability, missing source, reversed time and false exit cannot support PASS',async()=>{
  const value=report(await valid());
  for(const patch of [{sourceStable:false},{source:null},{source:{...source,sourceCommit:'invalid'}},
    {source:{...source,bindings:[]}},{endedAt:'2026-10-03T11:59:59.999Z'},{startedAt:'INVALID'},{exitCode:1}])
    assert.equal(PlannerSmokeReportSchema.safeParse({...value,...patch}).success,false);
  const failed=report(plannerSmokeFailure('PLANNER_SOURCE_CHANGED',1,200));
  assert.equal(PlannerSmokeReportSchema.safeParse({...failed,sourceStable:false}).success,true);
  assert.equal(PlannerSmokeReportSchema.safeParse({...report(plannerSmokeFailure('PLANNER_SOURCE_UNAVAILABLE')),source:null,sourceStable:false}).success,true);
});

test('synthetic report cannot gain execution, financial, credential, body or reasoning claims',async()=>{
  const value=report(await valid());
  for(const patch of [{scope:'REAL_FINANCIAL_ACCEPTANCE'},{canExecute:true},{financialAcceptanceStatus:'PASS'},
    {signaturesRequested:1},{transactionsSent:1},{retries:1},{requestAttempts:2},{selection:null},{httpStatus:null},
    {credentialsRecorded:true},{authorizationHeadersRecorded:true},{providerBodyRecorded:true},{providerReasoningRecorded:true},
    {privateTaskPayloadRecorded:true},{endpoint:config.endpoint},{model:config.model},{reason:'LOCAL_PRIVATE_TEXT'},
    {rawBody:'LOCAL_PRIVATE_BODY'},{limits:['rewritten']}])assert.equal(PlannerSmokeReportSchema.safeParse({...value,...patch}).success,false);
});

test('synthetic byte safety blocks exact and JSON escaped credential collisions without publishing fingerprints',async()=>{
  for(const secret of ['LOCAL_SYNTHETIC_SECRET','synthetic"quote\\slash\nline']){
    assert.throws(()=>assertPlannerSmokePublicBytes(Buffer.from(secret),[secret]),/PLANNER_SMOKE_PUBLIC_OUTPUT_UNSAFE/);
    assert.throws(()=>assertPlannerSmokePublicBytes(Buffer.from(JSON.stringify({value:secret})),[secret]),/PLANNER_SMOKE_PUBLIC_OUTPUT_UNSAFE/);
  }
  const value=report(await valid()),secret='LOCAL_SYNTHETIC_FILENAME_SECRET';
  const withSecret={...value,source:{...source,bindings:[{...source.bindings[0],path:`scripts/${secret}.ts`}]}};
  assert.throws(()=>plannerSmokeReportBytes(withSecret,[secret]),/PLANNER_SMOKE_PUBLIC_OUTPUT_UNSAFE/);
  assert.throws(()=>plannerSmokeReportBytes(value,[plannerSmokeQuoteId]),/PLANNER_SMOKE_PUBLIC_OUTPUT_UNSAFE/);
  assert.doesNotThrow(()=>plannerSmokeReportBytes(value,[config.key]));
});
