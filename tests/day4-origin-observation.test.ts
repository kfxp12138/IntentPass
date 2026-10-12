import test from 'node:test';
import assert from 'node:assert/strict';
import {day4OriginObservation} from '../scripts/day4-origin-observation.js';
function fixture(){
  const expected={startedAt:'2026-10-02T19:00:00.000Z',endedAt:'2026-10-02T19:01:00.000Z',sourceCommit:'a'.repeat(40),exitCode:1,
    sourceBindings:[{path:'local-fixture-source.ts',bytes:10,sha256:'b'.repeat(64)}]};
  const report={schemaVersion:1,scope:'READ_ONLY_ORIGINAL_CREATIONS_CHAIN_AND_LIVE_PRIVY_ASSOCIATIONS_NOT_D4_EXTERNAL_ACCEPTANCE',
    startedAt:'2026-10-02T19:00:10.000Z',endedAt:'2026-10-02T19:00:20.000Z',sourceCommit:expected.sourceCommit,sourceBindings:expected.sourceBindings,
    worktreeDirty:true,status:'BLOCKED',reason:'DAY4_ORIGINS_CONFIGURATION_MISSING',financialAcceptanceStatus:'BLOCKED',
    officialIntegrationVerified:false,historicalPolicyAtSendVerified:false,withdrawalProviderOriginVerified:false,canExecute:false,
    transactionsSent:0,signaturesRequested:0,publicRpcInspectionAttempted:false,privyReadInspectionAttempted:false,privyReadCallsAttempted:0,exitCode:1};
  return {expected,report};
}
test('local observer accepts a fresh genuine nonzero blocked report without granting D4',()=>{
  const x=fixture();assert.deepEqual(day4OriginObservation(x.report,x.expected),{status:'BLOCKED',publicRpcInspectionAttempted:false,privyReadInspectionAttempted:false,privyReadCallsAttempted:0});
});
test('local observer rejects stale future reversed and malformed report windows',()=>{
  for(const patch of [{startedAt:'2026-10-02T18:59:00.000Z'},{endedAt:'2026-10-02T19:02:00.000Z'},{endedAt:'2026-10-02T19:00:09.000Z'},{startedAt:'INVALID'}]){
    const x=fixture();assert.equal(day4OriginObservation({...x.report,...patch},x.expected).status,'FAIL');
  }
});
test('local observer rejects another source version source bytes or command exit',()=>{
  for(const patch of [{sourceCommit:'c'.repeat(40)},{sourceBindings:[]},{sourceBindings:[{path:'local-fixture-source.ts',bytes:11,sha256:'b'.repeat(64)}]},{exitCode:0}]){
    const x=fixture();assert.equal(day4OriginObservation({...x.report,...patch},x.expected).status,'FAIL');
  }
});
test('local observer rejects elevated capability historical provenance or financial status',()=>{
  for(const patch of [{officialIntegrationVerified:true},{historicalPolicyAtSendVerified:true},{withdrawalProviderOriginVerified:true},{canExecute:true},
    {financialAcceptanceStatus:'PASS'},{transactionsSent:1},{signaturesRequested:1}]){const x=fixture();assert.equal(day4OriginObservation({...x.report,...patch},x.expected).status,'FAIL');}
});
test('local observer refuses synthetic pass with a missing invalid or disconnected proof',()=>{
  const x=fixture();x.expected.exitCode=0;assert.equal(day4OriginObservation({...x.report,status:'ORIGINS_VERIFIED',exitCode:0,
    publicRpcInspectionAttempted:true,privyReadInspectionAttempted:true,privyReadCallsAttempted:6,inspection:{status:'ORIGINS_VERIFIED'}},x.expected).status,'FAIL');
});
test('local observer records real read attempts honestly and rejects contradictory or unbounded counts',()=>{
  const x=fixture();assert.equal(day4OriginObservation({...x.report,privyReadInspectionAttempted:true,privyReadCallsAttempted:2},x.expected).privyReadCallsAttempted,2);
  for(const patch of [{privyReadInspectionAttempted:true},{privyReadCallsAttempted:1},{privyReadInspectionAttempted:true,privyReadCallsAttempted:7},
    {privyReadInspectionAttempted:true,privyReadCallsAttempted:1.5}])assert.equal(day4OriginObservation({...x.report,...patch},x.expected).status,'FAIL');
});
