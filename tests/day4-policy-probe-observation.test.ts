import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {keccak256,toHex} from 'viem';
import {day4OriginsFixture} from './support/day4-origins-fixture.js';
import {inspectDay4PolicyProbe} from '../packages/protocol/src/day4-policy-probe.js';
import {day4PolicyProbeOrderResult} from '../packages/protocol/src/day4-policy-probe-types.js';
import {day4PolicyProbeObservation} from '../scripts/day4-policy-probe-observation.js';

const source={sourceCommit:'a'.repeat(40),bindings:[{path:'packages/protocol/src/schemas.ts',bytes:5,sha256:'b'.repeat(64)}]};
const expected={startedAt:'2026-10-03T00:00:00.000Z',endedAt:'2026-10-03T00:01:00.000Z',source,exitCode:1};
const base={schemaVersion:1,scope:'LIVE_FIXED_ORIGINAL_ORDER_PRIVY_PROBE_NOT_D4_EXTERNAL_ACCEPTANCE',mode:'prepare',
  startedAt:'2026-10-03T00:00:10.000Z',endedAt:'2026-10-03T00:00:20.000Z',sourceCommit:source.sourceCommit,
  sourceObservation:{before:source,after:source},sourceStable:true,worktreeDirty:true,status:'BLOCKED',captureAttempt:null,walletRpcAttempts:0,
  priorAttempt:false,broadcastOutcome:'NOT_ATTEMPTED',transactionsSent:0,policyDenialVerified:false,serverRequestId:null,financialAcceptanceStatus:'BLOCKED',
  officialIntegrationVerified:false,historicalPolicyAtSendVerified:false,canPassD4:false,canExecute:false,exitCode:1};
test('synthetic current missing configuration stays BLOCKED with no external call',()=>{
  const o={...base,reason:'DAY4_POLICY_PROBE_CONFIGURATION_MISSING',missing:['PRIVY_APP_ID'],artifactBindings:[],
    publicRpcInspectionAttempted:false,simulationCallsAttempted:0,privyReadCallsAttempted:0};
  assert.equal(day4PolicyProbeObservation(o,expected).status,'BLOCKED');
  for(const change of [{mode:'execute'},{priorAttempt:true},{walletRpcAttempts:1},{transactionsSent:null},{policyDenialVerified:true},
    {status:'PASS'},{captureAttempt:{}},{privyReadCallsAttempted:1},{simulationCallsAttempted:1},{serverRequestId:'fake'}])
    assert.equal(day4PolicyProbeObservation({...o,...change},expected).status,'FAIL');
});
test('synthetic stale reports, source drift and zero exits cannot be consumed',()=>{
  const o={...base,reason:'DAY4_POLICY_PROBE_CONFIGURATION_MISSING',artifactBindings:[],publicRpcInspectionAttempted:false,simulationCallsAttempted:0,privyReadCallsAttempted:0};
  for(const change of [{startedAt:'2026-10-02T00:00:00.000Z'},{endedAt:'2026-10-03T00:02:00.000Z'},{exitCode:0},
    {sourceStable:false},{sourceCommit:'c'.repeat(40)},{sourceObservation:{before:source,after:{...source,bindings:[]}}}])
    assert.equal(day4PolicyProbeObservation({...o,...change},expected).status,'FAIL');
});
test('synthetic bounded unavailable reads stay blocked while simulation mismatch is a failure',()=>{
  const o={...base,publicRpcInspectionAttempted:true,simulationCallsAttempted:1,privyReadCallsAttempted:6};
  assert.equal(day4PolicyProbeObservation({...o,reason:'DAY4_POLICY_PROBE_SIMULATION_UNAVAILABLE'},expected).status,'BLOCKED');
  assert.equal(day4PolicyProbeObservation({...o,reason:'DAY4_POLICY_PROBE_SIMULATION_MISMATCH'},expected).status,'FAIL');
});
test('synthetic independently checked original-order preparation is READY only with matching source and compiler bytes',async()=>{
  const x=await day4OriginsFixture(),inspection=await inspectDay4PolicyProbe(x.request,x.config,x.artifacts,{...x.ports,
    provider:{origins:x.ports.privy,snapshot:()=>({attempt:null,walletRpcAttempts:0,priorAttempt:false}),capture:async()=>{throw Error('SYNTHETIC_NO_SEND');}},
    simulate:async call=>day4PolicyProbeOrderResult(await x.ports.flow.orderAt(call.orderId as `0x${string}`,BigInt(call.block.number)))},{mode:'prepare'});
  const files=new Map<string,Buffer>(),sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
  const artifactBindings=(['gate','escrow'] as const).map(role=>{
    const name=role==='gate'?'CleanverseEligibility':'ContextVoteEscrow',sourcePath=`contracts/src/${name}.sol`,path=`contracts/out/${name}.sol/${name}.json`;
    const bytes=Buffer.from('// Explicit synthetic local compiler fixture'),sourceKeccak=keccak256(toHex(bytes));files.set(sourcePath,bytes);
    const compiler={version:'0.8.28+commit.7893614a'},settings={evmVersion:'cancun',viaIR:true,optimizer:{enabled:true,runs:200},compilationTarget:{[`src/${name}.sol`]:name}};
    const artifact=Buffer.from(JSON.stringify({...x.artifacts[role],metadata:{compiler,settings,sources:{[`src/${name}.sol`]:{keccak256:sourceKeccak}}}}));files.set(path,artifact);
    return {path,bytes:artifact.length,sha256:sha(artifact),compiler,settings,sources:[{path:sourcePath,bytes:bytes.length,sha256:sha(bytes),keccak256:sourceKeccak}]};
  });
  const read=(path:string)=>{const bytes=files.get(path);if(!bytes)throw Error('LOCAL_UNAVAILABLE');return bytes;};
  const o={...base,reason:'DAY4_POLICY_PROBE_FIXED_OBSERVATION',inspection,artifactBindings,publicRpcInspectionAttempted:true,simulationCallsAttempted:1,privyReadCallsAttempted:18};
  assert.equal(day4PolicyProbeObservation(o,expected,read).status,'READY');
  for(const change of [{privyReadCallsAttempted:6},{simulationCallsAttempted:0},{artifactBindings:[]},
    {inspection:{...inspection,policyDenialVerified:true}},{inspection:{...inspection,simulationReturnHash:'0x'+'0'.repeat(64)}}])
    assert.equal(day4PolicyProbeObservation({...o,...change},expected,read).status,'FAIL');
  files.set(artifactBindings[0].path,Buffer.from('{}'));assert.equal(day4PolicyProbeObservation(o,expected,read).status,'FAIL');
});
