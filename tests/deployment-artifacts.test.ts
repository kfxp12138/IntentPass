import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {getContractAddress,keccak256,toHex,type Address,type Hex} from 'viem';
import {compileDeploymentArtifacts} from '../scripts/deployment-artifacts.js';
import type {compileDay4OriginArtifacts} from '../scripts/origin-artifacts.js';
import {deploymentDraft} from '../packages/protocol/src/deployment.js';
import {cleanverseBootstrapDraft} from '../packages/protocol/src/cleanverse-bootstrap.js';
import {DeploymentAttemptStore} from '../packages/storage/src/deployment-attempt-store.js';
import {MetaMaskDeploymentService,type MetaMaskReadPort} from '../scripts/metamask-service.js';
import {MetaMaskGateDeploymentService,type MetaMaskGateReadPort} from '../scripts/metamask-gate-service.js';

type Compilation=ReturnType<typeof compileDay4OriginArtifacts>;
type Settings=Compilation['bindings'][number]['settings'];
type Artifact={abi:{type:'constructor';stateMutability:string;inputs:{type:string}[]}[];bytecode:{object:Hex};
  deployedBytecode:{object:Hex;immutableReferences:Record<string,{start:number;length:number}[]>;linkReferences:Record<string,unknown>};
  metadata:{compiler:{version:string};settings:Settings;sources:Record<string,{keccak256:string}>}};
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address,h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
const runtime=(values:string[])=>`0x${values.map(v=>v.slice(2).padStart(64,'0')).join('')}6000` as Hex;
const config={chainId:'10143',deployer:a(1),asset:a(2),gate:a(3),reviewer:a(4),committee:[a(5),a(6),a(7)]};
const gateConfig={chainId:'10143',deployer:a(1),asset:a(2),validator:a(20),policy:a(21),reviewer:a(4),committee:[a(5),a(6),a(7)]};

/** Synthetic compiler-shaped sources/JSON in local memory only. The explicit
 * compiler/reader doubles never invoke Forge, RPC, providers, wallets or env. */
function fixture(){
  const files=new Map<string,Buffer>(),calls:string[]=[],paths={gate:'contracts/out/CleanverseEligibility.sol/CleanverseEligibility.json',escrow:'contracts/out/ContextVoteEscrow.sol/ContextVoteEscrow.json'},
    sources={gate:'contracts/src/CleanverseEligibility.sol',escrow:'contracts/src/ContextVoteEscrow.sol',dependency:'node_modules/@openzeppelin/contracts/token/ERC20/IERC20.sol'};
  for(const path of Object.values(sources))files.set(path,Buffer.from(`// synthetic local source ${path}`));
  const artifacts={} as Record<'gate'|'escrow',Artifact>,bindings:Compilation['bindings']=[];
  for(const role of ['gate','escrow'] as const){
    const name=role==='gate'?'CleanverseEligibility':'ContextVoteEscrow',list=[sources[role],sources.dependency],
      settings={evmVersion:'cancun',viaIR:true,optimizer:{enabled:true,runs:200},compilationTarget:{[`src/${name}.sol`]:name}};
    artifacts[role]={abi:[{type:'constructor',stateMutability:'nonpayable',inputs:(role==='gate'?['address','address','address','address']:['address','address','address','address[3]']).map(type=>({type}))}],
      bytecode:{object:role==='gate'?'0x6001':'0x6002'},
      deployedBytecode:{object:runtime(['0x0','0x0','0x0','0x0']),immutableReferences:Object.fromEntries([0,1,2,3].map(i=>[String(i),[{start:i*32,length:32}]])),linkReferences:{}},
      metadata:{compiler:{version:'0.8.28+commit.7893614a'},settings,sources:Object.fromEntries(list.map(path=>[path.startsWith('contracts/')?path.slice('contracts/'.length):`../${path}`,{keccak256:keccak256(toHex(files.get(path)!))}]))}};
    const bytes=Buffer.from(JSON.stringify(artifacts[role]));files.set(paths[role],bytes);
    bindings.push({path:paths[role],bytes:bytes.length,sha256:sha(bytes),compiler:{...artifacts[role].metadata.compiler},settings:structuredClone(settings),
      sources:list.map(path=>({path,bytes:files.get(path)!.length,sha256:sha(files.get(path)!),keccak256:keccak256(toHex(files.get(path)!))}))});
  }
  const result:Compilation={artifacts,bindings,buildExitCode:0};let compileCalls=0;
  const readBytes=(path:string)=>{calls.push(path);const value=files.get(path);if(!value)throw Error('synthetic unknown file');return value;};
  const compile=()=>{compileCalls++;return result;};
  const updateArtifact=(role:'gate'|'escrow',mutate:(artifact:Artifact)=>void)=>{
    mutate(artifacts[role]);const bytes=Buffer.from(JSON.stringify(artifacts[role]));files.set(paths[role],bytes);
    const binding=bindings.find(value=>value.path===paths[role])!;binding.bytes=bytes.length;binding.sha256=sha(bytes);
  };
  return {files,calls,paths,sources,artifacts,bindings,result,readBytes,compile,updateArtifact,get compileCalls(){return compileCalls;},build:()=>compileDeploymentArtifacts({compile,readBytes})};
}

test('synthetic deployment preparation invokes its compiler once and uses bound frozen zero-value CREATE drafts',()=>{
  const f=fixture(),compiled=f.build();assert.equal(f.compileCalls,1);assert.equal(compiled.isCurrent(),true);
  const escrow=deploymentDraft(config,compiled.artifacts.escrow),bootstrap=cleanverseBootstrapDraft(gateConfig,compiled.artifacts.gate,compiled.artifacts.escrow,0n);
  assert.ok(escrow.transaction.data.startsWith(f.artifacts.escrow.bytecode.object));assert.equal(escrow.transaction.value,'0');assert.equal('to' in escrow.transaction,false);
  assert.ok(bootstrap.gate.transaction.data.startsWith(f.artifacts.gate.bytecode.object));assert.equal(bootstrap.gate.transaction.value,'0');assert.equal(bootstrap.escrow.transaction.value,'0');
  assert.equal(bootstrap.canExecute,false);assert.equal(bootstrap.officialIntegrationVerified,false);
  assert.equal(compiled.creationBytecodeHashes.escrow,escrow.creationBytecodeHash);assert.throws(()=>{compiled.artifacts.gate.bytecode.object='0x6099';},TypeError);
  const log=JSON.parse(compiled.log);assert.equal(log.rawCompilerOutputCaptured,false);assert.equal(log.forcedRebuild,true);assert.deepEqual(log.artifactBindings,compiled.bindings);
});
test('synthetic failed or nonzero compiler never falls back to otherwise valid cached artifacts',()=>{
  for(const compile of [()=>{throw Error('synthetic-private-compiler-error');},()=>({...fixture().result,buildExitCode:1}) as unknown as Compilation]){
    const f=fixture();assert.throws(()=>compileDeploymentArtifacts({compile,readBytes:f.readBytes}),{message:'DEPLOYMENT_BUILD_UNAVAILABLE'});assert.equal(f.calls.length,0);
  }
});
test('synthetic exact target values reject a different contract despite the expected target key',()=>{
  for(const role of ['gate','escrow'] as const){const f=fixture(),name=role==='gate'?'CleanverseEligibility':'ContextVoteEscrow';
    f.updateArtifact(role,artifact=>{artifact.metadata.settings.compilationTarget[`src/${name}.sol`]='AnotherContract';});
    f.bindings.find(value=>value.path===f.paths[role])!.settings.compilationTarget[`src/${name}.sol`]='AnotherContract';
    assert.throws(f.build,{message:'DEPLOYMENT_ARTIFACT_SOURCE_MISMATCH'});assert.equal(f.calls.length,0);
  }
});
test('synthetic compiler EVM viaIR optimizer and source table cannot inherit a valid artifact binding',()=>{
  for(const mutate of [(f:ReturnType<typeof fixture>)=>{f.bindings[0].compiler.version='0.8.29';},
    (f:ReturnType<typeof fixture>)=>{f.bindings[0].settings.evmVersion='paris';},
    (f:ReturnType<typeof fixture>)=>{f.bindings[0].settings.viaIR=false;},
    (f:ReturnType<typeof fixture>)=>{f.bindings[0].settings.optimizer.runs=201;},
    (f:ReturnType<typeof fixture>)=>{f.bindings[0].sources.pop();}]){
    const f=fixture();mutate(f);assert.throws(f.build,{message:'DEPLOYMENT_ARTIFACT_SOURCE_MISMATCH'});
  }
});
test('synthetic fresh source bytes differing from cached metadata reject preparation without editing actual artifacts',()=>{
  for(const source of ['gate','escrow','dependency'] as const){const f=fixture();f.files.set(f.sources[source],Buffer.from('// synthetic source changed since compile'));
    assert.throws(f.build,{message:'DEPLOYMENT_ARTIFACT_SOURCE_MISMATCH'});assert.equal(f.compileCalls,1);
  }
});
test('synthetic compiler memory artifact cannot substitute different bytecode runtime ABI or metadata',()=>{
  for(const mutate of [(a:Artifact)=>{a.bytecode.object='0x6099';},(a:Artifact)=>{a.deployedBytecode.object='0x6099';},
    (a:Artifact)=>{a.abi[0].stateMutability='payable';},(a:Artifact)=>{a.metadata.compiler.version='synthetic-different';}]){
    const f=fixture();mutate(f.artifacts.gate);assert.throws(f.build,{message:'DEPLOYMENT_ARTIFACT_SOURCE_MISMATCH'});
  }
});
test('synthetic alternating same-bytecode artifact reads cannot inject a different memory runtime between checks',()=>{
  const f=fixture(),alternate=structuredClone(f.artifacts.gate);alternate.deployedBytecode.object='0x6099';f.result.artifacts.gate=alternate;
  let reads=0;assert.throws(()=>compileDeploymentArtifacts({compile:f.compile,readBytes:path=>{
    if(path===f.paths.gate&&++reads===3)return Buffer.from(JSON.stringify(alternate));return f.readBytes(path);
  }}),{message:'DEPLOYMENT_ARTIFACT_SOURCE_MISMATCH'});
});
test('synthetic missing duplicated foreign or secret source paths fail before unrestricted file reads',()=>{
  for(const mutate of [(f:ReturnType<typeof fixture>)=>{f.bindings.pop();},
    (f:ReturnType<typeof fixture>)=>{f.bindings[1]=structuredClone(f.bindings[0]);},
    (f:ReturnType<typeof fixture>)=>{f.bindings[0].path='/private/synthetic-secret.json';},
    (f:ReturnType<typeof fixture>)=>{f.bindings[0].sources[0].path='contracts/src/../../synthetic-secret.sol';}]){
    const f=fixture();mutate(f);assert.throws(f.build,{message:'DEPLOYMENT_ARTIFACT_SOURCE_MISMATCH'});assert.equal(f.calls.length,0);
  }
});
test('synthetic post-compile artifact and imported source drift fail every currentness recheck',()=>{
  for(const kind of ['artifact','source'] as const){const f=fixture(),compiled=f.build();
    f.files.set(kind==='artifact'?f.paths.escrow:f.sources.dependency,Buffer.from('synthetic late drift'));
    assert.equal(compiled.isCurrent(),false);assert.throws(compiled.assertCurrent,{message:'DEPLOYMENT_ARTIFACT_SOURCE_MISMATCH'});
  }
});
test('synthetic compiler objects and operation aliases cannot mutate the snapshot or recheck readers',()=>{
  const f=fixture(),options={compile:f.compile,readBytes:f.readBytes};let first=true;
  options.readBytes=path=>{if(first){first=false;f.artifacts.escrow.bytecode.object='0x6099';f.bindings[1].path='/private/synthetic-secret.json';
    options.compile=()=>{throw Error('swapped compiler');};options.readBytes=()=>{throw Error('swapped reader');};}return f.readBytes(path);};
  const compiled=compileDeploymentArtifacts(options);assert.equal(compiled.artifacts.escrow.bytecode.object,'0x6002');assert.equal(compiled.isCurrent(),true);
  assert.equal(f.compileCalls,1);assert.ok(f.calls.every(path=>f.files.has(path)));
});
test('synthetic unreadable malformed or duplicate decoded artifact JSON never exposes raw reader errors',()=>{
  const f=fixture();assert.throws(()=>compileDeploymentArtifacts({compile:f.compile,readBytes:()=>{throw Error('synthetic-private-reader-error');}}),{message:'DEPLOYMENT_ARTIFACT_SOURCE_MISMATCH'});
  for(const bytes of [Buffer.from('not-json'),Buffer.from(f.files.get(f.paths.gate)!.toString().replace('"version":','"version":"wrong","version":'))]){
    const g=fixture();g.files.set(g.paths.gate,bytes);g.bindings[0].bytes=bytes.length;g.bindings[0].sha256=sha(bytes);assert.throws(g.build,{message:'DEPLOYMENT_ARTIFACT_SOURCE_MISMATCH'});
  }
});

function serviceFixture(t:test.TestContext,mode:'gate'|'escrow'){
  const f=fixture(),compiled=f.build(),directory=mkdtempSync(join(tmpdir(),'intentpass-deployment-source-')),store=new DeploymentAttemptStore(join(directory,'operator.db'));
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  let revisionClean=true,onEstimate:(()=>void)|undefined;const predicted=getContractAddress({from:a(1),nonce:0n}),pool=getContractAddress({from:a(1),nonce:1n});
  const base:MetaMaskGateReadPort={chainId:async()=>10143,block:async()=>({number:23n,hash:h(23),timestamp:100n}),
    code:async address=>[a(2),a(20),a(21)].includes(address)?'0x6000':'0x',balance:async()=>100000n,currentBalance:async()=>100000n,
    nonce:async()=>0n,assetPolicy:async()=>a(21),fees:async()=>({maxFeePerGas:10n,maxPriorityFeePerGas:1n}),
    estimate:async tx=>{assert.equal(tx.value,0n);assert.equal('to' in tx,false);onEstimate?.();return 100n;},
    proof:{blockTag:'finalized',chainId:async()=>10143,block:async()=>({number:23n,hash:h(23),timestamp:100n}),transaction:async()=>null,receipt:async()=>null,code:async()=>runtime([a(2),a(20),a(21),pool]),configuration:async()=>({asset:a(2),validator:a(20),policy:a(21),pool})}};
  const sourceClean=()=>revisionClean&&compiled.isCurrent();
  const escrowPort:MetaMaskReadPort={...base,code:async address=>address===a(1)?'0x':address===a(3)?runtime([a(2),a(20),a(21),predicted]):'0x6000',
    gate:async()=>({asset:a(2),validator:a(20),policy:a(21),pool:predicted,assetPolicy:a(21)}),proof:{blockTag:'finalized',chainId:base.chainId,block:base.block,transaction:async()=>null,receipt:async()=>null,code:async()=>{throw Error('synthetic proof unused');},configuration:async()=>{throw Error('synthetic proof unused');}}};
  const service=mode==='gate'?new MetaMaskGateDeploymentService({config:gateConfig,gateArtifact:compiled.artifacts.gate,escrowArtifact:compiled.artifacts.escrow,nonce:0n,sourceCommit:'a'.repeat(40),sourceClean,store,port:base,clock:()=>1000}):
    new MetaMaskDeploymentService({config,artifact:compiled.artifacts.escrow,gateArtifact:compiled.artifacts.gate,sourceCommit:'a'.repeat(40),sourceClean,store,port:escrowPort,clock:()=>1000});
  return {...f,compiled,store,service,setEstimate:(callback:()=>void)=>{onEstimate=callback;},setRevision:(clean:boolean)=>{revisionClean=clean;}};
}
test('synthetic gate and escrow services reject compiled source drift during asynchronous preflight before reservation',async t=>{
  for(const mode of ['gate','escrow'] as const){const f=serviceFixture(t,mode);f.setEstimate(()=>{f.files.set(f.sources.dependency,Buffer.from('// synthetic changed during RPC double'));});
    await assert.rejects(f.service.preflight(),{message:'SOURCE_REVISION_CHANGED'});assert.equal(f.store.get(f.service.plan.planId),null);assert.equal(f.service.status().ready,false);
  }
});
test('synthetic gate and escrow services cannot reserve an earlier check after artifact bytes or revision drift',async t=>{
  for(const mode of ['gate','escrow'] as const)for(const drift of ['artifact','revision'] as const){const f=serviceFixture(t,mode),check=await f.service.preflight();
    if(drift==='artifact')f.files.set(f.paths.gate,Buffer.from('synthetic late artifact drift'));else f.setRevision(false);
    await assert.rejects(f.service.reserve({planId:f.service.plan.planId,checkId:check.checkId}),{message:'SOURCE_REVISION_CHANGED'});
    assert.equal(f.store.get(f.service.plan.planId),null);
  }
});
test('synthetic reserved attempts retain a returned public hash after source drift and never authorize another deployment',async t=>{
  for(const mode of ['gate','escrow'] as const){const f=serviceFixture(t,mode),check=await f.service.preflight(),reserved=await f.service.reserve({planId:f.service.plan.planId,checkId:check.checkId});
    f.files.set(f.sources.dependency,Buffer.from('// synthetic drift after wallet reservation'));
    f.service.recordHash({planId:f.service.plan.planId,attemptId:reserved.attempt.attemptId,transactionHash:h(100)});
    assert.equal(f.store.get(f.service.plan.planId)!.transactionHash,h(100));assert.equal(f.service.status().ready,false);assert.equal(f.service.status().transactionsSentByServer,0);
    await assert.rejects(f.service.preflight(),{message:'SOURCE_REVISION_CHANGED'});
  }
});
