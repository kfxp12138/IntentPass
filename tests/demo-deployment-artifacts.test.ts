import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {keccak256,toHex,type Hex} from 'viem';
import {compileDeploymentArtifacts} from '../scripts/deployment-artifacts.js';
import type {compileDay4OriginArtifacts} from '../scripts/origin-artifacts.js';
import {deploymentArtifactTargets,deploymentArtifactRoles,verifyDay4OriginArtifactBindings,type DeploymentAssetMode,type DeploymentArtifactRole} from '../scripts/origin-artifact-bindings.js';

type Compilation=ReturnType<typeof compileDay4OriginArtifacts>;
type Settings=Compilation['bindings'][number]['settings'];
type Artifact={abi:{type:string;inputs:{type:string}[]}[];bytecode:{object:Hex};deployedBytecode:{object:Hex};
  metadata:{compiler:{version:string};settings:Settings;sources:Record<string,{keccak256:string}>}};
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');

/** Explicit in-memory compiler/source doubles. These tests do not load env,
 * invoke a chain provider, wallet, official getter or the actual compiler. */
function fixture(assetMode:DeploymentAssetMode='demo-erc20'){
  const targets=deploymentArtifactTargets(assetMode),roles=deploymentArtifactRoles(assetMode),files=new Map<string,Buffer>(),reads:string[]=[];
  const shared='contracts/src/IAssetEligibility.sol',dependency='node_modules/@openzeppelin/contracts/token/ERC20/IERC20.sol';
  files.set(shared,Buffer.from('// synthetic fixed interface'));files.set(dependency,Buffer.from('// synthetic IERC20 dependency'));
  const artifacts={} as Record<'gate'|'escrow',Artifact>&{asset?:Artifact},bindings:Compilation['bindings']=[];
  for(const role of roles){
    const target=targets[role]!,source=`contracts/src/${target.file}`;
    files.set(source,Buffer.from(`// synthetic source ${target.name}`));
    const sourcePaths=[source,role==='gate'?shared:dependency];
    const settings:Settings={evmVersion:'cancun',viaIR:true,optimizer:{enabled:true,runs:200},compilationTarget:{[`src/${target.file}`]:target.name}};
    const artifact:Artifact={abi:[{type:'constructor',inputs:[{type:'address'}]}],bytecode:{object:role==='asset'?'0x6003':role==='gate'?'0x6001':'0x6002'},deployedBytecode:{object:'0x6000'},
      metadata:{compiler:{version:'0.8.28+commit.7893614a'},settings,sources:Object.fromEntries(sourcePaths.map(path=>[path.startsWith('contracts/')?path.slice('contracts/'.length):`../${path}`,{keccak256:keccak256(toHex(files.get(path)!))}]))}};
    artifacts[role]=artifact;const bytes=Buffer.from(JSON.stringify(artifact));files.set(target.path,bytes);
    bindings.push({path:target.path,bytes:bytes.length,sha256:sha(bytes),compiler:{...artifact.metadata.compiler},settings:structuredClone(settings),
      sources:sourcePaths.map(path=>({path,bytes:files.get(path)!.length,sha256:sha(files.get(path)!),keccak256:keccak256(toHex(files.get(path)!))}))});
  }
  const result:Compilation={artifacts,bindings,buildExitCode:0};let compilationCalls=0;
  const compile=()=>{compilationCalls++;return result;};
  const readBytes=(path:string)=>{reads.push(path);const value=files.get(path);if(!value)throw Error('Synthetic unknown path');return value;};
  const updateArtifact=(role:DeploymentArtifactRole,mutate:(artifact:Artifact)=>void)=>{
    mutate(artifacts[role]!);const bytes=Buffer.from(JSON.stringify(artifacts[role]));files.set(targets[role]!.path,bytes);
    const binding=bindings.find(value=>value.path===targets[role]!.path)!;binding.bytes=bytes.length;binding.sha256=sha(bytes);
  };
  return {targets,roles,files,reads,shared,dependency,artifacts,bindings,result,compile,readBytes,updateArtifact,get compilationCalls(){return compilationCalls;},
    build:()=>compileDeploymentArtifacts({assetMode,compile,readBytes})};
}

test('synthetic demo route binds precisely token fixed-asset gate and escrow with complete imported source bytes',()=>{
  const f=fixture(),compiled=f.build();assert.equal(f.compilationCalls,1);assert.equal(compiled.assetMode,'demo-erc20');assert.equal(compiled.bindings.length,3);
  assert.equal(compiled.artifacts.asset!.bytecode.object,'0x6003');assert.equal(compiled.creationBytecodeHashes.asset,keccak256('0x6003'));
  assert.equal(compiled.isCurrent(),true);assert.ok(f.reads.includes(f.dependency));assert.ok(f.reads.every(path=>!path.includes('Cleanverse')));
  const log=JSON.parse(compiled.log);assert.equal(log.assetMode,'demo-erc20');assert.equal(log.forcedRebuild,true);assert.equal(log.rawCompilerOutputCaptured,false);
  assert.throws(()=>{compiled.artifacts.asset!.bytecode.object='0x6099';},TypeError);
});
test('synthetic demo and historical manifests cannot be accepted across selected asset modes or default legacy mode',()=>{
  const demo=fixture(),legacy=fixture('cleanverse');assert.equal(legacy.build().bindings.length,2);
  assert.equal(verifyDay4OriginArtifactBindings(demo.bindings,demo.readBytes),false);assert.equal(demo.reads.length,0);
  assert.equal(verifyDay4OriginArtifactBindings(legacy.bindings,legacy.readBytes,undefined,{assetMode:'demo-erc20'}),false);
  assert.equal(legacy.reads.length>0,true);legacy.reads.length=0;
  assert.throws(()=>compileDeploymentArtifacts({assetMode:'demo-erc20',compile:legacy.compile,readBytes:legacy.readBytes}),{message:'DEPLOYMENT_ARTIFACT_SOURCE_MISMATCH'});
  assert.equal(legacy.reads.length,0);
});
test('synthetic demo manifest must contain each fixed role once and never read missing duplicate foreign or traversing targets',()=>{
  for(const mutate of [(f:ReturnType<typeof fixture>)=>{f.bindings.pop();},(f:ReturnType<typeof fixture>)=>{f.bindings[1]=structuredClone(f.bindings[0]);},
    (f:ReturnType<typeof fixture>)=>{f.bindings[0].path='contracts/out/ContextVoteEscrow.sol/CleanverseEligibility.json';},
    (f:ReturnType<typeof fixture>)=>{f.bindings[0].path='/private/synthetic-secret.json';}]){
    const f=fixture();mutate(f);assert.throws(f.build,{message:'DEPLOYMENT_ARTIFACT_SOURCE_MISMATCH'});assert.equal(f.reads.length,0);
  }
});
test('synthetic demo artifact target names and role hashes cannot be substituted despite updated byte bindings',()=>{
  for(const role of ['asset','gate','escrow'] as const){
    const f=fixture(),target=f.targets[role]!;f.updateArtifact(role,artifact=>{artifact.metadata.settings.compilationTarget[`src/${target.file}`]='OtherContract';});
    f.bindings.find(value=>value.path===target.path)!.settings.compilationTarget[`src/${target.file}`]='OtherContract';
    assert.throws(f.build,{message:'DEPLOYMENT_ARTIFACT_SOURCE_MISMATCH'});assert.equal(f.reads.length,0);
  }
  const g=fixture(),compiled=g.build(),hashes=compiled.creationBytecodeHashes;
  assert.equal(verifyDay4OriginArtifactBindings(g.bindings,g.readBytes,{...hashes,asset:hashes.gate,gate:hashes.asset!}, {assetMode:'demo-erc20'}),false);
  assert.equal(verifyDay4OriginArtifactBindings(g.bindings,g.readBytes,{gate:hashes.gate,escrow:hashes.escrow},{assetMode:'demo-erc20'}),false);
});
test('synthetic demo compiler memory cannot replace raw-bound token gate or escrow artifacts',()=>{
  for(const role of ['asset','gate','escrow'] as const)for(const field of ['bytecode','runtime','abi'] as const){
    const f=fixture(),artifact=f.artifacts[role]!;
    if(field==='bytecode')artifact.bytecode.object='0x6099';else if(field==='runtime')artifact.deployedBytecode.object='0x6099';else artifact.abi=[];
    assert.throws(f.build,{message:'DEPLOYMENT_ARTIFACT_SOURCE_MISMATCH'});
  }
});
test('synthetic demo token gate escrow and OpenZeppelin source drift invalidate preparation and every later currentness check',()=>{
  for(const role of ['asset','gate','escrow','dependency'] as const){
    const f=fixture(),compiled=f.build(),source=role==='dependency'?f.dependency:`contracts/src/${f.targets[role]!.file}`;
    f.files.set(source,Buffer.from('// synthetic byte drift'));
    assert.equal(compiled.isCurrent(),false);assert.throws(compiled.assertCurrent,{message:'DEPLOYMENT_ARTIFACT_SOURCE_MISMATCH'});
    assert.throws(f.build,{message:'DEPLOYMENT_ARTIFACT_SOURCE_MISMATCH'});
  }
});
test('synthetic demo asset mode and compiler aliases are captured before readers can mutate caller options',()=>{
  const f=fixture(),options={assetMode:'demo-erc20' as DeploymentAssetMode,compile:f.compile,readBytes:f.readBytes};let first=true;
  options.readBytes=path=>{if(first){first=false;options.assetMode='cleanverse';options.compile=()=>{throw Error('Synthetic changed compiler');};options.readBytes=()=>{throw Error('Synthetic changed reader');};}return f.readBytes(path);};
  const compiled=compileDeploymentArtifacts(options);assert.equal(compiled.assetMode,'demo-erc20');assert.equal(compiled.isCurrent(),true);assert.equal(compiled.bindings.length,3);
});
test('synthetic invalid mode or failed fresh compiler cannot fall back to historical or cached artifacts',()=>{
  const f=fixture();for(const assetMode of ['other',null] as unknown as DeploymentAssetMode[])
    assert.throws(()=>compileDeploymentArtifacts({assetMode,compile:f.compile,readBytes:f.readBytes}),{message:'DEPLOYMENT_ASSET_MODE_INVALID'});
  assert.equal(f.compilationCalls,0);assert.equal(f.reads.length,0);
  assert.throws(()=>compileDeploymentArtifacts({assetMode:'demo-erc20',compile:()=>({...f.result,buildExitCode:1}) as unknown as Compilation,readBytes:f.readBytes}),{message:'DEPLOYMENT_BUILD_UNAVAILABLE'});
  assert.equal(f.reads.length,0);
});
