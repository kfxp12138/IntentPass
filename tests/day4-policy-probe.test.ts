import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeFunctionData,keccak256,type Hex} from 'viem';
import {day4OriginsFixture} from './support/day4-origins-fixture.js';
import {readTestHash as h} from './support/original-authorization.js';
import {inspectDay4PolicyProbe,type Day4PolicyProbePorts} from '../packages/protocol/src/day4-policy-probe.js';
import {day4PolicyProbeKey,day4PolicyProbeOrderResult,Day4PolicyProbeProofSchema,Day4PolicyProbeCallSchema,
  type Day4PolicyProbeAttempt,type Day4PolicyProbeCall} from '../packages/protocol/src/day4-policy-probe-types.js';
import {escrowAbi} from '../packages/protocol/src/escrow-abi.js';

/** All chain/provider records and responses here are explicit local doubles. */
async function fixture(){
  const x=await day4OriginsFixture(),calls={simulations:[] as Day4PolicyProbeCall[],captures:[] as Day4PolicyProbeCall[]};
  const controls={status:'HTTP_CAPTURED' as Day4PolicyProbeAttempt['status'],posts:1 as 0|1,
    simulate:undefined as undefined|((call:Day4PolicyProbeCall)=>Promise<Hex|undefined>),captureHook:undefined as undefined|(()=>void)};
  let attempt:Day4PolicyProbeAttempt|null=null;
  const provider={origins:x.ports.privy,snapshot:()=>({attempt,walletRpcAttempts:attempt?controls.posts:0 as 0|1,priorAttempt:false}),capture:async(call:Day4PolicyProbeCall)=>{
    calls.captures.push(call);
    attempt={key:day4PolicyProbeKey(call),attemptId:'b615c368-a2d7-4406-a1bf-d7d041552cb0',call:structuredClone(call),
      createdAt:'2026-10-03T00:00:00.000Z',updatedAt:'2026-10-03T00:00:00.000Z',status:controls.status,
      httpStatus:controls.status==='OUTCOME_UNKNOWN'?null:403,rawResponseStored:controls.status!=='OUTCOME_UNKNOWN',
      transactionHash:controls.status==='UNEXPECTED_BROADCAST'?h(800):null,transactionHashStored:controls.status==='UNEXPECTED_BROADCAST'};
    controls.captureHook?.();return {attempt,walletRpcAttempts:controls.posts};
  }};
  const ports:Day4PolicyProbePorts={...x.ports,provider,simulate:async call=>{
    calls.simulations.push(call);if(controls.simulate)return controls.simulate(call);
    return day4PolicyProbeOrderResult(await x.ports.flow.orderAt(call.orderId as Hex,BigInt(call.block.number)));
  }};
  return {...x,calls,controls,provider,probePorts:ports,run:(mode:'prepare'|'execute'='prepare',beforeCapture?:()=>void)=>
    inspectDay4PolicyProbe(x.request,x.config,x.artifacts,ports,{mode,beforeCapture})};
}
test('synthetic prepare independently reconstructs the complete paid order view and never calls a wallet',async()=>{
  const x=await fixture(),p=await x.run();assert.equal(p.status,'READY');assert.equal(p.walletRpcAttempts,0);assert.equal(p.transactionsSent,0);
  assert.equal(p.call.data,encodeFunctionData({abi:escrowAbi,functionName:'orders',args:[p.origins.orderId as Hex]}));
  assert.equal(p.call.executor,x.config.flow.executor);assert.equal(p.call.arbiter,x.config.flow.arbiter);assert.equal(p.call.gas,'5000000');
  assert.equal(p.call.block.number,'30');assert.equal(p.policyDenialVerified,false);assert.equal(p.canPassD4,false);assert.equal(p.financialAcceptanceStatus,'BLOCKED');
  assert.equal(x.calls.simulations.length,1);assert.equal(x.calls.captures.length,0);assert.equal(p.attempt,null);
  assert.ok(Object.isFrozen(p)&&Object.isFrozen(p.call)&&Object.isFrozen(x.calls.simulations[0]));assert.ok(Day4PolicyProbeProofSchema.safeParse(p).success);
});
test('synthetic captured HTTP 403 remains unclassified and cannot claim no broadcast',async()=>{
  const x=await fixture(),p=await x.run('execute');assert.equal(p.status,'CAPTURED_UNCLASSIFIED');assert.equal(p.walletRpcAttempts,1);
  assert.equal(p.transactionsSent,null);assert.equal(p.broadcastOutcome,'UNKNOWN');assert.equal(p.policyDenialVerified,false);assert.equal(p.serverRequestId,null);
});
test('synthetic missing response remains unknown and permanently reserved by the provider',async()=>{
  const x=await fixture();x.controls.status='OUTCOME_UNKNOWN';const p=await x.run('execute');
  assert.equal(p.status,'OUTCOME_UNKNOWN');assert.equal(p.transactionsSent,null);assert.equal(p.broadcastOutcome,'UNKNOWN');assert.equal(p.attempt?.rawResponseStored,false);
});
test('synthetic SDK preparation failure with no forwarded wallet RPC is local unknown, without claiming a policy denial',async()=>{
  const x=await fixture();x.controls.status='OUTCOME_UNKNOWN';x.controls.posts=0;const p=await x.run('execute');
  assert.equal(p.walletRpcAttempts,0);assert.equal(p.transactionsSent,0);assert.equal(p.broadcastOutcome,'NOT_ATTEMPTED');assert.equal(p.policyDenialVerified,false);
});
test('synthetic unexpected hash is retained and gives no finalized or denial claim',async()=>{
  const x=await fixture();x.controls.status='UNEXPECTED_BROADCAST';const p=await x.run('execute');
  assert.equal(p.status,'UNEXPECTED_BROADCAST');assert.equal(p.attempt?.transactionHash,h(800));assert.equal(p.broadcastOutcome,'HASH_OBSERVED');assert.equal(p.transactionsSent,null);
});
test('synthetic invalid original provider associations prevent both simulation and capture',async()=>{
  const x=await fixture();x.request.privy.transactions.funding.hash=h(900);await assert.rejects(x.run('execute'),/DAY4_POLICY_PROBE_INPUT_INVALID/);
  assert.equal(x.calls.simulations.length,0);assert.equal(x.calls.captures.length,0);
});
test('synthetic successful simulation must match every canonical original order field and exact ABI length',async()=>{
  for(const variant of ['context','price','evidence','state','trailing','missing'] as const){
    const x=await fixture();x.controls.simulate=async call=>{
      const o=await x.ports.flow.orderAt(call.orderId as Hex,BigInt(call.block.number));
      if(variant==='context')o.contextHash=h(700);if(variant==='price')o.price='99';if(variant==='evidence')o.evidenceHash=h(701);if(variant==='state')o.state='CERTIFIED';
      const bytes=day4PolicyProbeOrderResult(o);return variant==='trailing'?(bytes+'00') as Hex:variant==='missing'?'0x':bytes;
    };
    await assert.rejects(x.run('execute'),/DAY4_POLICY_PROBE_SIMULATION_MISMATCH/);assert.equal(x.calls.captures.length,0);
  }
});
test('synthetic simulation error is sanitized and never invokes the wallet',async()=>{
  const x=await fixture();x.controls.simulate=async()=>{throw Error('PRIVATE_PROVIDER_DETAIL');};
  await assert.rejects(x.run('execute'),/^Error: DAY4_POLICY_PROBE_SIMULATION_UNAVAILABLE$/);assert.equal(x.calls.captures.length,0);
});
test('synthetic source pre-capture check failure leaves wallet untouched',async()=>{
  const x=await fixture();await assert.rejects(x.run('execute',()=>{throw Error('DAY4_POLICY_PROBE_SOURCE_CHANGED');}),/SOURCE_CHANGED/);
  assert.equal(x.calls.captures.length,0);
});
test('synthetic canonical drift after reported hash cannot discard that original hash',async()=>{
  const x=await fixture();x.controls.status='UNEXPECTED_BROADCAST';x.controls.captureHook=()=>{x.control.drift=true;};
  await assert.rejects(x.run('execute'),/DAY4_POLICY_PROBE_SNAPSHOT_CHANGED/);assert.equal(x.provider.snapshot().attempt?.transactionHash,h(800));
});
test('synthetic current policy changed after a wallet call does not become a denial',async()=>{
  const x=await fixture(),original=x.ports.privy.policy;let captured=false;
  x.ports.privy.policy=async id=>captured?{id,version:'1.0',chain_type:'ethereum',rules:[]}:original(id);
  x.controls.captureHook=()=>{captured=true;};await assert.rejects(x.run('execute'),/PRIVY_ORIGIN_POLICY_SCOPE_MISMATCH/);
  assert.equal(x.calls.captures.length,1);assert.equal(x.provider.snapshot().walletRpcAttempts,1);
});
test('synthetic fixed call and proof schemas reject extra execution methods, metadata and wrong original hash',async()=>{
  const x=await fixture(),p=await x.run();
  for(const c of [{...p.call,value:'1'},{...p.call,gas:'21000'},{...p.call,method:'eth_sign'},{...p.call,orderId:h(999)},
    {...p.call,data:encodeFunctionData({abi:escrowAbi,functionName:'timeout',args:[p.call.orderId as Hex]})}])assert.equal(Day4PolicyProbeCallSchema.safeParse(c).success,false);
  for(const changes of [{policyDenialVerified:true},{transactionsSent:null},{walletRpcAttempts:1},{simulationReturnHash:h(888)},
    {call:{...p.call,contextHash:h(889)}}])assert.equal(Day4PolicyProbeProofSchema.safeParse({...p,...changes}).success,false);
});
test('synthetic retry identity stays fixed when signer policy height and gas metadata change',async()=>{
  const x=await fixture(),p=await x.run(),call={...p.call,policyId:'another-policy',signerId:'another-signer',block:{...p.call.block,number:'31'}};
  assert.equal(day4PolicyProbeKey(call),day4PolicyProbeKey(p.call));
  assert.notEqual(day4PolicyProbeKey({...p.call,orderId:h(999),data:encodeFunctionData({abi:escrowAbi,functionName:'orders',args:[h(999)]})}),day4PolicyProbeKey(p.call));
  assert.equal(p.simulationReturnHash,keccak256(day4PolicyProbeOrderResult(p.origins.flow.finalOrder)));
});
test('synthetic original port finality drift cannot be hidden by swapping the outer port reference',async()=>{
  const x=await fixture(),old=x.ports.flow;
  x.controls.simulate=async call=>{const result=day4PolicyProbeOrderResult(await old.orderAt(call.orderId as Hex,BigInt(call.block.number)));
    Object.assign(old,{blockTag:'latest'});x.probePorts.flow={...old,blockTag:'finalized'};return result;};
  await assert.rejects(x.run('execute'),/DAY4_POLICY_PROBE_SNAPSHOT_CHANGED/);assert.equal(x.calls.captures.length,0);
});
test('synthetic malformed advancing finalized tip is rejected before any wallet RPC',async()=>{
  for(const bad of [{hash:'0x'},{timestamp:-1n},{timestamp:1700},{number:'99'}]){
    const x=await fixture(),original=x.probePorts.flow.block;let simulated=false;
    x.probePorts.flow={...x.probePorts.flow,block:async number=>number===undefined&&simulated?
      ({number:99n,hash:h(99),timestamp:2190n,...bad} as Awaited<ReturnType<typeof original>>):original(number)};
    x.controls.simulate=async call=>{const bytes=day4PolicyProbeOrderResult(await x.ports.flow.orderAt(call.orderId as Hex,BigInt(call.block.number)));simulated=true;return bytes;};
    await assert.rejects(x.run('execute'),/DAY4_POLICY_PROBE_SNAPSHOT_CHANGED/);assert.equal(x.calls.captures.length,0);
  }
});
test('synthetic natural finalized advancement does not invalidate the original canonical snapshot',async()=>{
  const x=await fixture();x.controls.captureHook=()=>{x.control.tip=31n;};const p=await x.run('execute');
  assert.equal(p.call.block.number,'30');assert.equal(p.snapshotVerified,true);assert.equal(p.status,'CAPTURED_UNCLASSIFIED');
});
