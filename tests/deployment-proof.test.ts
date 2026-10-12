import test from 'node:test';
import assert from 'node:assert/strict';
import {getContractAddress,type Address,type Hex} from 'viem';
import {deploymentDraft} from '../packages/protocol/src/deployment.js';
import {verifyDeploymentCreation,verifyDeploymentRuntime,type DeploymentProofPort} from '../packages/protocol/src/deployment-proof.js';
import {ALLOCATION_POLICY,RELEASE_POLICY,DELIVERY_SCHEMA} from '../packages/protocol/src/escrow.js';
const a=(v:number)=>`0x${v.toString(16).padStart(40,'0')}` as Address,h=(v:number)=>`0x${v.toString(16).padStart(64,'0')}` as Hex;
const config={chainId:'10143',deployer:a(1),asset:a(2),gate:a(3),reviewer:a(4),committee:[a(5),a(6),a(7)]};
const artifact={abi:[{type:'constructor',stateMutability:'nonpayable',inputs:[{type:'address'},{type:'address'},{type:'address'},{type:'address[3]'}]}],bytecode:{object:'0x6000'},deployedBytecode:{object:'0x6000'+'0'.repeat(320),linkReferences:{},immutableReferences:{asset:[{start:2,length:32},{start:130,length:32}],gate:[{start:34,length:32}],reviewer:[{start:66,length:32}],committee:[{start:98,length:32}]}}};
const draft=deploymentDraft(config,artifact),word=(v:string)=>v.slice(2).padStart(64,'0'),runtime=('0x6000'+[config.asset,config.gate,config.reviewer,draft.committeeHash,config.asset].map(word).join('')) as Hex,contract=getContractAddress({from:config.deployer,nonce:2n});
const tx={hash:h(1),from:a(1),to:null,input:draft.transaction.data,value:0n,nonce:2,blockNumber:20n,blockHash:h(20),chainId:10143};
const receipt={transactionHash:h(1),from:a(1),to:null,status:'success' as const,contractAddress:contract,blockNumber:20n,blockHash:h(20)};
const current={asset:config.asset,gate:config.gate,reviewer:config.reviewer,committee:config.committee,committeeHash:draft.committeeHash,allocationPolicy:ALLOCATION_POLICY,releasePolicy:RELEASE_POLICY,deliverySchema:DELIVERY_SCHEMA};
function port():DeploymentProofPort{return{blockTag:'finalized',chainId:async()=>10143,block:async n=>({number:n??23n,hash:h(Number(n??23n)),timestamp:100n}),transaction:async()=>tx,receipt:async()=>receipt,code:async(_a,n)=>{assert.equal(n,23n);return runtime;},configuration:async(address,n)=>{assert.equal(address,contract);assert.equal(n,23n);return current;}};}
test('deployment proof binds original creation calldata canonical finalized receipt address runtime and all fixed configuration',async()=>{
  const result=await verifyDeploymentCreation(config,artifact,h(1),port());assert.equal(result.status,'CONFIRMED');assert.equal(result.officialIntegrationVerified,false);assert.equal(result.transactionsSent,0);assert.equal(result.contractAddress,contract);assert.equal(result.scope,'FINALIZED_ORIGINAL_DEPLOYMENT_CREATION_PROOF');
  await assert.rejects(verifyDeploymentCreation({...config,chainId:'31337'},artifact,h(1),port()));
  const local=await verifyDeploymentCreation({...config,chainId:'31337'},artifact,h(1),{...port(),blockTag:'latest',chainId:async()=>31337,transaction:async()=>({...tx,chainId:31337})},{local:true});assert.equal(local.scope,'LOCAL_TEST_DEPLOYMENT_CREATION_PROOF');assert.equal(local.status,'CONFIRMED');
});
test('deployment proof rejects replaced transaction receipt runtime immutable words and fixed member or policy configuration',async()=>{
  for(const patch of [{hash:h(2)},{from:a(8)},{to:a(8)},{value:1n},{input:'0x6001' as Hex},{chainId:143},{nonce:-1},{blockHash:h(19)}])await assert.rejects(verifyDeploymentCreation(config,artifact,h(1),{...port(),transaction:async()=>({...tx,...patch})}),/MISMATCH/);
  for(const patch of [{transactionHash:h(2)},{from:a(8)},{to:a(8)},{contractAddress:a(8)},{blockHash:h(19)}])await assert.rejects(verifyDeploymentCreation(config,artifact,h(1),{...port(),receipt:async()=>({...receipt,...patch})}),/MISMATCH/);
  await assert.rejects(verifyDeploymentCreation(config,artifact,h(1),{...port(),block:async n=>({number:n??23n,hash:h(n===20n?19:23),timestamp:100n})}),/NOT_CANONICAL/);
  for(const patch of [{asset:a(8)},{gate:a(8)},{reviewer:a(8)},{committee:[a(5),a(7),a(6)]},{committeeHash:h(8)},{allocationPolicy:h(8)},{releasePolicy:h(8)},{deliverySchema:h(8)}])await assert.rejects(verifyDeploymentCreation(config,artifact,h(1),{...port(),configuration:async()=>({...current,...patch})}),/CONFIGURATION_MISMATCH/);
  await assert.rejects(verifyDeploymentCreation(config,artifact,h(1),{...port(),code:async()=>undefined}),/CODE_MISSING/);
  const expected=[config.asset,config.gate,config.reviewer,draft.committeeHash];
  assert.throws(()=>verifyDeploymentRuntime(artifact,('0x6001'+runtime.slice(6)) as Hex,expected),/RUNTIME_MISMATCH/);
  assert.throws(()=>verifyDeploymentRuntime(artifact,(runtime.slice(0,-2)+'ff') as Hex,expected),/IMMUTABLE_INCONSISTENT/);
  assert.throws(()=>verifyDeploymentRuntime({...artifact,deployedBytecode:{...artifact.deployedBytecode,immutableReferences:{...artifact.deployedBytecode.immutableReferences,bad:[{start:2,length:32}]}}},runtime,expected),/LAYOUT_INVALID/);
  assert.throws(()=>verifyDeploymentRuntime({...artifact,deployedBytecode:{...artifact.deployedBytecode,immutableReferences:{bad:[{start:1000,length:32}]}}},runtime,expected),/LAYOUT_INVALID/);
});
test('deployment proof pending reverted orphaned and changing chain results cannot claim creation confirmation',async()=>{
  const noRead={code:async()=>{throw Error('must not read');},configuration:async()=>{throw Error('must not read');}};
  assert.equal((await verifyDeploymentCreation(config,artifact,h(1),{...port(),...noRead,transaction:async()=>null,receipt:async()=>null})).status,'PENDING');
  assert.equal((await verifyDeploymentCreation(config,artifact,h(1),{...port(),...noRead,receipt:async()=>null})).status,'PENDING');
  assert.equal((await verifyDeploymentCreation(config,artifact,h(1),{...port(),...noRead,transaction:async()=>({...tx,blockNumber:24n,blockHash:h(24)}),receipt:async()=>({...receipt,blockNumber:24n,blockHash:h(24)})})).status,'PENDING');
  assert.equal((await verifyDeploymentCreation(config,artifact,h(1),{...port(),...noRead,receipt:async()=>({...receipt,status:'reverted',contractAddress:null})})).status,'REVERTED');
  await assert.rejects(verifyDeploymentCreation(config,artifact,h(1),{...port(),transaction:async()=>null}),/TRANSACTION_UNAVAILABLE/);
  await assert.rejects(verifyDeploymentCreation(config,artifact,h(1),{...port(),blockTag:'latest'}),/BLOCK_TAG_INVALID/);
  let count=0;await assert.rejects(verifyDeploymentCreation(config,artifact,h(1),{...port(),chainId:async()=>++count===1?10143:143}),/SNAPSHOT_CHANGED/);
  await assert.rejects(verifyDeploymentCreation(config,artifact,h(1),{...port(),block:async n=>({number:n??23n,hash:n===23n?h(24):h(Number(n??23n)),timestamp:100n})}),/SNAPSHOT_CHANGED/);
});
