import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeAbiParameters,type Address,type Hex} from 'viem';
import {deploymentDraft,inspectDeployment,type DeploymentReadPort} from '../packages/protocol/src/deployment.js';
const a=(v:number)=>`0x${v.toString(16).padStart(40,'0')}` as Address,h=(v:number)=>`0x${v.toString(16).padStart(64,'0')}` as Hex;
const config={chainId:'10143',deployer:a(1),asset:a(2),gate:a(3),reviewer:a(4),committee:[a(5),a(6),a(7)]};
const artifact={abi:[{type:'constructor',stateMutability:'nonpayable',inputs:[{type:'address'},{type:'address'},{type:'address'},{type:'address[3]'}]}],bytecode:{object:'0x6000'}};
function port():DeploymentReadPort{return{chainId:async()=>10143,block:async()=>({number:23n,hash:h(23),timestamp:100n}),code:async(address,block)=>{assert.equal(block,23n);return address===a(1)?'0x':'0x6001';},balance:async(_address,block)=>{assert.equal(block,23n);return 100n;}};}
test('deployment draft binds exact constructor and original bytecode without nonce gas signing or broadcast',()=>{
  const draft=deploymentDraft(config,artifact);assert.equal(draft.canExecute,false);assert.equal(draft.officialIntegrationVerified,false);assert.equal(draft.transaction.value,'0');assert.equal(draft.transaction.chainId,'10143');assert.equal(draft.transaction.from,a(1));assert.equal(draft.transaction.data,'0x6000'+draft.constructorArgs.slice(2));
  assert.deepEqual(decodeAbiParameters([{type:'address'},{type:'address'},{type:'address'},{type:'address[3]'}],draft.constructorArgs),[a(2),a(3),a(4),[a(5),a(6),a(7)]]);assert.deepEqual(draft.adminPowers,[]);assert.equal('nonce' in draft.transaction,false);
  for(const input of [{...config,chainId:'31337'},{...config,asset:a(0)},{...config,committee:[a(5),a(5),a(7)]},{...config,privateKey:'forbidden'},{...config,gas:'100'}])assert.throws(()=>deploymentDraft(input,artifact));
  assert.throws(()=>deploymentDraft(config,{...artifact,bytecode:{object:'0x__$unlinked$__'}}));assert.throws(()=>deploymentDraft(config,{...artifact,abi:[]}));assert.throws(()=>deploymentDraft(config,{...artifact,abi:[...artifact.abi,...artifact.abi]}));assert.throws(()=>deploymentDraft(config,{...artifact,abi:[{...artifact.abi[0],inputs:[]}]}));
  assert.notEqual(deploymentDraft({...config,reviewer:a(8)},artifact).initCodeHash,draft.initCodeHash);
});
test('deployment inspection reads one finalized block and rechecks chain hash while never proving eligibility or gas',async()=>{
  const result=await inspectDeployment(config,port());assert.equal(result.status,'INSPECTED');assert.equal(result.nativeBalance,'100');assert.equal(result.canExecute,false);assert.equal(result.gasSufficiencyVerified,false);assert.equal(result.officialIntegrationVerified,false);assert.equal(result.block.number,'23');
  assert.equal((await inspectDeployment(config,{...port(),balance:async()=>0n})).status,'BLOCKED');
  await assert.rejects(inspectDeployment(config,{...port(),chainId:async()=>143}),/CHAIN_MISMATCH/);
  await assert.rejects(inspectDeployment(config,{...port(),block:async()=>({number:null,hash:null,timestamp:0n})}),/FINALIZED_BLOCK_UNAVAILABLE/);
  await assert.rejects(inspectDeployment(config,{...port(),block:async n=>({number:23n,hash:n===undefined?h(23):h(24),timestamp:100n})}),/SNAPSHOT_CHANGED/);
  let count=0;await assert.rejects(inspectDeployment(config,{...port(),chainId:async()=>++count===1?10143:143}),/SNAPSHOT_CHANGED/);
  await assert.rejects(inspectDeployment(config,{...port(),code:async()=>undefined}),/DEPENDENCY_CODE_MISSING/);
  await assert.rejects(inspectDeployment(config,{...port(),code:async()=> '0x6001'}),/CONTRACT_ACCOUNT_UNSUPPORTED/);
  await assert.rejects(inspectDeployment(config,{...port(),balance:async()=>-1n}),/BALANCE_INVALID/);
});
