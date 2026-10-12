import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {getContractAddress,concatHex,encodeAbiParameters,encodeEventTopics,parseAbi,parseAbiParameters,keccak256,toHex,type Address,type Hex} from 'viem';
import {originalAuthorizationFixture,readTestAddress as a,readTestHash as h} from './support/original-authorization.js';
import {inspectDay4Origins} from '../packages/protocol/src/day4-origins.js';
import {Day4CreationPairConfigSchema,Day4OriginsProofSchema,Day4OriginsRequestSchema,type Day4CreationPairPort,type PrivyOriginPort} from '../packages/protocol/src/day4-origin-types.js';
import {type Day4ChainFlowPort,type Day4ChainReceipt,type Day4ChainTransaction} from '../packages/protocol/src/day4-chain-flow-types.js';
import {deploymentDraft} from '../packages/protocol/src/deployment.js';
import {committeeHash} from '../packages/protocol/src/escrow.js';
import {fundingCalldata} from '../packages/protocol/src/funding.js';
import {allocationCalldata} from '../packages/protocol/src/allocation.js';
import {withdrawalCalldata} from '../packages/protocol/src/withdrawal.js';
import {reportDelivery} from '../packages/protocol/src/fulfillment.js';
import {createReport} from '../packages/protocol/src/report.js';
import {escrowPolicy} from '../packages/adapters/src/privy-sender.js';
import {ALLOCATION_POLICY,RELEASE_POLICY,DELIVERY_SCHEMA} from '../packages/protocol/src/escrow.js';
import {day4OriginObservation} from '../scripts/day4-origin-observation.js';

import {day4OriginsFixture as fixture} from './support/day4-origins-fixture.js';

test('synthetic complete origin pipeline binds original CREATEs original paid flow and live records to one finalized anchor',async()=>{
  const x=await fixture(),p=await x.run();assert.equal(p.status,'ORIGINS_VERIFIED');assert.deepEqual(p.flow.finalizedAnchor,p.creations.finalizedAnchor);
  assert.equal(p.deploymentCreationVerified,true);assert.equal(p.providerTransactionRecordsVerified,true);assert.equal(p.historicalPolicyAtSendVerified,false);
  assert.equal(p.officialIntegrationVerified,false);assert.equal(p.withdrawalProviderOriginVerified,false);assert.equal(p.financialAcceptanceStatus,'BLOCKED');assert.equal(p.transactionsSent,0);
  const expected={startedAt:'2026-10-02T19:00:00.000Z',endedAt:'2026-10-02T19:01:00.000Z',sourceCommit:'a'.repeat(40),exitCode:0,
    sourceBindings:[{path:'synthetic-local-source.ts',bytes:10,sha256:'b'.repeat(64)}]};
  const files=new Map<string,Buffer>(),hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
  const artifactBindings=(['gate','escrow'] as const).map(role=>{
    const name=role==='gate'?'CleanverseEligibility':'ContextVoteEscrow',sourcePath=`contracts/src/${name}.sol`,path=`contracts/out/${name}.sol/${name}.json`;
    const source=Buffer.from('// Explicit local synthetic compiler source double'),sourceKeccak=keccak256(toHex(source));files.set(sourcePath,source);
    const compiler={version:'0.8.28+commit.7893614a'},settings={evmVersion:'cancun',viaIR:true,optimizer:{enabled:true,runs:200},compilationTarget:{[`src/${name}.sol`]:name}};
    const raw=Buffer.from(JSON.stringify({...x.artifacts[role],metadata:{compiler,settings,sources:{[`src/${name}.sol`]:{keccak256:sourceKeccak}}}}));files.set(path,raw);
    return {path,bytes:raw.length,sha256:hash(raw),compiler,settings,sources:[{path:sourcePath,bytes:source.length,sha256:hash(source),keccak256:sourceKeccak}]};
  });
  const localReader=(path:string)=>{const value=files.get(path);if(!value)throw Error('LOCAL_SYNTHETIC_FILE_UNAVAILABLE');return value;};
  const report={schemaVersion:1,scope:'READ_ONLY_ORIGINAL_CREATIONS_CHAIN_AND_LIVE_PRIVY_ASSOCIATIONS_NOT_D4_EXTERNAL_ACCEPTANCE',
    startedAt:'2026-10-02T19:00:10.000Z',endedAt:'2026-10-02T19:00:20.000Z',sourceCommit:expected.sourceCommit,sourceBindings:expected.sourceBindings,
    worktreeDirty:true,status:'ORIGINS_VERIFIED',financialAcceptanceStatus:'BLOCKED',officialIntegrationVerified:false,
    historicalPolicyAtSendVerified:false,withdrawalProviderOriginVerified:false,canExecute:false,transactionsSent:0,signaturesRequested:0,
    publicRpcInspectionAttempted:true,privyReadInspectionAttempted:true,privyReadCallsAttempted:6,exitCode:0,artifactBindings,
    inspection:{...p,privy:{...p.privy,observedAtUnixMs:Date.parse('2026-10-02T19:00:15.000Z')}}};
  assert.equal(day4OriginObservation(report,expected,localReader).status,'ORIGINS_VERIFIED');
  const bad=structuredClone(report);bad.inspection.privy.records.funding.hash=h(999);assert.equal(day4OriginObservation(bad,expected,localReader).status,'FAIL');
  const stale=structuredClone(report);stale.inspection.privy.observedAtUnixMs=Date.parse('2026-10-02T18:59:00.000Z');assert.equal(day4OriginObservation(stale,expected,localReader).status,'FAIL');
  for(const patch of [{artifactBindings:[]},{artifactBindings:[...artifactBindings].slice(1)}])assert.equal(day4OriginObservation({...report,...patch},expected,localReader).status,'FAIL');
  const wrongArtifact=structuredClone(report);wrongArtifact.inspection.creations.gate.creationBytecodeHash=h(999);assert.equal(day4OriginObservation(wrongArtifact,expected,localReader).status,'FAIL');
});
test('synthetic provider hash and unknown key mismatch fail before any source query',async()=>{
  const x=await fixture();x.request.privy.transactions.funding.hash=h(999);await assert.rejects(x.run(),/DAY4_ORIGINS_INPUT_INVALID/);assert.equal(x.control.providerCalled,false);
  const y=await fixture();(y.request as unknown as Record<string,unknown>).unexpected=true;await assert.rejects(y.run(),/DAY4_ORIGINS_INPUT_INVALID/);
});
test('synthetic disconnected source roles fail before provider queries',async()=>{
  for(const role of ['asset','gate','reviewer'] as const){const x=await fixture();x.config.flow[role]=a(999);await assert.rejects(x.run(),/DAY4_ORIGINS_CONFIGURATION_MISMATCH/);assert.equal(x.control.providerCalled,false);}
});
test('synthetic two CREATE receipts after original funding cannot prove origin order',async()=>{
  const x=await fixture(),tx=x.creationTransactions.get(h(202))!,receipt=x.creationReceipts.get(h(202))!;
  tx.blockNumber=11n;tx.blockHash=h(11);receipt.blockNumber=11n;receipt.blockHash=h(11);
  await assert.rejects(x.run(),/DAY4_ORIGINS_PROOF_BINDING_INVALID/);
});
test('synthetic finalized tip may advance while the flow stays at the original creation anchor',async()=>{
  const x=await fixture(),original=x.ports.flow.block;x.ports.flow.block=async number=>{if(number===undefined)x.control.tip=31n;return original(number);};
  const p=await x.run();assert.equal(p.flow.finalizedAnchor.number,'30');assert.equal(p.creations.finalizedAnchor.number,'30');assert.equal(x.control.tip,31n);
});
test('synthetic lower finalized tip cannot make the chosen original source anchor final',async()=>{
  const x=await fixture(),original=x.ports.flow.block;x.ports.flow.block=async number=>number===undefined?original(29n):original(number);
  await assert.rejects(x.run(),/DAY4_FLOW_READ_UNAVAILABLE/);
});
test('synthetic chain height drift after live provider reads rejects the whole combined proof',async()=>{
  const x=await fixture();x.control.drift=true;await assert.rejects(x.run(),/DAY4_ORIGINS_SNAPSHOT_CHANGED/);
});
test('synthetic finality regression during live provider reads cannot be replaced by a still canonical historical block',async()=>{
  const x=await fixture();x.control.providerHook=()=>{x.control.tip=29n;};await assert.rejects(x.run(),/DAY4_ORIGINS_FINALITY_MISMATCH/);
});
test('synthetic caller changes during provider awaits cannot redirect frozen original source methods or config',async()=>{
  const x=await fixture();x.control.providerHook=()=>{x.config.flow.asset=a(999);x.config.privy.walletId='substituted-wallet';x.request.flow.transactions.withdrawal=h(999);
    x.ports.flow.block=async()=>{throw Error('SUBSTITUTED_LOCAL_BLOCK');};x.ports.flow.chainId=async()=>143;};
  const p=await x.run();assert.equal(p.flow.asset,a(88));assert.equal(p.privy.walletId,'local-wallet');
});
test('synthetic original finalized tag drift after provider work remains rejected',async()=>{
  const x=await fixture();x.control.providerHook=()=>{x.ports.flow.blockTag='latest' as 'finalized';};await assert.rejects(x.run(),/DAY4_ORIGINS_SNAPSHOT_CHANGED/);
});
test('synthetic invalid port container or source getter cannot publish the underlying exception',async()=>{
  const x=await fixture();
  await assert.rejects(inspectDay4Origins(x.request,x.config,x.artifacts,undefined as unknown as typeof x.ports),/^Error: DAY4_ORIGINS_PORT_INVALID$/);
  const ports=Object.defineProperty({},'flow',{get(){throw Error('PRIVATE_LOCAL_GETTER_DETAIL');}}) as typeof x.ports;
  await assert.rejects(inspectDay4Origins(x.request,x.config,x.artifacts,ports),/^Error: DAY4_ORIGINS_PORT_INVALID$/);
});
test('synthetic original tag getter failure during the provider window has only a fixed public error',async()=>{
  const x=await fixture();x.control.providerHook=()=>{Object.defineProperty(x.ports.flow,'blockTag',{get(){throw Error('PRIVATE_LOCAL_GETTER_DETAIL');}});};
  await assert.rejects(x.run(),/^Error: DAY4_ORIGINS_READ_UNAVAILABLE$/);
});
test('synthetic origin schema rejects malformed role address without throwing and forged cross-source summary',async()=>{
  const x=await fixture(),config={...x.config.creations,deployer:'not-an-address'};assert.doesNotThrow(()=>assert.equal(Day4CreationPairConfigSchema.safeParse(config).success,false));
  const p=await x.run(),bad=structuredClone(p);bad.privy.records.funding.hash=h(999);assert.equal(Day4OriginsProofSchema.safeParse(bad).success,false);
});
