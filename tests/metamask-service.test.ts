import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {getContractAddress,type Address,type Hex} from 'viem';
import {DeploymentAttemptStore} from '../packages/storage/src/deployment-attempt-store.js';
import {MetaMaskDeploymentService,type MetaMaskReadPort} from '../scripts/metamask-service.js';
import {MetaMaskPlanSchema,validateMetaMaskPreflight,metamaskPlan} from '../scripts/metamask-types.js';
import {committeeHash,ALLOCATION_POLICY,RELEASE_POLICY,DELIVERY_SCHEMA} from '../packages/protocol/src/escrow.js';
const a=(v:number)=>`0x${v.toString(16).padStart(40,'0')}` as Address,h=(v:number)=>`0x${v.toString(16).padStart(64,'0')}` as Hex;
const config={chainId:'10143',deployer:a(1),asset:a(2),gate:a(3),reviewer:a(4),committee:[a(5),a(6),a(7)]},commit='a'.repeat(40);
const runtime=(values:string[])=>`0x${values.map(v=>v.slice(2).padStart(64,'0')).join('')}6000` as Hex;
const template={object:runtime(['0x0','0x0','0x0','0x0']),immutableReferences:Object.fromEntries([0,1,2,3].map(i=>[String(i),[{start:i*32,length:32}]])),linkReferences:{}};
const artifact={abi:[{type:'constructor',stateMutability:'nonpayable',inputs:[{type:'address'},{type:'address'},{type:'address'},{type:'address[3]'}]}],bytecode:{object:'0x6000'},deployedBytecode:template},gateArtifact={deployedBytecode:template};
function fixture(t:test.TestContext){
  const root=mkdtempSync(join(tmpdir(),'intentpass-metamask-')),store=new DeploymentAttemptStore(join(root,'operator.db'));t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  let now=1000,clean=true,nonce=0n,pending=0n,balance=100000n,fee=10n,pool=getContractAddress({from:a(1),nonce:0n}),receiptStatus:'success'|'reverted'|null=null,originalNonce=0,originalGas=120n,originalFee=10n,originalPriority=1n,txFound=true;
  const plan=metamaskPlan(config,artifact,commit);
  const port:MetaMaskReadPort={chainId:async()=>10143,block:async()=>({number:23n,hash:h(23),timestamp:100n}),code:async address=>address===a(1)?'0x':address===a(3)?runtime([a(2),a(20),a(21),pool]):'0x6000',balance:async()=>balance,currentBalance:async()=>balance,nonce:async(_address,tag)=>tag==='pending'?pending:nonce,estimate:async tx=>{assert.equal(tx.data,plan.data);assert.equal(tx.value,0n);assert.equal(tx.nonce,Number(pending));assert.equal(tx.maxFeePerGas,fee);assert.equal(tx.maxPriorityFeePerGas,1n);return 100n;},fees:async()=>({maxFeePerGas:fee,maxPriorityFeePerGas:1n}),gate:async()=>({asset:a(2),validator:a(20),policy:a(21),pool,assetPolicy:a(21)}),proof:{blockTag:'finalized',chainId:async()=>10143,block:async()=>({number:23n,hash:h(23),timestamp:100n}),transaction:async hash=>txFound?{hash,from:a(1),to:null,input:plan.data as Hex,value:0n,nonce:originalNonce,chainId:10143,blockNumber:23n,blockHash:h(23),gas:originalGas,maxFeePerGas:originalFee,maxPriorityFeePerGas:originalPriority}:null,receipt:async hash=>receiptStatus?{transactionHash:hash,from:a(1),to:null,status:receiptStatus,contractAddress:receiptStatus==='success'?pool:null,blockNumber:23n,blockHash:h(23)}:null,code:async()=>runtime([a(2),a(3),a(4),committeeHash(config.committee)]),configuration:async()=>({asset:a(2),gate:a(3),reviewer:a(4),committee:config.committee,committeeHash:committeeHash(config.committee),allocationPolicy:ALLOCATION_POLICY,releasePolicy:RELEASE_POLICY,deliverySchema:DELIVERY_SCHEMA})}};
  const service=new MetaMaskDeploymentService({config,artifact,gateArtifact,sourceCommit:commit,sourceClean:()=>clean,clock:()=>now,store,port});
  return {root,store,port,service,plan,set:(v:{now?:number;clean?:boolean;nonce?:bigint;pending?:bigint;balance?:bigint;fee?:bigint;pool?:Address;receiptStatus?:typeof receiptStatus;originalNonce?:number;originalGas?:bigint;originalFee?:bigint;originalPriority?:bigint;txFound?:boolean})=>{if(v.now!==undefined)now=v.now;if(v.clean!==undefined)clean=v.clean;if(v.nonce!==undefined)nonce=v.nonce;if(v.pending!==undefined)pending=v.pending;if(v.balance!==undefined)balance=v.balance;if(v.fee!==undefined)fee=v.fee;if(v.pool!==undefined)pool=v.pool;if(v.receiptStatus!==undefined)receiptStatus=v.receiptStatus;if(v.originalNonce!==undefined)originalNonce=v.originalNonce;if(v.originalGas!==undefined)originalGas=v.originalGas;if(v.originalFee!==undefined)originalFee=v.originalFee;if(v.originalPriority!==undefined)originalPriority=v.originalPriority;if(v.txFound!==undefined)txFound=v.txFound;}};
}
test('operator preflight binds current CREATE pool, gate runtime, exact bytes and fee cost without sending',async t=>{
  const f=fixture(t),check=await f.service.preflight();assert.equal(check.transaction.nonce,'0x0');assert.equal(check.transaction.gas,'0x78');assert.equal(check.estimatedMaxCost,'1200');assert.equal(check.predictedAddress,getContractAddress({from:a(1),nonce:0n}));assert.equal('to' in check.transaction,false);assert.equal(check.transaction.value,'0x0');assert.equal(f.store.get(f.plan.planId),null);assert.equal(f.service.status().officialIntegrationVerified,false);
  assert.throws(()=>metamaskPlan({...config,chainId:'143'},artifact,commit),/TESTNET/);
  for(const changed of [{...f.plan,asset:a(30)},{...f.plan,planId:h(30)},{...f.plan,initCodeHash:h(30)},{...f.plan,committee:[a(5),a(5),a(7)]}])assert.equal(MetaMaskPlanSchema.safeParse(changed).success,false);
  assert.throws(()=>validateMetaMaskPreflight(f.plan,{...check,predictedAddress:a(30)}),/PLAN_MISMATCH/);
  assert.throws(()=>validateMetaMaskPreflight(f.plan,{...check,transaction:{...check.transaction,to:a(30)}}));
});
test('nonce queue, wrong future pool and altered gate runtime cannot prepare a transaction',async t=>{
  const f=fixture(t);f.set({pending:1n});await assert.rejects(f.service.preflight(),/NONCE/);f.set({pending:0n,pool:a(30)});await assert.rejects(f.service.preflight(),/GATE_POOL/);
  f.set({pool:getContractAddress({from:a(1),nonce:0n})});const original=f.port.code;f.port.code=async(address,block)=>address===a(3)?'0x6000':original(address,block);await assert.rejects(f.service.preflight(),/RUNTIME/);assert.equal(f.store.get(f.plan.planId),null);
});
test('source drift, insufficient fee balance and future pool role conflict are blocked',async t=>{
  const f=fixture(t);f.set({clean:false});await assert.rejects(f.service.preflight(),/SOURCE_REVISION/);f.set({clean:true,balance:100n});await assert.rejects(f.service.preflight(),/BALANCE/);
  const config2={...config,reviewer:getContractAddress({from:a(1),nonce:0n})},service=new MetaMaskDeploymentService({config:config2,artifact,gateArtifact,sourceCommit:commit,sourceClean:()=>true,store:f.store,port:f.port});await assert.rejects(service.preflight(),/FUTURE_ADDRESS_ROLE/);
});
test('a sufficient finalized balance cannot reserve when current pending balance cannot pay the cap',async t=>{
  const f=fixture(t);f.port.currentBalance=async()=>100n;await assert.rejects(f.service.preflight(),/BALANCE/);assert.equal(f.store.get(f.plan.planId),null);
  f.port.currentBalance=async()=>100000n;const check=await f.service.preflight();f.port.currentBalance=async()=>100n;await assert.rejects(f.service.reserve({planId:f.plan.planId,checkId:check.checkId}),/BALANCE/);assert.equal(f.store.get(f.plan.planId),null);
});
test('expired or changed preflight never reserves; rechecked fixed transaction reserves once',async t=>{
  const f=fixture(t),old=await f.service.preflight();f.set({now:62000});await assert.rejects(f.service.reserve({planId:f.plan.planId,checkId:old.checkId}),/EXPIRED/);assert.equal(f.store.get(f.plan.planId),null);
  f.set({now:1000});const check=await f.service.preflight();f.set({fee:20n});await assert.rejects(f.service.reserve({planId:f.plan.planId,checkId:check.checkId}),/CHANGED/);assert.equal(f.store.get(f.plan.planId),null);
  const next=await f.service.preflight(),reserved=await f.service.reserve({planId:f.plan.planId,checkId:next.checkId});assert.equal(reserved.attempt.status,'RESERVED');assert.equal(reserved.attempt.nonce,next.transaction.nonce);assert.equal(f.service.status().ready,false);await assert.rejects(f.service.preflight(),/ALREADY_RESERVED/);await assert.rejects(f.service.reserve({planId:f.plan.planId,checkId:next.checkId}),/EXPIRED/);
});
test('reconcile binds original reserved nonce and approved gas/fees, not an old matching deployment',async t=>{
  const f=fixture(t),check=await f.service.preflight(),r=await f.service.reserve({planId:f.plan.planId,checkId:check.checkId});f.service.recordHash({planId:f.plan.planId,attemptId:r.attempt.attemptId,transactionHash:h(100)});f.set({receiptStatus:'success',originalNonce:1});await assert.rejects(f.service.reconcile(),/RESERVED_TRANSACTION_MISMATCH/);
  for(const mismatch of [{originalNonce:0,originalGas:121n},{originalGas:120n,originalFee:11n},{originalFee:10n,originalPriority:2n}]){f.set(mismatch);await assert.rejects(f.service.reconcile(),/RESERVED_TRANSACTION_MISMATCH/);}
  assert.equal(f.store.get(f.plan.planId)!.status,'SUBMITTED');f.set({originalPriority:1n});const result=await f.service.reconcile();assert.equal(result.attempt!.status,'CONFIRMED');assert.equal(result.proof!.officialIntegrationVerified,false);f.set({receiptStatus:null,txFound:false});await assert.rejects(f.service.reconcile(),/TERMINAL_OBSERVATION/);assert.equal(f.store.get(f.plan.planId)!.status,'CONFIRMED');
});
test('missing canonical receipt remains submitted; independently proven revert stays locked',async t=>{
  const f=fixture(t),check=await f.service.preflight(),r=await f.service.reserve({planId:f.plan.planId,checkId:check.checkId});f.service.recordHash({planId:f.plan.planId,attemptId:r.attempt.attemptId,transactionHash:h(100)});assert.equal((await f.service.reconcile()).attempt!.status,'SUBMITTED');f.set({receiptStatus:'reverted'});assert.equal((await f.service.reconcile()).attempt!.status,'REVERTED');await assert.rejects(f.service.preflight(),/ALREADY_RESERVED/);
});
