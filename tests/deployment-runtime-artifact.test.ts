import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {getContractAddress,keccak256,type Address,type Hex} from 'viem';
import {verifyDeploymentRuntime} from '../packages/protocol/src/deployment-proof.js';
import {DeploymentAttemptStore} from '../packages/storage/src/deployment-attempt-store.js';
import {compileDeploymentArtifacts} from '../scripts/deployment-artifacts.js';
import {MetaMaskDemoDependencyService} from '../scripts/metamask-demo-service.js';
import type {DemoDependencyReadPort} from '../scripts/demo-dependency.js';

const runtime='0x6001600200' as Hex;
const withoutReferences={deployedBytecode:{object:runtime,linkReferences:{}}};
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address;
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;

// Local shape doubles exercise the immutable-free Foundry omission. They do not
// assert that any contract exists on a public chain.
test('immutable-free compiler runtime accepts omitted references without mutating the artifact',()=>{
  const artifact=structuredClone(withoutReferences),before=JSON.stringify(artifact);
  assert.equal(verifyDeploymentRuntime(artifact,runtime,[]),keccak256(runtime));
  assert.equal(JSON.stringify(artifact),before);
  assert.equal(Object.hasOwn(artifact.deployedBytecode,'immutableReferences'),false);
  assert.equal(verifyDeploymentRuntime({deployedBytecode:{...artifact.deployedBytecode,immutableReferences:{}}},runtime,[]),keccak256(runtime));
});
test('omitted immutable references cannot satisfy expected constructor values or changed runtime bytes',()=>{
  assert.throws(()=>verifyDeploymentRuntime(withoutReferences,runtime,[a(1)]),/DEPLOYMENT_RUNTIME_MISMATCH/);
  for(const changed of ['0x6001600201','0x60016002','0x600160020000'] as Hex[])
    assert.throws(()=>verifyDeploymentRuntime(withoutReferences,changed,[]),/DEPLOYMENT_RUNTIME_MISMATCH/);
  for(const invalid of ['0x','0x1','0xzz'] as Hex[])
    assert.throws(()=>verifyDeploymentRuntime(withoutReferences,invalid,[]));
});
test('optional immutable references still reject null malformed records and invalid immutable layout',()=>{
  for(const immutableReferences of [null,[],1,'',false,{bad:[]},{bad:[{start:-1,length:32}]},{bad:[{start:0,length:31}]},
    {bad:[{start:0,length:32,extra:true}]},{bad:[{start:999,length:32}]}])
    assert.throws(()=>verifyDeploymentRuntime({deployedBytecode:{...withoutReferences.deployedBytecode,immutableReferences}},runtime,[]));
  const template=('0x'+'0'.repeat(64)) as Hex;
  const overlap={deployedBytecode:{object:template,linkReferences:{},immutableReferences:{first:[{start:0,length:32}],second:[{start:0,length:32}]}}};
  assert.throws(()=>verifyDeploymentRuntime(overlap,template,[a(0),a(0)]),/DEPLOYMENT_IMMUTABLE_LAYOUT_INVALID/);
});
test('omitted immutable references do not bypass required runtime structure or unlinked bytecode checks',()=>{
  assert.throws(()=>verifyDeploymentRuntime({deployedBytecode:{object:runtime,linkReferences:{Library:[]}}},runtime,[]),/DEPLOYMENT_LINKED_RUNTIME_UNSUPPORTED/);
  for(const artifact of [{},{deployedBytecode:null},{deployedBytecode:{object:runtime}},{deployedBytecode:{object:runtime,linkReferences:null}},
    {deployedBytecode:{object:'0xzz',linkReferences:{}}}])assert.throws(()=>verifyDeploymentRuntime(artifact,runtime,[]));
});

// Opt in explicitly for the actual, forced compiler + original-byte/source
// binding path. Read ports and the private temporary SQLite journal below are
// doubles; this is not a public deployment or financial acceptance proof.
test('fresh offline Foundry artifact confirms local ASSET journal and passes GATE asset preflight without adding references',{
  skip:process.env.INTENTPASS_RUNTIME_ARTIFACT_INTEGRATION!=='1'
},async t=>{
  assert.equal(process.env.FOUNDRY_OFFLINE,'true','actual compiler regression must run offline');
  const compiled=compileDeploymentArtifacts({assetMode:'demo-erc20'});
  assert.equal(compiled.buildExitCode,0);assert.equal(compiled.isCurrent(),true);
  const artifact=compiled.artifacts.asset! as unknown as {deployedBytecode:{object:Hex;linkReferences:Record<string,unknown>;immutableReferences?:unknown}};
  assert.equal(Object.hasOwn(artifact.deployedBytecode,'immutableReferences'),false,'pinned real Foundry token omits this field');
  const path='contracts/out/IntentPassDemoToken.sol/IntentPassDemoToken.json',original=readFileSync(path),tokenRuntime=artifact.deployedBytecode.object;
  assert.equal(verifyDeploymentRuntime(artifact,tokenRuntime,[]),keccak256(tokenRuntime));
  const folder=mkdtempSync(join(tmpdir(),'intentpass-runtime-artifact-')),store=new DeploymentAttemptStore(join(folder,'operator.db'));
  t.after(()=>{store.close();rmSync(folder,{recursive:true,force:true});});
  const deployer=a(1),asset=getContractAddress({from:deployer,nonce:0n}),hash=h(100),sourceCommit='a'.repeat(40);
  let mined=false,nonce=0n;
  let service:MetaMaskDemoDependencyService;
  const calls={token:0,gate:0,transaction:0};
  const port:DemoDependencyReadPort={chainId:async()=>10143,
    block:async number=>({number:number??23n,hash:h(Number(number??23n)),timestamp:100n}),
    code:async(address,block)=>{assert.equal(block,23n);return mined&&address.toLowerCase()===asset.toLowerCase()?tokenRuntime:'0x';},
    nonce:async()=>nonce,balance:async()=>10n**20n,fees:async()=>({maxFeePerGas:10n,maxPriorityFeePerGas:1n}),estimate:async()=>1_000_000n,
    token:async(address,block)=>{calls.token++;assert.equal(address.toLowerCase(),asset.toLowerCase());assert.equal(block,23n);
      return {name:'IntentPass TEST ONLY Demo Token',symbol:'IPTEST',decimals:6,totalSupply:1_000_000_000_000n};},
    gate:async()=>{calls.gate++;throw Error('local ASSET and GATE preflight must not read a deployed gate');},
    transaction:async requested=>{calls.transaction++;assert.equal(requested,hash);return {hash,from:deployer,to:null,input:service.plan.data as Hex,
      value:0n,chainId:10143,nonce:0,blockNumber:20n,blockHash:h(20),gas:1_000_000n,maxFeePerGas:10n,maxPriorityFeePerGas:1n};},
    receipt:async requested=>{assert.equal(requested,hash);return {transactionHash:hash,from:deployer,to:null,status:'success',contractAddress:asset,blockNumber:20n,blockHash:h(20)};}};
  service=new MetaMaskDemoDependencyService({dependency:'ASSET',config:{chainId:'10143',deployer},artifact,assetArtifact:artifact,
    sourceCommit,sourceClean:()=>compiled.isCurrent(),store,port});
  const preflight=await service.preflight(),reservation=await service.reserve({planId:service.plan.planId,checkId:preflight.checkId});
  service.recordHash({planId:service.plan.planId,attemptId:reservation.attempt.attemptId,transactionHash:hash});
  assert.equal(store.get(service.plan.planId)!.status,'SUBMITTED');
  mined=true;
  const reconciled=await service.reconcile();
  assert.equal(reconciled.proof!.status,'CONFIRMED');assert.equal(reconciled.proof!.runtimeCodeHash,keccak256(tokenRuntime));
  assert.equal(reconciled.proof!.identityVerification,false);assert.equal(reconciled.proof!.transactionsSent,0);
  assert.equal(reconciled.attempt!.status,'CONFIRMED');const confirmedAddress=reconciled.attempt!.contractAddress;
  assert.ok(confirmedAddress);assert.equal(confirmedAddress.toLowerCase(),asset.toLowerCase());
  nonce=1n;
  const gateService=new MetaMaskDemoDependencyService({dependency:'GATE',config:{chainId:'10143',deployer,asset},artifact:compiled.artifacts.gate,
    assetArtifact:artifact,sourceCommit,sourceClean:()=>compiled.isCurrent(),store,port});
  const gatePreflight=await gateService.preflight();
  assert.equal(gatePreflight.transaction.nonce,'0x1');assert.equal(gatePreflight.transaction.value,'0x0');
  assert.equal(gateService.plan.asset!.toLowerCase(),asset.toLowerCase());assert.notEqual(gateService.plan.planId,service.plan.planId);
  assert.equal(store.get(gateService.plan.planId),null);assert.equal(calls.token,2);assert.equal(calls.gate,0);assert.equal(calls.transaction,1);
  assert.deepEqual(readFileSync(path),original);assert.equal(Object.hasOwn(artifact.deployedBytecode,'immutableReferences'),false);
  assert.equal(compiled.isCurrent(),true);
});
