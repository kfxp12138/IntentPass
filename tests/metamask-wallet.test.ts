import test from 'node:test';
import assert from 'node:assert/strict';
import {getContractAddress,keccak256,type Address} from 'viem';
import {metamaskPlan,metamaskGatePlan,MetaMaskPlanSchema,MetaMaskWalletPlanSchema,type MetaMaskAttempt,type MetaMaskPreflight,type MetaMaskWalletPlan,type MetaMaskGatePlan} from '../scripts/metamask-types.js';
import {MetaMaskDeploymentFlow,type MetaMaskDeploymentBackend,type MetaMaskProvider} from '../scripts/metamask-wallet.js';
import {MetaMaskPreflightRejected} from '../scripts/metamask-preflight-rejection.js';

// Explicit in-memory doubles. These tests never contact a wallet, chain, or API.
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address;
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
const at='2026-10-02T00:00:00.000Z',later='2026-10-02T00:00:01.000Z';
const defaults=Symbol('default provider response');
type Request={method:string;params?:unknown[]};
class LocalProvider implements MetaMaskProvider {
  isMetaMask=true;
  accounts:string[]=[a(1)];chainId='0x279f';pending:unknown='0x0';latest:unknown='0x0';balance='0x100000';
  calls:Request[]=[];
  listeners=new Map<string,Set<(...args:unknown[])=>void>>();
  removed:string[]=[];
  intercept?:(request:Request)=>unknown|Promise<unknown>;
  on(event:string,listener:(...args:unknown[])=>void){
    const group=this.listeners.get(event)??new Set();group.add(listener);this.listeners.set(event,group);
  }
  removeListener(event:string,listener:(...args:unknown[])=>void){this.removed.push(event);this.listeners.get(event)?.delete(listener);}
  emit(event:string,...args:unknown[]){for(const listener of this.listeners.get(event)??[])listener(...args);}
  async request(input:Request):Promise<unknown>{
    this.calls.push(structuredClone(input));
    const intercepted=this.intercept?await this.intercept(input):defaults;
    if(intercepted!==defaults)return intercepted;
    switch(input.method){
      case 'eth_requestAccounts':case 'eth_accounts':return [...this.accounts];
      case 'eth_chainId':return this.chainId;
      case 'eth_getBalance':return this.balance;
      case 'eth_getTransactionCount':return input.params?.[1]==='pending'?this.pending:this.latest;
      case 'eth_sendTransaction':return h(20);
      default:throw new Error('Unexpected local provider method');
    }
  }
}
function deferred<T>(){
  let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};
}
function fixture(){
  const plan=metamaskPlan({chainId:'10143',deployer:a(1),asset:a(2),gate:a(3),reviewer:a(4),committee:[a(5),a(6),a(7)]},
    {abi:[{type:'constructor',stateMutability:'nonpayable',inputs:[{type:'address'},{type:'address'},{type:'address'},{type:'address[3]'}]}],bytecode:{object:'0x6000'}},'a'.repeat(40));
  return deploymentFixture(plan);
}
function gateFixture(nonce=3n){
  const gateArtifact={abi:[{type:'constructor',stateMutability:'nonpayable',inputs:[{type:'address'},{type:'address'},{type:'address'},{type:'address'}]}],bytecode:{object:'0x6001'}};
  const escrowArtifact={abi:[{type:'constructor',stateMutability:'nonpayable',inputs:[{type:'address'},{type:'address'},{type:'address'},{type:'address[3]'}]}],bytecode:{object:'0x6000'}};
  return deploymentFixture(metamaskGatePlan({chainId:'10143',deployer:a(1),asset:a(2),validator:a(8),policy:a(9),reviewer:a(4),committee:[a(5),a(6),a(7)]},gateArtifact,escrowArtifact,nonce,'a'.repeat(40)));
}
function deploymentFixture<P extends MetaMaskWalletPlan>(plan:P){
  const nonce='kind' in plan&&plan.kind==='CLEANVERSE_GATE'?plan.gateNonce:'0x0';
  const check:MetaMaskPreflight={planId:plan.planId,checkId:'11111111-1111-4111-8111-111111111111',checkedAt:at,
    predictedAddress:getContractAddress({from:a(1),nonce:BigInt(nonce)}),balance:'1048576',estimatedMaxCost:'200',
    transaction:{from:a(1),chainId:'0x279f',data:plan.data,value:'0x0',nonce,gas:'0x64',maxFeePerGas:'0x2',maxPriorityFeePerGas:'0x1'}};
  const attempt:MetaMaskAttempt={attemptId:'22222222-2222-4222-8222-222222222222',planId:plan.planId,sourceCommit:plan.sourceCommit,chainId:'10143',
    deployer:plan.deployer,initCodeHash:plan.initCodeHash,nonce,gas:'0x64',maxFeePerGas:'0x2',maxPriorityFeePerGas:'0x1',
    status:'RESERVED',transactionHash:null,contractAddress:null,createdAt:at,updatedAt:at};
  const provider=new LocalProvider(),trace:string[]=[],saved:Array<{attempt:MetaMaskAttempt;hash:string}>=[];
  provider.pending=nonce;provider.latest=nonce;
  const reserveCalls:Array<{planId:string;checkId:string}>=[],recordCalls:Array<{planId:string;attemptId:string;transactionHash:string}>=[];
  const response={attempt:structuredClone(attempt),preflight:{...structuredClone(check),checkedAt:later,balance:'1048577'}};
  const hooks:{reserve?:()=>Promise<typeof response>|typeof response;record?:(input:typeof recordCalls[number])=>Promise<MetaMaskAttempt>|MetaMaskAttempt}={};
  const backend:MetaMaskDeploymentBackend={
    reserve:async input=>{trace.push('reserve');reserveCalls.push(input);return hooks.reserve?hooks.reserve():structuredClone(response);},
    recordHash:async input=>{trace.push('record');recordCalls.push(input);return hooks.record?hooks.record(input):{...structuredClone(attempt),status:'SUBMITTED',transactionHash:input.transactionHash,updatedAt:later};}
  };
  const saveHash=(record:MetaMaskAttempt,hash:string)=>{trace.push('save');saved.push({attempt:structuredClone(record),hash});};
  const flow=new MetaMaskDeploymentFlow(provider,backend,{saveHash});
  return {plan,check,attempt,provider,backend,response,hooks,trace,saved,saveHash,reserveCalls,recordCalls,flow};
}
async function rejectsCode(promise:Promise<unknown>,code:string){
  await assert.rejects(promise,error=>error instanceof Error&&error.message===code);
}
const sends=(provider:LocalProvider)=>provider.calls.filter(call=>call.method==='eth_sendTransaction');

test('connect reads selected MetaMask account, chain and balance without switching or sending',async()=>{
  const f=fixture();
  assert.deepEqual(await f.flow.connect(),{account:a(1),chainId:'0x279f',balance:'1048576'});
  assert.deepEqual(f.provider.calls,[{method:'eth_requestAccounts'},{method:'eth_chainId'},{method:'eth_getBalance',params:[a(1),'latest']}]);
  assert.equal(f.reserveCalls.length,0);assert.equal(f.recordCalls.length,0);
  const g=fixture();g.provider.chainId='0x8f';assert.equal((await g.flow.connect()).chainId,'0x8f');
});

test('connect tolerates its initial permission event and establishes a stable context',async()=>{
  const f=fixture();f.provider.emit('disconnect');
  f.provider.intercept=request=>{if(request.method==='eth_requestAccounts')f.provider.emit('accountsChanged',[a(1)]);return defaults;};
  await f.flow.connect();await f.flow.send(f.plan,f.check,true);assert.equal(sends(f.provider).length,1);
  const g=fixture();g.provider.intercept=request=>{if(request.method==='eth_getBalance')g.provider.emit('chainChanged','0x8f');return defaults;};
  await rejectsCode(g.flow.connect(),'METAMASK_CONTEXT_CHANGED');
});

test('send checks wallet twice and sends only the exact fixed deployment transaction once',async()=>{
  const f=fixture(),original=structuredClone(f.check.transaction);
  assert.deepEqual(await f.flow.send(f.plan,f.check,true),{attemptId:f.attempt.attemptId,transactionHash:h(20)});
  assert.deepEqual(f.reserveCalls,[{planId:f.plan.planId,checkId:f.check.checkId}]);
  assert.deepEqual(f.provider.calls.map(call=>call.method),[
    'eth_accounts','eth_chainId','eth_getTransactionCount','eth_getTransactionCount',
    'eth_accounts','eth_chainId','eth_getTransactionCount','eth_getTransactionCount','eth_sendTransaction']);
  for(const call of f.provider.calls.filter(call=>call.method==='eth_getTransactionCount'))assert.equal(call.params?.[0],f.plan.deployer);
  assert.deepEqual(sends(f.provider),[{method:'eth_sendTransaction',params:[original]}]);
  assert.equal('to' in original,false);assert.deepEqual(f.trace,['reserve','save','record']);
  assert.deepEqual(f.saved,[{attempt:f.attempt,hash:h(20)}]);
  assert.deepEqual(f.recordCalls,[{planId:f.plan.planId,attemptId:f.attempt.attemptId,transactionHash:h(20)}]);
  await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_ALREADY_RESERVED');assert.equal(sends(f.provider).length,1);
});

test('numeric zero pending nonce matches hex latest in both wallet checks and sends canonical nonce once',async()=>{
  const f=fixture(),original=structuredClone(f.check.transaction);f.provider.pending=0;
  assert.deepEqual(await f.flow.send(f.plan,f.check,true),{attemptId:f.attempt.attemptId,transactionHash:h(20)});
  const nonceReads=f.provider.calls.filter(call=>call.method==='eth_getTransactionCount');
  assert.deepEqual(nonceReads.map(call=>call.params?.[1]),['pending','latest','pending','latest']);
  assert.deepEqual(sends(f.provider),[{method:'eth_sendTransaction',params:[original]}]);
  assert.equal(original.nonce,'0x0');assert.equal(f.reserveCalls.length,1);assert.equal(f.recordCalls.length,1);
  await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_ALREADY_RESERVED');
  assert.equal(sends(f.provider).length,1);assert.equal(f.reserveCalls.length,1);
});

test('nonzero numeric nonce is compared with the approved nonce instead of changing the transaction',async()=>{
  const f=fixture();f.provider.pending=1;f.provider.latest=1;
  await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_NONCE_MISMATCH');
  assert.equal(f.reserveCalls.length,0);assert.equal(sends(f.provider).length,0);assert.equal(f.check.transaction.nonce,'0x0');
  const g=gateFixture(3n);g.provider.pending=3;g.provider.latest=3;
  await g.flow.send(g.plan,g.check,true);
  assert.equal(sends(g.provider).length,1);
  assert.equal((sends(g.provider)[0].params?.[0] as MetaMaskPreflight['transaction']).nonce,'0x3');
});

test('invalid numeric wallet nonces are rejected before reservation and keep a durable reservation locked',async()=>{
  const invalid=[-1,-0,NaN,Infinity,-Infinity,0.5,Number.MAX_SAFE_INTEGER+1];
  for(const value of invalid){
    for(const field of ['pending','latest'] as const){
      const f=fixture();f.provider[field]=value;
      await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_WALLET_RESPONSE_INVALID');
      assert.equal(f.reserveCalls.length,0);assert.equal(sends(f.provider).length,0);
      const g=fixture();g.hooks.reserve=()=>{g.provider[field]=value;return structuredClone(g.response);};
      await rejectsCode(g.flow.send(g.plan,g.check,true),'METAMASK_WALLET_RESPONSE_INVALID');
      assert.equal(g.reserveCalls.length,1);assert.equal(sends(g.provider).length,0);
      await rejectsCode(g.flow.send(g.plan,g.check,true),'METAMASK_ALREADY_RESERVED');
      assert.equal(g.reserveCalls.length,1);assert.equal(sends(g.provider).length,0);
    }
  }
});

test('numeric chain and balance responses remain rejected rather than using nonce compatibility',async()=>{
  for(const method of ['eth_chainId','eth_getBalance']){
    const f=fixture();f.provider.intercept=request=>request.method===method?0:defaults;
    await rejectsCode(f.flow.connect(),'METAMASK_WALLET_RESPONSE_INVALID');
    assert.equal(f.reserveCalls.length,0);assert.equal(sends(f.provider).length,0);
  }
});

test('read-only wallet precheck accepts numeric zero and rejects nonce drift without reserving or sending',async()=>{
  const f=fixture();f.provider.pending=0;
  await f.flow.checkWallet(f.plan,f.check);
  assert.deepEqual(f.provider.calls.map(call=>call.method),['eth_accounts','eth_chainId','eth_getTransactionCount','eth_getTransactionCount']);
  assert.equal(f.reserveCalls.length,0);assert.equal(f.recordCalls.length,0);assert.equal(f.flow.submitted,null);
  const g=fixture();g.provider.pending=1;g.provider.latest=1;
  await rejectsCode(g.flow.checkWallet(g.plan,g.check),'METAMASK_NONCE_MISMATCH');
  assert.equal(g.reserveCalls.length,0);assert.equal(sends(g.provider).length,0);
  const invalid=fixture();invalid.check.transaction.value='0x1' as '0x0';
  await rejectsCode(invalid.flow.checkWallet(invalid.plan,invalid.check),'METAMASK_PLAN_OR_PREFLIGHT_INVALID');
  assert.equal(invalid.provider.calls.length,0);assert.equal(invalid.reserveCalls.length,0);
});

test('read-only wallet precheck never unlocks an unknown durable reservation or replaces an original submission',async()=>{
  const f=fixture();f.hooks.reserve=()=>{throw new Error('local lost reservation response');};
  await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_RESERVATION_OUTCOME_UNKNOWN');
  f.provider.pending=0;await f.flow.checkWallet(f.plan,f.check);
  assert.equal(f.reserveCalls.length,1);assert.equal(sends(f.provider).length,0);assert.equal(f.flow.submitted,null);
  await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_ALREADY_RESERVED');assert.equal(f.reserveCalls.length,1);
  const g=fixture();await g.flow.send(g.plan,g.check,true);const original=g.flow.submitted;
  await g.flow.checkWallet(g.plan,g.check);assert.deepEqual(g.flow.submitted,original);
  assert.equal(g.reserveCalls.length,1);assert.equal(g.recordCalls.length,1);assert.equal(sends(g.provider).length,1);
  await rejectsCode(g.flow.send(g.plan,g.check,true),'METAMASK_ALREADY_RESERVED');
});

test('read-only wallet precheck is mutually exclusive and freezes plan and preflight before reading',async()=>{
  const f=fixture(),pending=deferred<unknown>();let first=true;
  f.provider.intercept=request=>{if(request.method==='eth_accounts'&&first){first=false;return pending.promise;}return defaults;};
  const checking=f.flow.checkWallet(f.plan,f.check);
  await rejectsCode(f.flow.checkWallet(f.plan,f.check),'METAMASK_SEND_PENDING');
  await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_SEND_PENDING');
  const originalDeployer=f.plan.deployer;f.plan.deployer=a(9);f.check.transaction.nonce='0x1';
  pending.resolve([originalDeployer]);await checking;
  for(const call of f.provider.calls.filter(call=>call.method==='eth_getTransactionCount'))assert.equal(call.params?.[0],originalDeployer);
  assert.equal(f.reserveCalls.length,0);assert.equal(sends(f.provider).length,0);
  const g=fixture();g.provider.intercept=request=>{if(request.method==='eth_getTransactionCount')g.provider.emit('chainChanged');return defaults;};
  await rejectsCode(g.flow.checkWallet(g.plan,g.check),'METAMASK_CONTEXT_CHANGED');
  assert.equal(g.reserveCalls.length,0);assert.equal(sends(g.provider).length,0);
});

test('confirmation and valid bound preflight are mandatory before reading or reserving',async()=>{
  const f=fixture();await rejectsCode(f.flow.send(f.plan,f.check,false),'METAMASK_CONFIRMATION_REQUIRED');
  assert.equal(f.provider.calls.length,0);assert.equal(f.reserveCalls.length,0);
  const mutations:Array<(check:MetaMaskPreflight)=>void>=[
    check=>{check.planId=h(99);},check=>{check.transaction.data='0x6001';},check=>{check.transaction.from=a(9);},
    check=>{check.transaction.value='0x1' as '0x0';},check=>{check.transaction.gas='0x0';},
    check=>{check.transaction.maxFeePerGas='0x0';},check=>{check.transaction.maxPriorityFeePerGas='0x3';},
    check=>{check.estimatedMaxCost='201';},check=>{check.balance='1';},check=>{check.predictedAddress=a(9);},
    check=>{Object.assign(check.transaction,{to:a(9)});}
  ];
  for(const mutate of mutations){const g=fixture();mutate(g.check);await rejectsCode(g.flow.send(g.plan,g.check,true),'METAMASK_PLAN_OR_PREFLIGHT_INVALID');assert.equal(g.provider.calls.length,0);assert.equal(g.reserveCalls.length,0);}
});

test('missing or failed event subscriptions deny send while read-only connect remains available',async()=>{
  for(const missing of ['on','removeListener'] as const){
    const f=fixture(),provider:MetaMaskProvider={isMetaMask:true,request:f.provider.request.bind(f.provider)};
    if(missing==='on')provider.removeListener=f.provider.removeListener.bind(f.provider);else provider.on=f.provider.on.bind(f.provider);
    const flow=new MetaMaskDeploymentFlow(provider,f.backend,{saveHash:f.saveHash});await flow.connect();
    await rejectsCode(flow.send(f.plan,f.check,true),'METAMASK_EVENTS_REQUIRED');assert.equal(f.reserveCalls.length,0);
  }
  const f=fixture();f.flow.dispose();f.provider.on=function(event,listener){if(event==='chainChanged')throw new Error('secret subscription error');LocalProvider.prototype.on.call(this,event,listener);};
  const flow=new MetaMaskDeploymentFlow(f.provider,f.backend);await flow.connect();
  await rejectsCode(flow.send(f.plan,f.check,true),'METAMASK_EVENTS_REQUIRED');
  assert.equal([...f.provider.listeners.values()].reduce((sum,set)=>sum+set.size,0),0);
});

test('first selected account, testnet and both canonical nonces must match before reservation',async()=>{
  const cases:Array<{setup:(provider:LocalProvider)=>void;code:string}>=[
    {setup:p=>{p.isMetaMask=false;},code:'METAMASK_PROVIDER_REQUIRED'},
    {setup:p=>{p.accounts=[a(9),a(1)];},code:'METAMASK_ACCOUNT_MISMATCH'},
    {setup:p=>{p.accounts=[];},code:'METAMASK_ACCOUNT_UNAVAILABLE'},
    {setup:p=>{p.chainId='0x8f';},code:'METAMASK_TESTNET_REQUIRED'},
    {setup:p=>{p.pending='0x1';},code:'METAMASK_NONCE_MISMATCH'},
    {setup:p=>{p.pending='0x1';p.latest='0x1';},code:'METAMASK_NONCE_MISMATCH'},
    {setup:p=>{p.pending='0x00';},code:'METAMASK_WALLET_RESPONSE_INVALID'}
  ];
  for(const entry of cases){const f=fixture();entry.setup(f.provider);await rejectsCode(f.flow.send(f.plan,f.check,true),entry.code);assert.equal(f.reserveCalls.length,0);assert.equal(sends(f.provider).length,0);}
});

test('provider read errors are reduced to a fixed code without exposing raw credentials or text',async()=>{
  const f=fixture();f.provider.intercept=()=>{throw Object.assign(new Error('apikey_example_private provider failure'),{code:4001});};
  await rejectsCode(f.flow.connect(),'METAMASK_WALLET_UNAVAILABLE');
  await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_WALLET_UNAVAILABLE');assert.equal(f.reserveCalls.length,0);
});

test('events before reservation invalidate send until explicit stable reconnect',async()=>{
  for(const event of ['accountsChanged','chainChanged','disconnect']){
    const f=fixture();f.provider.emit(event);await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_CONTEXT_CHANGED');
    assert.equal(f.reserveCalls.length,0);await f.flow.connect();await f.flow.send(f.plan,f.check,true);assert.equal(sends(f.provider).length,1);
  }
});

test('reservation responses cannot replace plan, check, address or any transaction field',async()=>{
  const mutations:Array<(check:MetaMaskPreflight)=>void>=[
    c=>{c.planId=h(99);},c=>{c.checkId='33333333-3333-4333-8333-333333333333';},c=>{c.predictedAddress=a(9);},
    c=>{c.transaction.nonce='0x1';c.predictedAddress=getContractAddress({from:a(1),nonce:1n});},
    c=>{c.transaction.gas='0x65';c.estimatedMaxCost='202';},c=>{c.transaction.maxFeePerGas='0x3';c.estimatedMaxCost='300';},
    c=>{c.transaction.maxPriorityFeePerGas='0x0';},c=>{c.transaction.data='0x6001';},c=>{c.transaction.from=a(9);}
  ];
  for(const mutate of mutations){const f=fixture();mutate(f.response.preflight);await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_RESERVATION_MISMATCH');assert.equal(sends(f.provider).length,0);await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_ALREADY_RESERVED');}
});

test('reservation record binds source, deployer, init code, nonce, fees, status and empty hash',async()=>{
  const mutations:Array<(record:MetaMaskAttempt)=>void>=[
    r=>{r.planId=h(99);},r=>{r.sourceCommit='b'.repeat(40);},r=>{r.deployer=a(9);},r=>{r.initCodeHash=h(99);},
    r=>{r.nonce='0x1';},r=>{r.gas='0x65';},r=>{r.maxFeePerGas='0x3';},r=>{r.maxPriorityFeePerGas='0x0';},
    r=>{r.status='SUBMITTED';r.transactionHash=h(20);},r=>{r.transactionHash=h(20);},r=>{r.contractAddress=a(9);},
    r=>{r.updatedAt='2026-10-01T23:59:59.000Z';},r=>{Object.assign(r,{chainId:'143'});},r=>{Object.assign(r,{extra:'forbidden'});}
  ];
  for(const mutate of mutations){const f=fixture();mutate(f.response.attempt);await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_RESERVATION_MISMATCH');assert.equal(sends(f.provider).length,0);assert.equal(f.recordCalls.length,0);}
});

test('a lost reservation response consumes the flow without sending or retrying',async()=>{
  const f=fixture();f.hooks.reserve=()=>{throw new Error('private backend detail');};
  await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_RESERVATION_OUTCOME_UNKNOWN');
  await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_ALREADY_RESERVED');assert.equal(f.reserveCalls.length,1);assert.equal(sends(f.provider).length,0);
});

test('an explicit no-reservation preflight rejection allows only a newly confirmed check to send once',async()=>{
  for(const code of ['DEPLOYMENT_PREFLIGHT_CHANGED','DEPLOYMENT_PREFLIGHT_EXPIRED'] as const){
    const f=fixture();f.hooks.reserve=()=>{throw new MetaMaskPreflightRejected(code);};
    await assert.rejects(f.flow.send(f.plan,f.check,true),error=>error instanceof MetaMaskPreflightRejected&&error.message===code);
    assert.equal(f.reserveCalls.length,1);assert.equal(sends(f.provider).length,0);assert.equal(f.recordCalls.length,0);
    const next=structuredClone(f.check);next.checkId='33333333-3333-4333-8333-333333333333';next.checkedAt=later;next.transaction.maxFeePerGas='0x3';next.estimatedMaxCost='300';
    f.attempt.maxFeePerGas='0x3';f.response.attempt=structuredClone(f.attempt);f.response.preflight=structuredClone(next);f.hooks.reserve=undefined;
    await rejectsCode(f.flow.send(f.plan,next,false),'METAMASK_CONFIRMATION_REQUIRED');assert.equal(f.reserveCalls.length,1);assert.equal(sends(f.provider).length,0);
    await f.flow.send(f.plan,next,true);assert.deepEqual(sends(f.provider),[{method:'eth_sendTransaction',params:[next.transaction]}]);assert.equal(f.reserveCalls.length,2);assert.equal(f.reserveCalls[1].checkId,next.checkId);assert.equal(f.recordCalls.length,1);
    await rejectsCode(f.flow.send(f.plan,next,true),'METAMASK_ALREADY_RESERVED');assert.equal(sends(f.provider).length,1);
  }
});

test('plain same-code errors and metadata-shaped lookalikes remain unknown and cannot release the reserved flow',async()=>{
  for(const code of ['DEPLOYMENT_PREFLIGHT_CHANGED','DEPLOYMENT_PREFLIGHT_EXPIRED'] as const){
    for(const error of [new Error(code),Object.assign(new Error(code),{name:'MetaMaskPreflightRejected',reservationOutcome:'NOT_CREATED_BY_THIS_REQUEST',signaturesRequested:0,transactionsSent:0})]){
      const f=fixture();f.hooks.reserve=()=>{throw error;};await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_RESERVATION_OUTCOME_UNKNOWN');
      f.hooks.reserve=undefined;await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_ALREADY_RESERVED');assert.equal(f.reserveCalls.length,1);assert.equal(sends(f.provider).length,0);assert.equal(f.recordCalls.length,0);
    }
  }
});

test('wallet is rechecked after reserve and failures consume the reserved attempt',async()=>{
  const cases:Array<{change:()=>void;code:string;fixture:ReturnType<typeof fixture>}>=[];
  for(const kind of ['account','chain','pending','latest','event','dispose']){
    const f=fixture();const change=()=>{
      if(kind==='account')f.provider.accounts=[a(9)];else if(kind==='chain')f.provider.chainId='0x8f';
      else if(kind==='pending')f.provider.pending='0x1';else if(kind==='latest')f.provider.latest='0x1';
      else if(kind==='event')f.provider.emit('disconnect');else f.flow.dispose();
    };
    cases.push({fixture:f,change,code:kind==='account'?'METAMASK_ACCOUNT_MISMATCH':kind==='chain'?'METAMASK_TESTNET_REQUIRED':kind==='event'?'METAMASK_CONTEXT_CHANGED':kind==='dispose'?'METAMASK_FLOW_DISPOSED':'METAMASK_NONCE_MISMATCH'});
  }
  for(const entry of cases){const f=entry.fixture;f.hooks.reserve=()=>{entry.change();return structuredClone(f.response);};await rejectsCode(f.flow.send(f.plan,f.check,true),entry.code);assert.equal(sends(f.provider).length,0);assert.equal(f.reserveCalls.length,1);}
});

test('context events during the last wallet read prevent the send request',async()=>{
  for(const event of ['accountsChanged','chainChanged','disconnect']){
    const f=fixture();let reads=0;
    f.provider.intercept=request=>{if(request.method==='eth_getTransactionCount'&&++reads===4)f.provider.emit(event);return defaults;};
    await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_CONTEXT_CHANGED');assert.equal(f.reserveCalls.length,1);assert.equal(sends(f.provider).length,0);
  }
});

test('input mutation across awaits cannot replace captured plan or transaction',async()=>{
  const f=fixture(),original=structuredClone(f.check.transaction);
  f.hooks.reserve=()=>{f.plan.data='0x6001';f.plan.sourceCommit='b'.repeat(40);f.check.transaction.gas='0x999';f.check.transaction.nonce='0x9';return structuredClone(f.response);};
  await f.flow.send(f.plan,f.check,true);assert.deepEqual(sends(f.provider)[0].params,[original]);assert.equal(f.saved[0].attempt.sourceCommit,'a'.repeat(40));
});

test('single send lock spans asynchronous wallet reads and reservation',async()=>{
  for(const phase of ['wallet','reserve']){
    const f=fixture(),gate=deferred<unknown>(),entered=deferred<void>();
    if(phase==='wallet')f.provider.intercept=request=>{if(request.method==='eth_accounts'&&f.provider.calls.length===1){entered.resolve();return gate.promise;}return defaults;};
    else f.hooks.reserve=async()=>{entered.resolve();await gate.promise;return structuredClone(f.response);};
    const first=f.flow.send(f.plan,f.check,true);await entered.promise;
    await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_SEND_PENDING');await rejectsCode(f.flow.connect(),'METAMASK_SEND_PENDING');
    gate.resolve(phase==='wallet'?[a(1)]:undefined);await first;assert.equal(f.reserveCalls.length,1);assert.equal(sends(f.provider).length,1);
  }
});

test('send rejection, cancellation and malformed hash have no retry, fallback or invented hash',async()=>{
  for(const outcome of ['cancel','throw','badHash','missingHash']){
    const f=fixture();f.provider.intercept=request=>{
      if(request.method!=='eth_sendTransaction')return defaults;
      if(outcome==='cancel')throw {code:4001,message:'private wallet cancellation'};
      if(outcome==='throw')throw new Error('apikey_example_private send failure');
      return outcome==='badHash'?'0x1234':undefined;
    };
    await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_SEND_OUTCOME_UNKNOWN');
    await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_ALREADY_RESERVED');assert.equal(sends(f.provider).length,1);assert.equal(f.recordCalls.length,0);assert.deepEqual(f.saved,[]);
    assert.equal(f.flow.submitted,null);
    assert.equal(f.provider.calls.some(call=>/sign|switch|sendCalls/.test(call.method)),false);
  }
});

test('returned transaction hash is saved and recorded even after wallet events or disposal',async()=>{
  for(const event of ['accountsChanged','chainChanged','disconnect','dispose']){
    const f=fixture();f.provider.intercept=request=>{if(request.method==='eth_sendTransaction'){if(event==='dispose')f.flow.dispose();else f.provider.emit(event);return h(20);}return defaults;};
    await f.flow.send(f.plan,f.check,true);assert.deepEqual(f.trace,['reserve','save','record']);assert.equal(f.saved[0].hash,h(20));assert.equal(f.recordCalls.length,1);
  }
});

test('recording failure keeps the saved public hash and does not allow another send',async()=>{
  const f=fixture();f.hooks.record=()=>{throw new Error('private backend output');};
  await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_HASH_RECORD_FAILED');assert.equal(f.saved[0].hash,h(20));
  assert.deepEqual(f.flow.submitted,{attempt:f.attempt,transactionHash:h(20)});
  await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_ALREADY_RESERVED');assert.equal(sends(f.provider).length,1);
});

test('save callback failure still posts the returned hash and cannot allow retransmission',async()=>{
  const f=fixture(),flow=new MetaMaskDeploymentFlow(f.provider,f.backend,{saveHash:()=>{f.trace.push('save');throw new Error('private storage failure');}});
  await rejectsCode(flow.send(f.plan,f.check,true),'METAMASK_HASH_SAVE_FAILED');assert.equal(f.recordCalls[0].transactionHash,h(20));assert.deepEqual(f.trace,['reserve','save','record']);
  assert.deepEqual(flow.submitted,{attempt:f.attempt,transactionHash:h(20)});
  await rejectsCode(flow.send(f.plan,f.check,true),'METAMASK_ALREADY_RESERVED');assert.equal(sends(f.provider).length,1);
});

test('recorded submitted, confirmed and reverted attempts keep hash and metadata identity',async()=>{
  for(const status of ['SUBMITTED','CONFIRMED','REVERTED'] as const){
    const f=fixture();f.hooks.record=input=>({...f.attempt,status,transactionHash:input.transactionHash,contractAddress:status==='CONFIRMED'?f.check.predictedAddress.toLowerCase():null,updatedAt:later});
    await f.flow.send(f.plan,f.check,true);assert.equal(f.saved[0].hash,h(20));
  }
});

test('recordHash responses cannot regress or replace the original attempt metadata or hash',async()=>{
  const mutations:Array<(record:MetaMaskAttempt)=>void>=[
    r=>{r.attemptId='33333333-3333-4333-8333-333333333333';},r=>{r.planId=h(99);},r=>{r.sourceCommit='b'.repeat(40);},
    r=>{r.deployer=a(9);},r=>{r.initCodeHash=h(99);},r=>{r.nonce='0x1';},r=>{r.gas='0x65';},r=>{r.maxFeePerGas='0x3';},r=>{r.maxPriorityFeePerGas='0x0';},
    r=>{r.createdAt=later;},r=>{r.updatedAt='2026-10-01T23:59:59.000Z';},r=>{r.transactionHash=h(99);},
    r=>{r.status='RESERVED';r.transactionHash=null;},r=>{r.status='CONFIRMED';r.contractAddress=a(9);},r=>{r.contractAddress=a(9);}
  ];
  for(const mutate of mutations){const f=fixture();f.hooks.record=input=>{const record:MetaMaskAttempt={...f.attempt,status:'SUBMITTED',transactionHash:input.transactionHash,updatedAt:later};mutate(record);return record;};
    await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_HASH_RECORD_MISMATCH');assert.equal(f.saved[0].hash,h(20));await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_ALREADY_RESERVED');}
});

test('dispose removes all listeners and aborts pending pre-send reads',async()=>{
  const f=fixture(),gate=deferred<unknown>(),entered=deferred<void>();
  f.provider.intercept=request=>{if(request.method==='eth_accounts'){entered.resolve();return gate.promise;}return defaults;};
  const sending=f.flow.send(f.plan,f.check,true);await entered.promise;f.flow.dispose();f.flow.dispose();gate.resolve([a(1)]);
  await rejectsCode(sending,'METAMASK_FLOW_DISPOSED');assert.equal(f.reserveCalls.length,0);assert.equal(sends(f.provider).length,0);
  assert.deepEqual(f.provider.removed,['accountsChanged','chainChanged','disconnect']);assert.equal([...f.provider.listeners.values()].reduce((sum,set)=>sum+set.size,0),0);
  await rejectsCode(f.flow.connect(),'METAMASK_FLOW_DISPOSED');
});

test('replacement of the injected provider without events prevents connect or any pre-send work',async()=>{
  for(const phase of ['before','connect','read','reserve','lastRead']){
    const f=fixture();let current:MetaMaskProvider|undefined=f.provider;
    const flow=new MetaMaskDeploymentFlow(f.provider,f.backend,{saveHash:f.saveHash,currentProvider:()=>current});
    if(phase==='before')current=new LocalProvider();
    else if(phase==='connect')f.provider.intercept=request=>{if(request.method==='eth_getBalance')current=new LocalProvider();return defaults;};
    else if(phase==='reserve')f.hooks.reserve=()=>{current=new LocalProvider();return structuredClone(f.response);};
    else {let reads=0;f.provider.intercept=request=>{if(phase==='read'&&request.method==='eth_accounts'||phase==='lastRead'&&request.method==='eth_getTransactionCount'&&++reads===4)current=new LocalProvider();return defaults;};}
    await rejectsCode(phase==='connect'?flow.connect():flow.send(f.plan,f.check,true),'METAMASK_PROVIDER_CHANGED');assert.equal(sends(f.provider).length,0);
    assert.equal(f.reserveCalls.length,phase==='reserve'||phase==='lastRead'?1:0);
  }
});

test('provider replacement after submission still preserves and posts the returned hash',async()=>{
  const f=fixture();let current:MetaMaskProvider|undefined=f.provider;
  const flow=new MetaMaskDeploymentFlow(f.provider,f.backend,{saveHash:f.saveHash,currentProvider:()=>current});
  f.provider.intercept=request=>{if(request.method==='eth_sendTransaction'){current=undefined;return h(20);}return defaults;};
  await rejectsCode(flow.send(f.plan,f.check,true),'METAMASK_PROVIDER_CHANGED');assert.equal(f.saved[0].hash,h(20));assert.equal(f.recordCalls[0].transactionHash,h(20));assert.deepEqual(f.trace,['reserve','save','record']);
});

test('submitted getter keeps a defensive copy of public metadata when save is omitted and record fails',async()=>{
  const f=fixture(),flow=new MetaMaskDeploymentFlow(f.provider,f.backend);
  assert.equal(flow.submitted===null,true);f.hooks.record=()=>{throw new Error('private failure');};
  await rejectsCode(flow.send(f.plan,f.check,true),'METAMASK_HASH_RECORD_FAILED');
  assert.deepEqual(flow.submitted,{attempt:f.attempt,transactionHash:h(20)});
  const copy=flow.submitted!;copy.transactionHash=h(99);copy.attempt.sourceCommit='b'.repeat(40);
  assert.deepEqual(flow.submitted,{attempt:f.attempt,transactionHash:h(20)});
  await rejectsCode(flow.send(f.plan,f.check,true),'METAMASK_ALREADY_RESERVED');assert.equal(sends(f.provider).length,1);
});

test('submitted metadata is stored before callbacks even if both local save and server record fail',async()=>{
  const f=fixture();let flow:MetaMaskDeploymentFlow;
  flow=new MetaMaskDeploymentFlow(f.provider,f.backend,{saveHash:()=>{assert.deepEqual(flow.submitted,{attempt:f.attempt,transactionHash:h(20)});throw new Error('local save failure');}});
  f.hooks.record=()=>{throw new Error('private failure');};
  await rejectsCode(flow.send(f.plan,f.check,true),'METAMASK_HASH_RECORD_FAILED');assert.deepEqual(flow.submitted,{attempt:f.attempt,transactionHash:h(20)});
  await rejectsCode(flow.send(f.plan,f.check,true),'METAMASK_ALREADY_RESERVED');
});

test('single send lock also spans the wallet send and hash-record awaits',async()=>{
  for(const phase of ['send','record']){
    const f=fixture(),gate=deferred<unknown>(),entered=deferred<void>();
    if(phase==='send')f.provider.intercept=request=>{if(request.method==='eth_sendTransaction'){entered.resolve();return gate.promise;}return defaults;};
    else f.hooks.record=async input=>{entered.resolve();await gate.promise;return {...f.attempt,status:'SUBMITTED',transactionHash:input.transactionHash,updatedAt:later};};
    const sending=f.flow.send(f.plan,f.check,true);await entered.promise;
    await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_SEND_PENDING');
    assert.equal(f.flow.submitted===null,phase==='send');gate.resolve(phase==='send'?h(20):undefined);
    await sending;assert.equal(f.reserveCalls.length,1);assert.equal(sends(f.provider).length,1);
  }
});

test('strict gate handoff sends exactly one original zero-value CREATE at its fixed nonce and no future escrow transaction',async()=>{
  const f=gateFixture(),original=structuredClone(f.check.transaction);
  assert.equal(f.plan.kind,'CLEANVERSE_GATE');assert.equal(f.plan.gateNonce,'0x3');
  assert.equal(f.plan.pool.toLowerCase(),getContractAddress({from:a(1),nonce:4n}).toLowerCase());
  assert.equal(f.check.predictedAddress,getContractAddress({from:a(1),nonce:3n}));assert.notEqual(f.plan.data,f.plan.escrowData);
  assert.deepEqual(await f.flow.send(f.plan,f.check,true),{attemptId:f.attempt.attemptId,transactionHash:h(20)});
  assert.deepEqual(sends(f.provider),[{method:'eth_sendTransaction',params:[original]}]);
  assert.equal(original.data,f.plan.data);assert.equal(original.value,'0x0');assert.equal('to' in original,false);
  assert.deepEqual(f.reserveCalls,[{planId:f.plan.planId,checkId:f.check.checkId}]);assert.equal(f.saved[0].attempt.initCodeHash,f.plan.initCodeHash);assert.equal(f.saved[0].attempt.nonce,f.plan.gateNonce);
  assert.deepEqual(f.trace,['reserve','save','record']);assert.equal(f.provider.calls.some(call=>/sign|switch|sendCalls/.test(call.method)),false);
  await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_ALREADY_RESERVED');assert.equal(sends(f.provider).length,1);
});

test('gate pool and preflight nonce drift are rejected before wallet reads or reservation',async()=>{
  for(const mutation of ['pool','planNonce','transactionNonce','wrongData','value','to']){
    const f=gateFixture();
    if(mutation==='pool')f.plan.pool=a(99);
    else if(mutation==='planNonce')f.plan.gateNonce='0x4';
    else if(mutation==='transactionNonce'){f.check.transaction.nonce='0x4';f.check.predictedAddress=getContractAddress({from:a(1),nonce:4n});f.provider.pending='0x4';f.provider.latest='0x4';}
    else if(mutation==='wrongData')f.check.transaction.data=f.plan.escrowData;
    else if(mutation==='value')f.check.transaction.value='0x1' as '0x0';
    else Object.assign(f.check.transaction,{to:f.plan.pool});
    await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_PLAN_OR_PREFLIGHT_INVALID');assert.equal(f.provider.calls.length,0);assert.equal(f.reserveCalls.length,0);
  }
});

test('gate future escrow data hash and fixed constructor roles cannot be tampered independently',async()=>{
  const mutations:Array<(plan:MetaMaskGatePlan)=>void>=[
    plan=>{plan.escrowData='0x6001'+plan.escrowData.slice(6);},plan=>{plan.escrowInitCodeHash=h(99);},
    plan=>{plan.asset=a(99);},plan=>{plan.validator=a(99);},plan=>{plan.policy=a(99);},plan=>{plan.reviewer=a(99);},
    plan=>{plan.committee[0]=a(99);},plan=>{plan.committee[1]=plan.committee[0];},plan=>{plan.committee[0]=plan.pool;},
    plan=>{plan.deployer=a(99);},plan=>{plan.initCodeHash=h(99);},plan=>{plan.planId=h(99);}
  ];
  for(const mutate of mutations){const f=gateFixture();mutate(f.plan);await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_PLAN_OR_PREFLIGHT_INVALID');assert.equal(f.provider.calls.length,0);assert.equal(f.reserveCalls.length,0);}
});

test('self-consistent future escrow preview changes can parse but authorize only the one unchanged gate CREATE',async()=>{
  const f=gateFixture(),original=structuredClone(f.check.transaction),originalPlanId=f.plan.planId,originalGateHash=f.plan.initCodeHash;
  // Gate identity binds its actual send bytes. Future escrow preview is not artifact provenance or a second approval.
  f.plan.escrowData='0x6001'+f.plan.escrowData.slice(6);f.plan.escrowInitCodeHash=keccak256(f.plan.escrowData as `0x${string}`);
  assert.equal(MetaMaskWalletPlanSchema.safeParse(f.plan).success,true);assert.equal(f.plan.planId,originalPlanId);assert.equal(f.plan.initCodeHash,originalGateHash);
  await f.flow.send(f.plan,f.check,true);assert.deepEqual(sends(f.provider),[{method:'eth_sendTransaction',params:[original]}]);
  assert.equal(sends(f.provider).some(call=>(call.params?.[0] as {data:string}).data===f.plan.escrowData),false);
  await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_ALREADY_RESERVED');assert.equal(sends(f.provider).length,1);
});

test('a gate never falls through to the legacy plan schema when kind is missing or altered',async()=>{
  const f=gateFixture(),{kind:_kind,...withoutKind}=f.plan;
  const legacyShape={planId:f.plan.planId,sourceCommit:f.plan.sourceCommit,chainId:f.plan.chainId,deployer:f.plan.deployer,asset:f.plan.asset,gate:f.check.predictedAddress,reviewer:f.plan.reviewer,committee:f.plan.committee,data:f.plan.data,initCodeHash:f.plan.initCodeHash};
  for(const plan of [withoutKind,{...f.plan,kind:'ESCROW'},legacyShape]){
    assert.equal(MetaMaskPlanSchema.safeParse(plan).success,false);
    await rejectsCode(f.flow.send(plan as MetaMaskWalletPlan,f.check,true),'METAMASK_PLAN_OR_PREFLIGHT_INVALID');assert.equal(f.provider.calls.length,0);assert.equal(f.reserveCalls.length,0);
  }
  assert.equal(keccak256(f.plan.data as `0x${string}`),f.plan.initCodeHash);
});

test('gate wallet or reserve nonce drift consumes the reservation without sending or retrying',async()=>{
  for(const mutation of ['wallet','preflight','attempt']){
    const f=gateFixture();
    f.hooks.reserve=()=>{
      if(mutation==='wallet'){f.provider.pending='0x4';f.provider.latest='0x4';}
      else if(mutation==='preflight'){f.response.preflight.transaction.nonce='0x4';f.response.preflight.predictedAddress=getContractAddress({from:a(1),nonce:4n});}
      else f.response.attempt.nonce='0x4';
      return structuredClone(f.response);
    };
    await rejectsCode(f.flow.send(f.plan,f.check,true),mutation==='wallet'?'METAMASK_NONCE_MISMATCH':'METAMASK_RESERVATION_MISMATCH');
    assert.equal(f.reserveCalls.length,1);assert.equal(sends(f.provider).length,0);await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_ALREADY_RESERVED');
  }
});

test('gate plan and transaction remain frozen across reservation while its saved hash survives record failure',async()=>{
  const f=gateFixture(),original=structuredClone(f.check.transaction),fixedSource=f.plan.sourceCommit,fixedInit=f.plan.initCodeHash;
  f.hooks.reserve=()=>{f.plan.pool=a(99);f.plan.escrowData='0x6001';f.plan.sourceCommit='b'.repeat(40);f.plan.data='0x6001';f.check.transaction.nonce='0x4';return structuredClone(f.response);};
  f.hooks.record=()=>{throw new Error('local synthetic journal failure');};
  await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_HASH_RECORD_FAILED');
  assert.deepEqual(sends(f.provider)[0].params,[original]);assert.equal(f.saved[0].attempt.sourceCommit,fixedSource);assert.equal(f.saved[0].attempt.initCodeHash,fixedInit);
  assert.deepEqual(f.flow.submitted,{attempt:f.attempt,transactionHash:h(20)});assert.equal(f.recordCalls[0].transactionHash,h(20));
  await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_ALREADY_RESERVED');assert.equal(sends(f.provider).length,1);
});

test('unknown gate wallet send outcomes keep the reservation and never invent or retry a transaction hash',async()=>{
  const f=gateFixture();f.provider.intercept=request=>{if(request.method==='eth_sendTransaction')throw new Error('local synthetic cancellation');return defaults;};
  await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_SEND_OUTCOME_UNKNOWN');assert.equal(f.flow.submitted,null);assert.equal(f.saved.length,0);assert.equal(f.recordCalls.length,0);
  await rejectsCode(f.flow.send(f.plan,f.check,true),'METAMASK_ALREADY_RESERVED');assert.equal(f.reserveCalls.length,1);assert.equal(sends(f.provider).length,1);
});
