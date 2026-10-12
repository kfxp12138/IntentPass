import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {getContractAddress,type Address,type Hex} from 'viem';
import {MetaMaskGateDeploymentService,type MetaMaskGateReadPort} from '../scripts/metamask-gate-service.js';
import {DeploymentAttemptStore} from '../packages/storage/src/deployment-attempt-store.js';
// Local interface/bytecode doubles only; these do not prove any official CVI identity.
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address,h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
const runtime=(values:string[])=>`0x${values.map(v=>v.slice(2).padStart(64,'0')).join('')}6000` as Hex;
const config={chainId:'10143',deployer:a(1),asset:a(2),validator:a(3),policy:a(4),reviewer:a(5),committee:[a(6),a(7),a(8)]};
const gateArtifact={abi:[{type:'constructor',stateMutability:'nonpayable',inputs:[{type:'address'},{type:'address'},{type:'address'},{type:'address'}]}],bytecode:{object:'0x6000'},deployedBytecode:{object:runtime(['0x0','0x0','0x0','0x0']),immutableReferences:Object.fromEntries([0,1,2,3].map(i=>[String(i),[{start:i*32,length:32}]])),linkReferences:{}}};
const escrowArtifact={abi:[{type:'constructor',stateMutability:'nonpayable',inputs:[{type:'address'},{type:'address'},{type:'address'},{type:'address[3]'}]}],bytecode:{object:'0x6001'}};
function fixture(t:test.TestContext){
  const root=mkdtempSync(join(tmpdir(),'intentpass-gate-service-')),store=new DeploymentAttemptStore(join(root,'operator.db'));t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const s={now:1000,clean:true,nonce:0n,pending:0n,balance:100000n,fee:10n,priority:1n,estimate:100n,receipt:null as 'success'|'reverted'|null,txFound:true,originalNonce:0,originalGas:120n,originalFee:10n as bigint|null,originalPriority:1n as bigint|null};
  const predicted=getContractAddress({from:a(1),nonce:0n}),pool=getContractAddress({from:a(1),nonce:1n});let service:MetaMaskGateDeploymentService;
  const port:MetaMaskGateReadPort={chainId:async()=>10143,block:async()=>({number:23n,hash:h(23),timestamp:100n}),
    code:async address=>[a(2),a(3),a(4)].includes(address)?'0x6000':'0x',balance:async()=>s.balance,currentBalance:async()=>s.balance,
    nonce:async(_address,tag)=>tag==='pending'?s.pending:s.nonce,assetPolicy:async()=>a(4),fees:async()=>({maxFeePerGas:s.fee,maxPriorityFeePerGas:s.priority}),
    estimate:async tx=>{assert.equal(tx.data,service.plan.data);assert.equal(tx.value,0n);assert.equal(tx.nonce,0);assert.equal('to' in tx,false);return s.estimate;},
    proof:{blockTag:'finalized',chainId:async()=>10143,block:async()=>({number:23n,hash:h(23),timestamp:100n}),
      transaction:async hash=>s.txFound?{hash,from:a(1),to:null,input:service.plan.data as Hex,value:0n,nonce:s.originalNonce,chainId:10143,blockNumber:23n,blockHash:h(23),gas:s.originalGas,maxFeePerGas:s.originalFee,maxPriorityFeePerGas:s.originalPriority}:null,
      receipt:async hash=>s.receipt?{transactionHash:hash,from:a(1),to:null,status:s.receipt,contractAddress:s.receipt==='success'?predicted:null,blockNumber:23n,blockHash:h(23)}:null,
      code:async()=>runtime([a(2),a(3),a(4),pool]),configuration:async()=>({asset:a(2),validator:a(3),policy:a(4),pool})}
  };
  service=new MetaMaskGateDeploymentService({config,gateArtifact,escrowArtifact,nonce:0n,sourceCommit:'a'.repeat(40),sourceClean:()=>s.clean,clock:()=>s.now,store,port});
  return {s,root,store,service,port,predicted,pool};
}
async function submitted(f:ReturnType<typeof fixture>){const check=await f.service.preflight(),reserved=await f.service.reserve({planId:f.service.plan.planId,checkId:check.checkId});f.service.recordHash({planId:f.service.plan.planId,attemptId:reserved.attempt.attemptId,transactionHash:h(100)});return reserved;}
test('gate preflight fixes N/N+1 and budgets only the exact zero-value gate CREATE',async t=>{
  const f=fixture(t),check=await f.service.preflight();assert.equal(check.predictedAddress,f.predicted);assert.equal(f.service.plan.pool,f.pool);assert.equal(check.transaction.nonce,'0x0');assert.equal(check.transaction.value,'0x0');assert.equal('to' in check.transaction,false);assert.equal(check.transaction.gas,'0x78');assert.equal(check.estimatedMaxCost,'1200');assert.equal(check.transaction.data,f.service.plan.data);assert.notEqual(check.transaction.data,f.service.plan.escrowData);assert.equal(f.store.get(f.service.plan.planId),null);assert.equal(f.service.status().officialIntegrationVerified,false);
});
test('observed nonce drift never silently replans the gate or future pool',async t=>{
  const f=fixture(t),original=structuredClone(f.service.plan);f.s.nonce=1n;f.s.pending=1n;await assert.rejects(f.service.preflight(),/FIXED_GATE_NONCE_CHANGED/);assert.deepEqual(f.service.plan,original);assert.equal(f.store.get(original.planId),null);
  f.s.nonce=0n;await assert.rejects(f.service.preflight(),/PENDING_TRANSACTION/);
});
test('dependency code, EOA, occupied future address and asset policy are mandatory',async t=>{
  const f=fixture(t),original=f.port.code;
  for(const address of [a(2),a(3),a(4)]){f.port.code=async(value,block)=>value===address?'0x':original(value,block);await assert.rejects(f.service.preflight(),/DEPENDENCY_CODE_MISSING/);}
  for(const [address,code] of [[a(1),'CONTRACT_ACCOUNT'],[f.predicted,'PREDICTED_ADDRESS'],[f.pool,'PREDICTED_ADDRESS']] as const){f.port.code=async(value,block)=>value===address?'0x6000':original(value,block);await assert.rejects(f.service.preflight(),new RegExp(code));}
  f.port.code=original;f.port.assetPolicy=async()=>a(20);await assert.rejects(f.service.preflight(),/ASSET_POLICY_MISMATCH/);assert.equal(f.store.get(f.service.plan.planId),null);
});
test('source drift and current fee insufficiency cannot prepare or reserve',async t=>{
  const f=fixture(t);f.s.clean=false;await assert.rejects(f.service.preflight(),/SOURCE_REVISION/);f.s.clean=true;const check=await f.service.preflight();f.s.balance=100n;await assert.rejects(f.service.reserve({planId:f.service.plan.planId,checkId:check.checkId}),/BALANCE/);assert.equal(f.store.get(f.service.plan.planId),null);
});
test('invalid fee estimates and gas limits reject before reservation',async t=>{
  const f=fixture(t);for(const values of [{fee:0n},{fee:10n,priority:11n},{priority:-1n},{priority:1n,estimate:0n},{estimate:25_000_001n}]){Object.assign(f.s,values);await assert.rejects(f.service.preflight(),/GAS_OR_FEES/);}assert.equal(f.store.get(f.service.plan.planId),null);
});
test('chain, canonical block and nonce drift during gas estimation reject',async t=>{
  for(const drift of ['chain','block','nonce'] as const){const f=fixture(t),estimate=f.port.estimate;f.port.estimate=async tx=>{const value=await estimate(tx);if(drift==='chain')f.port.chainId=async()=>143;else if(drift==='block')f.port.block=async()=>({number:23n,hash:h(24),timestamp:100n});else {f.s.nonce=1n;f.s.pending=1n;}return value;};await assert.rejects(f.service.preflight(),/SNAPSHOT_CHANGED|FIXED_GATE_NONCE_CHANGED/);assert.equal(f.store.get(f.service.plan.planId),null);}
});
test('expired, changed or forged checks preserve the empty journal',async t=>{
  const f=fixture(t),old=await f.service.preflight();f.s.now=62000;await assert.rejects(f.service.reserve({planId:f.service.plan.planId,checkId:old.checkId}),/EXPIRED/);f.s.now=1000;
  const check=await f.service.preflight();f.s.fee=20n;await assert.rejects(f.service.reserve({planId:f.service.plan.planId,checkId:check.checkId}),/CHANGED/);
  await assert.rejects(f.service.reserve({planId:f.service.plan.planId,checkId:check.checkId,nonce:'0x1'}));assert.equal(f.store.get(f.service.plan.planId),null);
});
test('unknown gate send remains durably locked after restart and source revision change',async t=>{
  const f=fixture(t),check=await f.service.preflight(),r=await f.service.reserve({planId:f.service.plan.planId,checkId:check.checkId});assert.equal(r.attempt.status,'RESERVED');
  f.store.close();const reopened=new DeploymentAttemptStore(join(f.root,'operator.db'));t.after(()=>reopened.close());const restarted=new MetaMaskGateDeploymentService({config,gateArtifact,escrowArtifact,nonce:0n,sourceCommit:'b'.repeat(40),sourceClean:()=>true,store:reopened,port:f.port});assert.equal(restarted.plan.planId,f.service.plan.planId);assert.equal(restarted.status().ready,false);assert.equal(restarted.status().attempt!.transactionHash,null);await assert.rejects(restarted.preflight(),/ALREADY_RESERVED/);
});
test('different gate bytes cannot reserve the same deployment account nonce',async t=>{
  const f=fixture(t),check=await f.service.preflight();await f.service.reserve({planId:f.service.plan.planId,checkId:check.checkId});
  const next=new MetaMaskGateDeploymentService({config,gateArtifact:{...gateArtifact,bytecode:{object:'0x6002'}},escrowArtifact,nonce:0n,sourceCommit:'a'.repeat(40),sourceClean:()=>true,store:f.store,port:{...f.port,estimate:async()=>100n}});const nextCheck=await next.preflight();await assert.rejects(next.reserve({planId:next.plan.planId,checkId:nextCheck.checkId}),/NONCE_ALREADY_RESERVED/);assert.equal(f.store.get(next.plan.planId),null);
});
test('original reserved gas, fees and nonce are required even with matching gate bytes',async t=>{
  const f=fixture(t);await submitted(f);f.s.receipt='success';
  for(const values of [{originalNonce:1},{originalNonce:0,originalGas:121n},{originalGas:0n},{originalGas:120n,originalFee:11n},{originalFee:null},{originalFee:10n,originalPriority:2n},{originalPriority:-1n}]){Object.assign(f.s,values);await assert.rejects(f.service.reconcile(),/RESERVED_TRANSACTION_MISMATCH/);assert.equal(f.store.get(f.service.plan.planId)!.status,'SUBMITTED');}
  f.s.originalPriority=1n;const result=await f.service.reconcile();assert.equal(result.attempt!.status,'CONFIRMED');assert.equal(result.attempt!.contractAddress,f.predicted.toLowerCase());assert.equal(result.proof!.officialIntegrationVerified,false);
});
test('pending, canonical revert and confirmed states retain the single original hash',async t=>{
  const f=fixture(t),r=await submitted(f);assert.equal((await f.service.reconcile()).attempt!.status,'SUBMITTED');f.s.receipt='reverted';assert.equal((await f.service.reconcile()).attempt!.status,'REVERTED');await assert.rejects(f.service.preflight(),/ALREADY_RESERVED/);
  f.s.receipt=null;f.s.txFound=false;await assert.rejects(f.service.reconcile(),/TERMINAL_OBSERVATION_CONFLICT/);assert.equal(f.service.status().attempt!.transactionHash,h(100));assert.throws(()=>f.service.recordHash({planId:f.service.plan.planId,attemptId:r.attempt.attemptId,transactionHash:h(101)}),/RECORD_CONFLICT/);
});
test('constructor inputs and artifact are snapshotted; returned plan and check cannot be mutated',async t=>{
  const f=fixture(t),input=structuredClone(config),artifact=structuredClone(gateArtifact),service=new MetaMaskGateDeploymentService({config:input,gateArtifact:artifact,escrowArtifact,nonce:0n,sourceCommit:'a'.repeat(40),sourceClean:()=>true,store:f.store,port:f.port});input.policy=a(20);artifact.bytecode.object='0x6002';assert.equal(service.plan.policy,a(4));assert.equal(service.plan.data,f.service.plan.data);assert.throws(()=>{service.plan.committee[0]=a(20);},TypeError);const check=await service.preflight();assert.throws(()=>{check.transaction.nonce='0x1';},TypeError);
});
