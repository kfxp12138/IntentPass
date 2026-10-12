import test from 'node:test';
import assert from 'node:assert/strict';
import {day4SubmitRejectionObservation} from '../scripts/day4-submit-rejection-observation.js';

// Explicit in-memory report/source doubles; no live chain observation is made.
function fixture(){
  const source={sourceCommit:'a'.repeat(40),bindings:[{path:'scripts/local-fixture.ts',bytes:10,sha256:'b'.repeat(64)}]};
  const expected={startedAt:'2026-10-03T01:00:00.000Z',endedAt:'2026-10-03T01:01:00.000Z',source,exitCode:1};
  const report={schemaVersion:1,scope:'LIVE_FIXED_PUBLIC_MONAD_SUBMIT_CALLS_NOT_D4_EXTERNAL_ACCEPTANCE',
    startedAt:'2026-10-03T01:00:10.000Z',endedAt:'2026-10-03T01:00:20.000Z',sourceCommit:source.sourceCommit,
    sourceStable:true,sourceObservation:{before:structuredClone(source),after:structuredClone(source)},worktreeDirty:true,
    status:'BLOCKED',reason:'DAY4_SUBMIT_CONFIGURATION_MISSING',artifactBindings:[],financialAcceptanceStatus:'BLOCKED',
    officialIntegrationVerified:false,canPassD4:false,canExecute:false,signaturesRequested:0,transactionsSent:0,
    publicRpcInspectionAttempted:false,submitCallsAttempted:0,exitCode:1};
  return {expected,report};
}
test('fixed-submit consumer accepts a fresh nonzero missing configuration without financial PASS',()=>{
  const x=fixture();assert.deepEqual(day4SubmitRejectionObservation(x.report,x.expected),
    {status:'BLOCKED',publicRpcInspectionAttempted:false,submitCallsAttempted:0,observations:[]});
});
test('fixed-submit consumer refuses prior future reversed and malformed observations',()=>{
  for(const patch of [{startedAt:'2026-10-03T00:59:59.000Z'},{endedAt:'2026-10-03T01:02:00.000Z'},
    {endedAt:'2026-10-03T01:00:09.000Z'},{startedAt:'INVALID'}]){
    const x=fixture();assert.equal(day4SubmitRejectionObservation({...x.report,...patch},x.expected).status,'FAIL');
  }
});
test('fixed-submit consumer requires exact full source bytes before and after this invocation',()=>{
  for(const mode of ['revision','before','after','missing','private','stable']){
    const x=fixture();
    if(mode==='revision')x.report.sourceCommit='c'.repeat(40);
    else if(mode==='before')x.report.sourceObservation.before.bindings[0].bytes++;
    else if(mode==='after')x.report.sourceObservation.after.bindings[0].sha256='c'.repeat(64);
    else if(mode==='missing')x.report.sourceObservation.after.bindings=[];
    else if(mode==='private')x.report.sourceObservation.before.bindings[0].path='.env';
    else x.report.sourceStable=false;
    assert.equal(day4SubmitRejectionObservation(x.report,x.expected).status,'FAIL',mode);
  }
});
test('fixed-submit consumer rejects elevated wallet official or financial capabilities',()=>{
  for(const patch of [{canPassD4:true},{canExecute:true},{officialIntegrationVerified:true},{transactionsSent:1},
    {signaturesRequested:1},{financialAcceptanceStatus:'PASS'}]){
    const x=fixture();assert.equal(day4SubmitRejectionObservation({...x.report,...patch},x.expected).status,'FAIL');
  }
});
test('fixed-submit consumer does not hide real RPC attempts behind missing configuration',()=>{
  for(const patch of [{publicRpcInspectionAttempted:true},{submitCallsAttempted:1},{submitCallsAttempted:5},
    {submitCallsAttempted:-1},{submitCallsAttempted:1.5},{submitCallsAttempted:'1'}]){
    const x=fixture();assert.equal(day4SubmitRejectionObservation({...x.report,...patch},x.expected).status,'FAIL');
  }
});
test('fixed-submit consumer refuses synthetic complete claims without parsed original proof and artifacts',()=>{
  const x=fixture();x.expected.exitCode=0;
  assert.equal(day4SubmitRejectionObservation({...x.report,status:'COMPLETE',reason:'DAY4_SUBMIT_FIXED_CALL_OBSERVATIONS',
    publicRpcInspectionAttempted:true,submitCallsAttempted:4,exitCode:0,inspection:{status:'COMPLETE'}},x.expected).status,'FAIL');
});
test('fixed-submit consumer requires exact child exit and never downgrades explicit failure to blocked',()=>{
  const x=fixture();
  for(const patch of [{exitCode:0},{status:'FAIL'},{reason:'SOME_UNRELATED_BLOCKER'},
    {artifactBindings:[{path:'arbitrary-cache.json'}]},{inspection:{status:'BLOCKED'}}])
    assert.equal(day4SubmitRejectionObservation({...x.report,...patch},x.expected).status,'FAIL');
});
test('fixed-submit consumer preserves unavailable historical reads without declaring a guard verified',()=>{
  for(const reason of ['DAY4_SUBMIT_READ_UNAVAILABLE','DAY4_SUBMIT_CREATIONS_PENDING','DAY4_SUBMIT_CREATIONS_CODE_MISSING',
    'DAY4_SUBMIT_BLOCK_UNAVAILABLE','DAY4_SUBMIT_BLOCK_NOT_FINALIZED','DEPLOYMENT_BUILD_UNAVAILABLE']){
    const x=fixture();assert.equal(day4SubmitRejectionObservation({...x.report,reason},x.expected).status,'BLOCKED',reason);
  }
});
