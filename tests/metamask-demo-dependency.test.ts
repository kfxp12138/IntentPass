import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {concatHex,encodeAbiParameters,getContractAddress,keccak256,toBytes,type Address,type Hex} from 'viem';
import {DeploymentAttemptStore} from '../packages/storage/src/deployment-attempt-store.js';
import {demoDependencyPlan,inspectDemoDependency,verifyDemoDependencyCreation,type DemoDependencyReadPort} from '../scripts/demo-dependency.js';
import {MetaMaskDemoDependencyService} from '../scripts/metamask-demo-service.js';
import {MetaMaskDemoDependencyPlanSchema,MetaMaskWalletPlanSchema,validateMetaMaskPreflight} from '../scripts/metamask-types.js';

// Explicit local bytecode/getter/RPC doubles only. No actual compiler, env,
// wallet, RPC request, public deployment, or identity evidence is used here.
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address;
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
const DEPLOYER=a(1),ASSET=a(2),HASH=h(100),COMMIT='a'.repeat(40);
const constructor={type:'constructor',stateMutability:'nonpayable',inputs:[{type:'address'}]};
const tokenRuntime='0x6001600200' as Hex;
const tokenArtifact={abi:[constructor],bytecode:{object:'0x60016000'},deployedBytecode:{object:tokenRuntime,immutableReferences:{},linkReferences:{}}};
const gateRuntime=(asset:Address)=>`0x6001${asset.slice(2).padStart(64,'0')}6002` as Hex;
const gateArtifact={abi:[constructor],bytecode:{object:'0x60026000'},deployedBytecode:{object:`0x6001${'0'.repeat(64)}6002`,immutableReferences:{asset:[{start:2,length:32}]},linkReferences:{}}};
const tokenConfiguration={name:'IntentPass TEST ONLY Demo Token',symbol:'IPTEST',decimals:6,totalSupply:1_000_000_000_000n};
type Transaction=NonNullable<Awaited<ReturnType<DemoDependencyReadPort['transaction']>>>;
type Receipt=NonNullable<Awaited<ReturnType<DemoDependencyReadPort['receipt']>>>;

function fixture(t:test.TestContext,dependency:'ASSET'|'GATE'='ASSET'){
  const root=mkdtempSync(join(tmpdir(),'intentpass-demo-dependency-'));
  const store=new DeploymentAttemptStore(join(root,'operator.db')),stores=[store];
  t.after(()=>{for(const opened of stores)opened.close();rmSync(root,{recursive:true,force:true});});
  const state={now:1_700_000_000_000,clean:true,chain:10143,pending:2n,latest:2n,balance:100000n,fee:10n,priority:1n,estimate:100n,
    accountCode:'0x' as Hex,txFound:true,receiptStatus:null as 'success'|'reverted'|null,
    originalNonce:2,originalGas:120n,originalFee:10n as bigint|null,originalPriority:1n as bigint|null,
    txPatch:{} as Partial<Transaction>,receiptPatch:{} as Partial<Receipt>,token:{...tokenConfiguration},gateAsset:ASSET};
  const calls={estimate:0,transaction:0,receipt:0,token:0,gate:0,code:[] as {address:Address;block:bigint}[]};
  const codeOverrides=new Map<string,Hex|undefined>();
  let service:MetaMaskDemoDependencyService;
  const predicted=getContractAddress({from:DEPLOYER,nonce:2n});
  const port:DemoDependencyReadPort={
    chainId:async()=>state.chain,
    block:async number=>({number:number??23n,hash:h(Number(number??23n)),timestamp:100n}),
    code:async(address,block)=>{
      calls.code.push({address,block});
      if(codeOverrides.has(address.toLowerCase()))return codeOverrides.get(address.toLowerCase());
      if(address.toLowerCase()===DEPLOYER.toLowerCase())return state.accountCode;
      if(address.toLowerCase()===ASSET.toLowerCase())return tokenRuntime;
      if(address.toLowerCase()===predicted.toLowerCase())return state.receiptStatus==='success'?(dependency==='ASSET'?tokenRuntime:gateRuntime(ASSET)):'0x';
      return '0x';
    },
    nonce:async(address,tag)=>{assert.equal(address,DEPLOYER);return tag==='pending'?state.pending:state.latest;},
    balance:async address=>{assert.equal(address,DEPLOYER);return state.balance;},
    fees:async()=>({maxFeePerGas:state.fee,maxPriorityFeePerGas:state.priority}),
    estimate:async tx=>{
      calls.estimate++;assert.equal(tx.account,DEPLOYER);assert.equal(tx.data,service.plan.data);assert.equal(tx.value,0n);
      assert.equal(tx.nonce,Number(state.pending));assert.equal(tx.maxFeePerGas,state.fee);assert.equal(tx.maxPriorityFeePerGas,state.priority);
      assert.equal('to' in tx,false);return state.estimate;
    },
    token:async(_address,block)=>{calls.token++;assert.equal(block,23n);return {...state.token};},
    gate:async(_address,block)=>{calls.gate++;assert.equal(block,23n);return {asset:state.gateAsset};},
    transaction:async hash=>{
      calls.transaction++;assert.equal(hash,HASH);
      return state.txFound?{hash,from:DEPLOYER,to:null,input:service.plan.data as Hex,value:0n,chainId:10143,nonce:state.originalNonce,
        blockNumber:20n,blockHash:h(20),gas:state.originalGas,maxFeePerGas:state.originalFee,maxPriorityFeePerGas:state.originalPriority,...state.txPatch}:null;
    },
    receipt:async hash=>{
      calls.receipt++;assert.equal(hash,HASH);
      return state.receiptStatus?{transactionHash:hash,from:DEPLOYER,to:null,status:state.receiptStatus,
        contractAddress:state.receiptStatus==='success'?predicted:null,blockNumber:20n,blockHash:h(20),...state.receiptPatch}:null;
    }
  };
  const make=(selectedStore=store,sourceCommit=COMMIT,selectedPort=port)=>new MetaMaskDemoDependencyService({dependency,
    config:{chainId:'10143',deployer:DEPLOYER,...(dependency==='GATE'?{asset:ASSET}:{})},
    artifact:dependency==='ASSET'?tokenArtifact:gateArtifact,assetArtifact:dependency==='GATE'?tokenArtifact:undefined,
    sourceCommit,sourceClean:()=>state.clean,clock:()=>state.now,store:selectedStore,port:selectedPort});
  service=make();
  const reopen=()=>{store.close();const next=new DeploymentAttemptStore(join(root,'operator.db'));stores.push(next);return next;};
  return {root,store,state,calls,port,service,predicted,codeOverrides,make,reopen};
}

async function submitted(f:ReturnType<typeof fixture>){
  const check=await f.service.preflight(),reserved=await f.service.reserve({planId:f.service.plan.planId,checkId:check.checkId});
  f.service.recordHash({planId:f.service.plan.planId,attemptId:reserved.attempt.attemptId,transactionHash:HASH});
  return reserved;
}
const noReservation=(f:ReturnType<typeof fixture>)=>assert.equal(f.store.get(f.service.plan.planId),null);

test('demo plans encode only the deployer recipient or selected asset and extend the strict wallet plan union',()=>{
  const asset=demoDependencyPlan('ASSET',{chainId:'10143',deployer:DEPLOYER},tokenArtifact,COMMIT);
  const gate=demoDependencyPlan('GATE',{chainId:'10143',deployer:DEPLOYER,asset:ASSET},gateArtifact,COMMIT);
  for(const [plan,bytecode,parameter] of [[asset,tokenArtifact.bytecode.object,DEPLOYER],[gate,gateArtifact.bytecode.object,ASSET]] as const){
    assert.equal(plan.kind,'DEMO_DEPENDENCY');assert.equal(plan.chainId,'10143');
    assert.equal(plan.data,concatHex([bytecode as Hex,encodeAbiParameters([{type:'address'}],[parameter])]));
    assert.equal(plan.initCodeHash,keccak256(plan.data as Hex));assert.equal(MetaMaskWalletPlanSchema.safeParse(plan).success,true);
    assert.equal(MetaMaskWalletPlanSchema.safeParse({...plan,to:a(9)}).success,false);
  }
  assert.equal(asset.recipient,DEPLOYER);assert.equal(asset.asset,null);assert.equal(gate.recipient,null);assert.equal(gate.asset,ASSET);
  assert.equal(demoDependencyPlan('ASSET',{chainId:'10143',deployer:DEPLOYER},tokenArtifact,'b'.repeat(40)).planId,asset.planId);
});

test('invalid chain constructor or recipient and asset injection cannot create a demo plan',()=>{
  for(const config of [{chainId:'143',deployer:DEPLOYER},{chainId:'31337',deployer:DEPLOYER},{chainId:'10143',deployer:a(0)},
    {chainId:'10143',deployer:DEPLOYER,recipient:a(9)},{chainId:'10143',deployer:DEPLOYER,asset:ASSET},
    {chainId:'10143',deployer:DEPLOYER,data:'0x6009'},{chainId:'10143',deployer:DEPLOYER,value:'0x1'}])
    assert.throws(()=>demoDependencyPlan('ASSET',config,tokenArtifact,COMMIT));
  assert.throws(()=>demoDependencyPlan('GATE',{chainId:'10143',deployer:DEPLOYER},gateArtifact,COMMIT),/PARAMETER/);
  assert.throws(()=>demoDependencyPlan('GATE',{chainId:'10143',deployer:DEPLOYER,asset:a(0)},gateArtifact,COMMIT));
  for(const abi of [[],[constructor,constructor],[{...constructor,stateMutability:'payable'}],
    [{...constructor,inputs:[]}],[{...constructor,inputs:[{type:'address'},{type:'uint256'}]}],[{...constructor,inputs:[{type:'bytes32'}]}]])
    assert.throws(()=>demoDependencyPlan('ASSET',{chainId:'10143',deployer:DEPLOYER},{...tokenArtifact,abi},COMMIT),/CONSTRUCTOR/);
});

test('self-consistent hashes cannot authorize another demo recipient or stale constructor parameter',()=>{
  const plan=demoDependencyPlan('ASSET',{chainId:'10143',deployer:DEPLOYER},tokenArtifact,COMMIT);
  const data=concatHex([tokenArtifact.bytecode.object as Hex,encodeAbiParameters([{type:'address'}],[a(9)])]),initCodeHash=keccak256(data);
  const planId=keccak256(toBytes(JSON.stringify(['10143',DEPLOYER.toLowerCase(),initCodeHash.toLowerCase()])));
  for(const changed of [{...plan,recipient:a(9),data,initCodeHash,planId},{...plan,data,initCodeHash,planId},
    {...plan,asset:ASSET},{...plan,recipient:null},{...plan,planId:h(9)},{...plan,initCodeHash:h(9)}])
    assert.equal(MetaMaskDemoDependencyPlanSchema.safeParse(changed).success,false);
  const gate=demoDependencyPlan('GATE',{chainId:'10143',deployer:DEPLOYER,asset:ASSET},gateArtifact,COMMIT);
  assert.equal(MetaMaskDemoDependencyPlanSchema.safeParse({...gate,asset:a(9)}).success,false);
  assert.equal(MetaMaskDemoDependencyPlanSchema.safeParse({...gate,recipient:DEPLOYER}).success,false);
});

test('demo preflight fixes zero-value CREATE data nonce gas and fee cap without sending or reserving',async t=>{
  for(const dependency of ['ASSET','GATE'] as const){
    const f=fixture(t,dependency),check=await f.service.preflight();
    assert.equal(check.predictedAddress,f.predicted);assert.equal(check.transaction.from,DEPLOYER);assert.equal(check.transaction.chainId,'0x279f');
    assert.equal(check.transaction.nonce,'0x2');assert.equal(check.transaction.gas,'0x78');assert.equal(check.transaction.maxFeePerGas,'0xa');
    assert.equal(check.transaction.maxPriorityFeePerGas,'0x1');assert.equal(check.transaction.value,'0x0');assert.equal(check.transaction.data,f.service.plan.data);
    assert.equal('to' in check.transaction,false);assert.equal(check.estimatedMaxCost,'1200');assert.equal(f.service.status().transactionsSentByServer,0);
    assert.equal(f.service.status().officialIntegrationVerified,false);assert.equal(f.calls.transaction,0);assert.equal(f.calls.receipt,0);noReservation(f);
    if(dependency==='GATE'){assert.equal(f.calls.token,1);assert.ok(f.calls.code.some(read=>read.address===ASSET&&read.block===23n));}
    for(const transaction of [{...check.transaction,to:a(9)},{...check.transaction,value:'0x1'},{...check.transaction,from:a(9)},
      {...check.transaction,data:'0x6009'},{...check.transaction,nonce:'0x3'}])
      assert.throws(()=>validateMetaMaskPreflight(f.service.plan,{...check,transaction}));
  }
});

test('gate preflight checks exact immutable-free token runtime and all fixed token getters',async t=>{
  const f=fixture(t,'GATE');await f.service.preflight();
  for(const patch of [{name:'IntentPass Demo Credit (TEST ONLY)'},{symbol:'IPDEMO'},{decimals:18},{totalSupply:1_000_000_000_001n}]){
    f.state.token={...tokenConfiguration,...patch};await assert.rejects(f.service.preflight(),/DEMO_ASSET_MISMATCH/);noReservation(f);
  }
  f.state.token={...tokenConfiguration};
  for(const code of ['0x','0x6001600300','0x600160020001'] as Hex[]){f.codeOverrides.set(ASSET.toLowerCase(),code);await assert.rejects(f.service.preflight(),/CODE_MISSING|RUNTIME_MISMATCH/);noReservation(f);}
  f.codeOverrides.delete(ASSET.toLowerCase());await f.service.preflight();
});

test('gate preflight requires the token artifact and rejects a future-address asset conflict',async t=>{
  const f=fixture(t,'GATE');
  const options={dependency:'GATE' as const,config:{chainId:'10143',deployer:DEPLOYER,asset:ASSET},artifact:gateArtifact,
    sourceCommit:COMMIT,sourceClean:()=>true,store:f.store,port:f.port};
  await assert.rejects(new MetaMaskDemoDependencyService(options).preflight(),/DEMO_ASSET_ARTIFACT_REQUIRED/);
  const conflict=new MetaMaskDemoDependencyService({...options,config:{...options.config,asset:f.predicted},assetArtifact:tokenArtifact});
  await assert.rejects(conflict.preflight(),/FUTURE_ADDRESS_ROLE_CONFLICT/);noReservation(f);
});

test('preflight rejects dirty source wrong chain missing snapshot non-EOA and unavailable nonce',async t=>{
  const f=fixture(t);f.state.clean=false;await assert.rejects(f.service.preflight(),/SOURCE_REVISION_CHANGED/);f.state.clean=true;
  f.state.chain=143;await assert.rejects(f.service.preflight(),/CHAIN_MISMATCH/);f.state.chain=10143;
  const block=f.port.block;f.port.block=async()=>({number:null,hash:null,timestamp:100n});await assert.rejects(f.service.preflight(),/FINALIZED_BLOCK_UNAVAILABLE/);f.port.block=block;
  f.state.accountCode='0x6000';await assert.rejects(f.service.preflight(),/CONTRACT_ACCOUNT/);f.state.accountCode='0x';
  for(const [pending,latest] of [[3n,2n],[-1n,-1n],[BigInt(Number.MAX_SAFE_INTEGER)+1n,BigInt(Number.MAX_SAFE_INTEGER)+1n]]){
    f.state.pending=pending;f.state.latest=latest;await assert.rejects(f.service.preflight(),/NONCE/);noReservation(f);
  }
});

test('preflight rejects insufficient balance and invalid gas or EIP-1559 fee combinations',async t=>{
  const f=fixture(t);f.state.balance=1199n;await assert.rejects(f.service.preflight(),/FEE_OR_BALANCE_INVALID|BALANCE_REQUIRED/);f.state.balance=100000n;
  for(const patch of [{fee:0n},{fee:-1n},{fee:10n,priority:11n},{priority:-1n},{priority:1n,estimate:0n},{estimate:-1n},{estimate:25_000_001n}]){
    Object.assign(f.state,patch);await assert.rejects(f.service.preflight(),/GAS_OR_FEES_INVALID/);noReservation(f);
  }
});

test('chain block or source drift during gas estimation cannot create a usable preflight',async t=>{
  for(const drift of ['chain','block','source'] as const){
    const f=fixture(t),estimate=f.port.estimate;
    f.port.estimate=async tx=>{const result=await estimate(tx);if(drift==='chain')f.state.chain=143;
      else if(drift==='source')f.state.clean=false;else f.port.block=async number=>({number:number??23n,hash:h(24),timestamp:100n});return result;};
    await assert.rejects(f.service.preflight(),/SNAPSHOT_CHANGED|SOURCE_REVISION_CHANGED/);noReservation(f);
  }
});

test('post-check nonce fee gas balance or source drift cannot persist any reservation',async t=>{
  for(const drift of ['nonce','fee','gas','balance','source'] as const){
    const f=fixture(t),check=await f.service.preflight();
    if(drift==='nonce'){f.state.pending=3n;f.state.latest=3n;}else if(drift==='fee')f.state.fee=11n;
    else if(drift==='gas')f.state.estimate=101n;else if(drift==='balance')f.state.balance=1199n;else f.state.clean=false;
    await assert.rejects(f.service.reserve({planId:f.service.plan.planId,checkId:check.checkId}),/PREFLIGHT_CHANGED|FEE_OR_BALANCE_INVALID|BALANCE_REQUIRED|SOURCE_REVISION_CHANGED/);
    noReservation(f);await assert.rejects(f.service.reserve({planId:f.service.plan.planId,checkId:check.checkId}),/PREFLIGHT_EXPIRED/);
  }
});

test('nonce or current balance changes inside the reserve gas estimate never journal stale send parameters',async t=>{
  for(const drift of ['nonce','balance'] as const){
    const f=fixture(t),check=await f.service.preflight(),estimate=f.port.estimate;
    f.port.estimate=async tx=>{const result=await estimate(tx);if(drift==='nonce'){f.state.pending=3n;f.state.latest=3n;}else f.state.balance=1199n;return result;};
    await assert.rejects(f.service.reserve({planId:f.service.plan.planId,checkId:check.checkId}),/NONCE|SNAPSHOT_CHANGED|PREFLIGHT_CHANGED|FEE_OR_BALANCE_INVALID|BALANCE_REQUIRED/);
    noReservation(f);
  }
});

test('expired time-reversed superseded and injected checks do not reserve deployment attempts',async t=>{
  const f=fixture(t);let check=await f.service.preflight();f.state.now+=60001;
  await assert.rejects(f.service.reserve({planId:f.service.plan.planId,checkId:check.checkId}),/EXPIRED/);noReservation(f);
  check=await f.service.preflight();f.state.now--;
  await assert.rejects(f.service.reserve({planId:f.service.plan.planId,checkId:check.checkId}),/EXPIRED/);noReservation(f);
  f.state.now++;const superseded=await f.service.preflight();check=await f.service.preflight();
  await assert.rejects(f.service.reserve({planId:f.service.plan.planId,checkId:superseded.checkId}),/EXPIRED/);
  for(const patch of [{nonce:'0x3'},{data:'0x6009'},{recipient:a(9)},{asset:a(9)}])
    await assert.rejects(f.service.reserve({planId:f.service.plan.planId,checkId:check.checkId,...patch}));
  noReservation(f);
});

test('unknown wallet send stays durably reserved after restart and source revision change',async t=>{
  for(const dependency of ['ASSET','GATE'] as const){
    const f=fixture(t,dependency),check=await f.service.preflight(),reserved=await f.service.reserve({planId:f.service.plan.planId,checkId:check.checkId});
    assert.equal(reserved.attempt.status,'RESERVED');assert.equal(reserved.attempt.transactionHash,null);
    const reopened=f.reopen(),restarted=f.make(reopened,'b'.repeat(40));
    assert.equal(restarted.plan.planId,f.service.plan.planId);assert.equal(restarted.status().ready,false);
    assert.equal(restarted.status().attempt!.attemptId,reserved.attempt.attemptId);assert.equal(restarted.status().attempt!.transactionHash,null);
    await assert.rejects(restarted.preflight(),/ALREADY_RESERVED/);assert.deepEqual(await restarted.reconcile(),{attempt:restarted.status().attempt,proof:null});
    assert.equal(f.calls.transaction,0);assert.equal(f.calls.receipt,0);
  }
});

test('changed bytecode cannot bypass the durable account nonce lock',async t=>{
  const f=fixture(t),check=await f.service.preflight();await f.service.reserve({planId:f.service.plan.planId,checkId:check.checkId});
  const changed=new MetaMaskDemoDependencyService({dependency:'ASSET',config:{chainId:'10143',deployer:DEPLOYER},
    artifact:{...tokenArtifact,bytecode:{object:'0x60096000'}},sourceCommit:COMMIT,sourceClean:()=>true,clock:()=>f.state.now,
    store:f.store,port:{...f.port,estimate:async()=>100n}});
  assert.notEqual(changed.plan.planId,f.service.plan.planId);const next=await changed.preflight();
  await assert.rejects(changed.reserve({planId:changed.plan.planId,checkId:next.checkId}),/NONCE_ALREADY_RESERVED/);
  assert.equal(f.store.get(changed.plan.planId),null);
});

test('recording an original hash is idempotent and cannot replace it or accept injected fields',async t=>{
  const f=fixture(t),r=await submitted(f),input={planId:f.service.plan.planId,attemptId:r.attempt.attemptId,transactionHash:HASH};
  assert.equal(f.service.recordHash(input).transactionHash,HASH);
  assert.throws(()=>f.service.recordHash({...input,transactionHash:h(101)}),/RECORD_CONFLICT/);
  assert.throws(()=>f.service.recordHash({...input,transactionHash:'0x6000'}));
  assert.throws(()=>f.service.recordHash({...input,gas:'0x100'}));
  assert.equal(f.store.get(f.service.plan.planId)!.transactionHash,HASH);
});

test('original nonce gas and EIP-1559 caps are enforced even for matching creation bytes',async t=>{
  for(const patch of [{originalNonce:3},{originalNonce:-1},{originalGas:121n},{originalGas:0n},{originalGas:-1n},
    {originalFee:11n},{originalFee:0n},{originalFee:-1n},{originalFee:null},{originalPriority:2n},{originalPriority:-1n},
    {originalPriority:null},{originalFee:0n,originalPriority:1n}]){
    const f=fixture(t);await submitted(f);f.state.receiptStatus='success';Object.assign(f.state,patch);
    await assert.rejects(f.service.reconcile(),/RESERVED_TRANSACTION_MISMATCH/);assert.equal(f.store.get(f.service.plan.planId)!.status,'SUBMITTED');
  }
});

test('successful original asset and gate proofs bind finalized receipt runtime and fixed configuration',async t=>{
  for(const dependency of ['ASSET','GATE'] as const){
    const f=fixture(t,dependency);await submitted(f);f.state.receiptStatus='success';
    const result=await f.service.reconcile();assert.equal(result.attempt!.status,'CONFIRMED');assert.equal(result.proof!.status,'CONFIRMED');
    assert.equal(result.proof!.scope,'FINALIZED_ORIGINAL_DEMO_DEPENDENCY_CREATION_PROOF');assert.equal(result.proof!.assetMode,'demo-erc20');
    assert.equal(result.proof!.dependency,dependency);assert.equal(result.proof!.contractAddress,f.predicted);assert.equal(result.proof!.identityVerification,false);
    assert.equal(result.proof!.transactionsSent,0);assert.deepEqual(result.proof!.receiptBlock,{number:'20',hash:h(20)});
    assert.equal(result.proof!.runtimeCodeHash,keccak256(dependency==='ASSET'?tokenRuntime:gateRuntime(ASSET)));
    assert.deepEqual(result.proof!.configuration,dependency==='ASSET'?{...tokenConfiguration,totalSupply:String(tokenConfiguration.totalSupply)}:{asset:ASSET,identityVerification:false});
    assert.equal((await f.service.reconcile()).attempt!.status,'CONFIRMED');await assert.rejects(f.service.preflight(),/ALREADY_RESERVED/);
  }
});

test('reconcile supports prototype-based read ports without losing methods or method receivers',async t=>{
  const f=fixture(t);await submitted(f);f.state.receiptStatus='success';
  class LocalReadPort implements DemoDependencyReadPort{
    constructor(private delegate:DemoDependencyReadPort){}
    chainId(){return this.delegate.chainId();}
    block(number?:bigint){return this.delegate.block(number);}
    code(address:Address,block:bigint){return this.delegate.code(address,block);}
    nonce(address:Address,tag:'pending'|'latest'){return this.delegate.nonce(address,tag);}
    balance(address:Address){return this.delegate.balance(address);}
    fees(){return this.delegate.fees();}
    estimate(tx:Parameters<DemoDependencyReadPort['estimate']>[0]){return this.delegate.estimate(tx);}
    token(address:Address,block:bigint){return this.delegate.token(address,block);}
    gate(address:Address,block:bigint){return this.delegate.gate(address,block);}
    transaction(hash:Hex){return this.delegate.transaction(hash);}
    receipt(hash:Hex){return this.delegate.receipt(hash);}
  }
  const restarted=f.make(f.store,COMMIT,new LocalReadPort(f.port));
  assert.equal((await restarted.reconcile()).attempt!.status,'CONFIRMED');
});

test('replacement transaction fields cannot confirm a dependency deployment',async t=>{
  for(const patch of [{hash:h(101)},{from:a(9)},{to:a(9)},{input:'0x6009' as Hex},{value:1n},{chainId:143},
    {chainId:undefined},{nonce:2.5},{blockHash:h(19)},{blockNumber:19n}]){
    const f=fixture(t);await submitted(f);f.state.receiptStatus='success';f.state.txPatch=patch;
    if(patch.nonce===2.5)await assert.rejects(f.service.reconcile());
    else await assert.rejects(f.service.reconcile(),/TRANSACTION_MISMATCH|RECEIPT_MISMATCH|RESERVED_TRANSACTION_MISMATCH/);
    assert.equal(f.store.get(f.service.plan.planId)!.status,'SUBMITTED');
  }
});

test('receipt hash sender target address and canonical block must match the exact original creation',async t=>{
  for(const patch of [{transactionHash:h(101)},{from:a(9)},{to:a(9)},{contractAddress:a(9)},{contractAddress:null},
    {blockHash:h(19)},{blockNumber:19n}]){
    const f=fixture(t);await submitted(f);f.state.receiptStatus='success';f.state.receiptPatch=patch;
    await assert.rejects(f.service.reconcile(),/RECEIPT_MISMATCH|ADDRESS_MISMATCH/);
    assert.equal(f.store.get(f.service.plan.planId)!.status,'SUBMITTED');
  }
  const f=fixture(t);await submitted(f);f.state.receiptStatus='success';
  f.port.block=async number=>({number:number??23n,hash:h(number===20n?21:Number(number??23n)),timestamp:100n});
  await assert.rejects(f.service.reconcile(),/RECEIPT_NOT_CANONICAL/);assert.equal(f.store.get(f.service.plan.planId)!.status,'SUBMITTED');
});

test('missing non-finalized orphaned and reverted receipts preserve honest pending or reverted states',async t=>{
  const f=fixture(t);await submitted(f);
  assert.equal((await f.service.reconcile()).proof!.status,'PENDING');assert.equal(f.store.get(f.service.plan.planId)!.status,'SUBMITTED');
  f.state.txFound=false;assert.equal((await f.service.reconcile()).proof!.status,'PENDING');
  f.state.receiptStatus='success';await assert.rejects(f.service.reconcile(),/TRANSACTION_UNAVAILABLE/);
  f.state.txFound=true;f.state.txPatch={blockNumber:24n,blockHash:h(24)};f.state.receiptPatch={blockNumber:24n,blockHash:h(24)};
  assert.equal((await f.service.reconcile()).proof!.status,'PENDING');assert.equal(f.store.get(f.service.plan.planId)!.status,'SUBMITTED');
  f.state.txPatch={};f.state.receiptPatch={};f.state.receiptStatus='reverted';
  assert.equal((await f.service.reconcile()).attempt!.status,'REVERTED');await assert.rejects(f.service.preflight(),/ALREADY_RESERVED/);
});

test('missing altered asset runtime or altered token configuration cannot become confirmed evidence',async t=>{
  const f=fixture(t);await submitted(f);f.state.receiptStatus='success';
  for(const code of ['0x','0x6001600300','0x600160020001'] as Hex[]){
    f.codeOverrides.set(f.predicted.toLowerCase(),code);await assert.rejects(f.service.reconcile(),/CODE_MISSING|RUNTIME_MISMATCH/);
    assert.equal(f.store.get(f.service.plan.planId)!.status,'SUBMITTED');
  }
  f.codeOverrides.delete(f.predicted.toLowerCase());
  for(const patch of [{name:'Other Asset'},{symbol:'OTHER'},{decimals:18},{totalSupply:0n}]){
    f.state.token={...tokenConfiguration,...patch};await assert.rejects(f.service.reconcile(),/DEMO_ASSET_MISMATCH/);
    assert.equal(f.store.get(f.service.plan.planId)!.status,'SUBMITTED');
  }
});

test('gate finalized proof requires exact asset immutable runtime and getter',async t=>{
  const f=fixture(t,'GATE');await submitted(f);f.state.receiptStatus='success';
  f.state.gateAsset=a(9);await assert.rejects(f.service.reconcile(),/DEMO_GATE_MISMATCH/);f.state.gateAsset=ASSET;
  for(const code of [gateRuntime(a(9)),gateRuntime(ASSET).slice(0,-2)+'ff'] as Hex[]){
    f.codeOverrides.set(f.predicted.toLowerCase(),code);await assert.rejects(f.service.reconcile(),/RUNTIME_MISMATCH/);
    assert.equal(f.store.get(f.service.plan.planId)!.status,'SUBMITTED');
  }
});

test('finalized chain or block drift and terminal contradictions never rewrite the durable outcome',async t=>{
  for(const terminal of ['success','reverted'] as const){
    const f=fixture(t);await submitted(f);f.state.receiptStatus=terminal;
    const confirmed=await f.service.reconcile(),status=confirmed.attempt!.status;
    f.state.receiptStatus=null;f.state.txFound=false;await assert.rejects(f.service.reconcile(),/TERMINAL_OBSERVATION_CONFLICT/);
    assert.equal(f.store.get(f.service.plan.planId)!.status,status);
    f.state.txFound=true;f.state.receiptStatus=terminal==='success'?'reverted':'success';
    await assert.rejects(f.service.reconcile(),/TERMINAL_OBSERVATION_CONFLICT/);assert.equal(f.store.get(f.service.plan.planId)!.status,status);
  }
  const f=fixture(t);await submitted(f);f.state.receiptStatus='success';
  f.port.block=async number=>({number:number??23n,hash:h(number===23n?24:Number(number??23n)),timestamp:100n});
  await assert.rejects(f.service.reconcile(),/SNAPSHOT_CHANGED/);assert.equal(f.store.get(f.service.plan.planId)!.status,'SUBMITTED');
  const chain=fixture(t);await submitted(chain);chain.state.receiptStatus='success';const transaction=chain.port.transaction;
  chain.port.transaction=async hash=>{const tx=await transaction(hash);chain.state.chain=143;return tx;};
  await assert.rejects(chain.service.reconcile(),/SNAPSHOT_CHANGED/);assert.equal(chain.store.get(chain.service.plan.planId)!.status,'SUBMITTED');
});

test('standalone dependency inspection cannot treat linked or fabricated immutables as a demo token runtime',async t=>{
  const f=fixture(t),plan=f.service.plan;f.state.receiptStatus='success';
  await assert.rejects(inspectDemoDependency(plan,{...tokenArtifact,deployedBytecode:{...tokenArtifact.deployedBytecode,linkReferences:{lib:{}}}},f.predicted,23n,f.port),/LINKED_RUNTIME_UNSUPPORTED/);
  await assert.rejects(inspectDemoDependency(plan,{...tokenArtifact,deployedBytecode:{...tokenArtifact.deployedBytecode,immutableReferences:{bad:[{start:0,length:32}]}}},f.predicted,23n,f.port),/RUNTIME_MISMATCH|IMMUTABLE_LAYOUT_INVALID/);
  const p={...f.port,chainId:async()=>143};await assert.rejects(verifyDemoDependencyCreation(plan,tokenArtifact,HASH,p),/CHAIN_MISMATCH/);
});
