import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {type Address,type Hex} from 'viem';
import {MetaMaskPreflightRejected,MetaMaskNoReservationResponseSchema} from '../scripts/metamask-preflight-rejection.js';
import {createMetaMaskServer,type MetaMaskOperatorService} from '../scripts/metamask-server.js';
import {MetaMaskDemoDependencyService} from '../scripts/metamask-demo-service.js';
import {MetaMaskDeploymentService,type MetaMaskReadPort} from '../scripts/metamask-service.js';
import {type DemoDependencyReadPort} from '../scripts/demo-dependency.js';
import {DeploymentAttemptStore} from '../packages/storage/src/deployment-attempt-store.js';

/** Actual loopback HTTP and temporary SQLite journals, with explicit local
 * bytecode, account, RPC and fee doubles. No .env, external RPC, browser, wallet,
 * compiler, signing, broadcast or real deployment is used. */
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address;
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
const DEPLOYER=a(1),ASSET=a(2),GATE=a(3),COMMIT='a'.repeat(40);
const knownCodes=['DEPLOYMENT_PREFLIGHT_EXPIRED','DEPLOYMENT_PREFLIGHT_CHANGED'] as const;
const response=(code:typeof knownCodes[number])=>({code,reservationOutcome:'NOT_CREATED_BY_THIS_REQUEST',signaturesRequested:0,transactionsSent:0});
const tokenRuntime='0x6001600200' as Hex;
const tokenArtifact={abi:[{type:'constructor',stateMutability:'nonpayable',inputs:[{type:'address'}]}],
  bytecode:{object:'0x60016000'},deployedBytecode:{object:tokenRuntime,immutableReferences:{},linkReferences:{}}};
const gateRuntime=`0x6001${ASSET.slice(2).padStart(64,'0')}6002` as Hex;
const gateArtifact={abi:[{type:'constructor',stateMutability:'nonpayable',inputs:[{type:'address'}]}],bytecode:{object:'0x60026000'},
  deployedBytecode:{object:`0x6001${'0'.repeat(64)}6002`,immutableReferences:{asset:[{start:2,length:32}]},linkReferences:{}}};
const escrowArtifact={abi:[{type:'constructor',stateMutability:'nonpayable',inputs:[{type:'address'},{type:'address'},{type:'address'},{type:'address[3]'}]}],bytecode:{object:'0x6000'}};
type Kind='ASSET'|'GATE'|'ESCROW';

function fixture(t:test.TestContext,kind:Kind){
  const root=mkdtempSync(join(tmpdir(),'intentpass-preflight-rejection-synthetic-')),path=join(root,'operator.db');
  const store=new DeploymentAttemptStore(path),stores=[store];
  t.after(()=>{for(const opened of stores)opened.close();rmSync(root,{recursive:true,force:true});});
  const state={now:1_700_000_000_000,fee:10n,nonce:2n,bumpNonceDuringEstimate:false,afterCommitError:false};
  const calls={reserve:0,legacyGate:0,proof:0};
  const block=async(number?:bigint)=>({number:number??23n,hash:h(Number(number??23n)),timestamp:100n});
  const code=async(address:Address)=>address===DEPLOYER?'0x' as Hex:address===GATE?gateRuntime:tokenRuntime;
  const estimate=async()=>{if(state.bumpNonceDuringEstimate){state.bumpNonceDuringEstimate=false;state.nonce++;}return 100n;};
  const neverProof=async()=>{calls.proof++;throw Error('LOCAL_DOUBLE_PROOF_MUST_NOT_RUN');};
  const dependencyPort:DemoDependencyReadPort={chainId:async()=>10143,block,code,nonce:async()=>state.nonce,balance:async()=>100000n,
    fees:async()=>({maxFeePerGas:state.fee,maxPriorityFeePerGas:1n}),estimate,
    token:async()=>({name:'IntentPass TEST ONLY Demo Token',symbol:'IPTEST',decimals:6,totalSupply:1_000_000_000_000n}),
    gate:async()=>({asset:ASSET}),transaction:neverProof,receipt:neverProof};
  const escrowPort:MetaMaskReadPort={chainId:async()=>10143,block,code,balance:async()=>100000n,currentBalance:async()=>100000n,
    nonce:async()=>state.nonce,fees:async()=>({maxFeePerGas:state.fee,maxPriorityFeePerGas:1n}),estimate,
    gate:async()=>{calls.legacyGate++;throw Error('LOCAL_DOUBLE_LEGACY_GATE_MUST_NOT_RUN');},demoGate:async()=>({asset:ASSET}),
    proof:{blockTag:'finalized',chainId:neverProof,block:neverProof,code:neverProof,transaction:neverProof,receipt:neverProof,configuration:neverProof}};
  const make=(journal=store):MetaMaskOperatorService=>kind==='ESCROW'
    ?new MetaMaskDeploymentService({config:{chainId:'10143',deployer:DEPLOYER,asset:ASSET,gate:GATE,reviewer:a(4),committee:[a(5),a(6),a(7)]},
      artifact:escrowArtifact,gateArtifact,assetMode:'demo-erc20',sourceCommit:COMMIT,sourceClean:()=>true,store:journal,port:escrowPort,clock:()=>state.now})
    :new MetaMaskDemoDependencyService({dependency:kind,config:{chainId:'10143',deployer:DEPLOYER,...(kind==='GATE'?{asset:ASSET}:{})},
      artifact:kind==='ASSET'?tokenArtifact:gateArtifact,assetArtifact:tokenArtifact,sourceCommit:COMMIT,sourceClean:()=>true,store:journal,port:dependencyPort,clock:()=>state.now});
  const service=make(),reserve=store.reserve.bind(store);
  store.reserve=input=>{calls.reserve++;const result=reserve(input);if(state.afterCommitError)throw Error('DEPLOYMENT_PREFLIGHT_CHANGED');return result;};
  const reopen=()=>{store.close();const journal=new DeploymentAttemptStore(path);stores.push(journal);return journal;};
  return {store,state,calls,service,make,reopen,plan:service.status().plan!};
}

async function start(t:test.TestContext,service:MetaMaskOperatorService){
  const app=createMetaMaskServer({service,staticFiles:new Map()});t.after(()=>app.close());
  await new Promise<void>((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',()=>{app.server.off('error',reject);resolve();});});
  const address=app.server.address();assert.ok(address&&typeof address==='object');const url=`http://127.0.0.1:${address.port}`;
  const call=async(path='/api/reserve',body:unknown={},method='POST')=>{
    const res=await fetch(url+path,{method,headers:{Origin:url,'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});
    return {status:res.status,body:await res.json() as unknown,headers:res.headers};
  };
  return {call};
}
function throwingService(error:unknown):MetaMaskOperatorService{
  const reject=()=>{throw error;};return {status:reject,preflight:async()=>reject(),reserve:async()=>reject(),recordHash:reject,reconcile:async()=>reject()};
}

test('typed no-reservation responses accept only the two exact known pre-store reasons and zero action counts',()=>{
  for(const code of knownCodes){const error=new MetaMaskPreflightRejected(code);assert.ok(error instanceof Error);assert.equal(error.message,code);
    assert.deepEqual(MetaMaskNoReservationResponseSchema.parse(response(code)),response(code));}
  assert.throws(()=>new MetaMaskPreflightRejected('DEPLOYMENT_DATABASE_UNKNOWN' as typeof knownCodes[number]));
  for(const patch of [{code:'DEPLOYMENT_DATABASE_UNKNOWN'},{code:'DEPLOYMENT_NONCE_ALREADY_RESERVED'},
    {reservationOutcome:'NOT_CREATED'},{reservationOutcome:'NO_RESERVATION_EXISTS'},
    {signaturesRequested:1},{transactionsSent:1},{signaturesRequested:'0'},{transactionsSent:null},
    {canExecute:false},{attempt:null},{transactionHash:null},{missing:[]}])
    assert.equal(MetaMaskNoReservationResponseSchema.safeParse({...response(knownCodes[0]),...patch}).success,false);
});

for(const code of knownCodes)test(`loopback reserve exposes exact typed metadata for ${code}`,async t=>{
  const {call}=await start(t,throwingService(new MetaMaskPreflightRejected(code))),result=await call();
  assert.equal(result.status,409);assert.deepEqual(result.body,response(code));assert.equal(result.headers.get('cache-control'),'no-store');
  assert.equal(MetaMaskNoReservationResponseSchema.safeParse(result.body).success,true);
});

test('loopback ordinary errors with the same code or class name cannot claim no reservation',async t=>{
  for(const code of knownCodes){const error=Error(code);error.name='MetaMaskPreflightRejected';const {call}=await start(t,throwingService(error));
    const result=await call();assert.equal(result.status,409);assert.deepEqual(result.body,{code});}
  const altered=new MetaMaskPreflightRejected(knownCodes[0]);altered.message='DEPLOYMENT_DATABASE_UNKNOWN';
  const {call}=await start(t,throwingService(altered));assert.deepEqual((await call()).body,{code:'DEPLOYMENT_DATABASE_UNKNOWN'});
});

test('loopback typed errors outside reserve never expose the reservation declaration',async t=>{
  const {call}=await start(t,throwingService(new MetaMaskPreflightRejected(knownCodes[1])));
  for(const path of ['/api/preflight','/api/record-hash','/api/reconcile']){
    const result=await call(path);assert.equal(result.status,409);assert.deepEqual(result.body,{code:knownCodes[1]});
  }
  const status=await call('/api/status',undefined,'GET');assert.equal(status.status,503);assert.deepEqual(status.body,{code:'DEPLOYMENT_STATE_UNAVAILABLE'});
});

for(const kind of ['ASSET','GATE','ESCROW'] as const){
  test(`synthetic ${kind} expiry is typed before the durable store can reserve`,async t=>{
    const f=fixture(t,kind),check=await f.service.preflight();f.state.now+=60_001;
    await assert.rejects(f.service.reserve({planId:f.plan.planId,checkId:check.checkId}),error=>error instanceof MetaMaskPreflightRejected&&error.message===knownCodes[0]);
    assert.equal(f.calls.reserve,0);assert.equal(f.store.get(f.plan.planId),null);assert.equal(f.calls.legacyGate,0);assert.equal(f.calls.proof,0);
  });
  test(`synthetic ${kind} changed fees return typed HTTP rejection before the durable store`,async t=>{
    const f=fixture(t,kind),check=await f.service.preflight();f.state.fee=20n;const {call}=await start(t,f.service);
    const result=await call('/api/reserve',{planId:f.plan.planId,checkId:check.checkId});
    assert.equal(result.status,409);assert.deepEqual(result.body,response(knownCodes[1]));assert.equal(f.calls.reserve,0);assert.equal(f.store.get(f.plan.planId),null);
  });
  test(`synthetic ${kind} nonce drift during reserve preflight becomes typed before storing`,async t=>{
    const f=fixture(t,kind),check=await f.service.preflight();f.state.bumpNonceDuringEstimate=true;
    await assert.rejects(f.service.reserve({planId:f.plan.planId,checkId:check.checkId}),error=>error instanceof MetaMaskPreflightRejected&&error.message===knownCodes[1]);
    assert.equal(f.calls.reserve,0);assert.equal(f.store.get(f.plan.planId),null);
  });
  test(`synthetic ${kind} post-commit unknown same-code error gives no claim and preserves the nonce lock`,async t=>{
    const f=fixture(t,kind),check=await f.service.preflight();f.state.afterCommitError=true;const {call}=await start(t,f.service);
    const result=await call('/api/reserve',{planId:f.plan.planId,checkId:check.checkId});
    assert.equal(result.status,409);assert.deepEqual(result.body,{code:knownCodes[1]});assert.equal(f.calls.reserve,1);
    const stored=f.store.get(f.plan.planId)!;assert.equal(stored.status,'RESERVED');assert.equal(stored.transactionHash,null);
    const journal=f.reopen();assert.equal(journal.get(f.plan.planId)!.attemptId,stored.attemptId);
    f.state.now+=120_000;await assert.rejects(f.make(journal).preflight(),/DEPLOYMENT_ATTEMPT_ALREADY_RESERVED/);
    assert.equal(journal.get(f.plan.planId)!.status,'RESERVED');assert.equal(f.calls.reserve,1);
  });
  test(`synthetic ${kind} rejected repeat describes only this request while an earlier reservation stays present`,async t=>{
    const f=fixture(t,kind),check=await f.service.preflight(),first=await f.service.reserve({planId:f.plan.planId,checkId:check.checkId});
    const {call}=await start(t,f.service),result=await call('/api/reserve',{planId:f.plan.planId,checkId:check.checkId});
    assert.equal(result.status,409);assert.deepEqual(result.body,response(knownCodes[0]));assert.equal(f.calls.reserve,1);
    assert.equal(f.store.get(f.plan.planId)!.attemptId,first.attempt.attemptId);assert.equal(f.store.get(f.plan.planId)!.status,'RESERVED');
  });
}
