import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import {encodeAbiParameters,formatEther,keccak256,toBytes,type Address} from 'viem';
import {MetaMaskWalletPlanSchema,MetaMaskPreflightSchema,type MetaMaskWalletPlan,type MetaMaskPreflight,type MetaMaskAttempt} from '../scripts/metamask-types.js';
import {MetaMaskPreflightRejected,MetaMaskNoReservationResponseSchema} from '../scripts/metamask-preflight-rejection.js';
import {strictJsonParse} from '../scripts/strict-json.js';

// Synthetic DOM, clock, HTTP and wallet doubles. No browser, real wallet or
// provider call is made, and these results are not deployment evidence.
const source=ts.transpileModule(readFileSync('scripts/metamask-page/client.ts','utf8'),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext},
  transformers:{before:[()=>file=>ts.factory.updateSourceFile(file,file.statements.filter(statement=>!ts.isImportDeclaration(statement)))]}
}).outputText.replace(/export\s*\{\s*\};?\s*$/,'');
type Node={textContent:string;disabled:boolean;checked:boolean;value:string;children:Node[];onclick?:()=>void;onchange?:()=>void;replaceChildren:()=>void;append:(...nodes:Node[])=>void};
const address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address;
const hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as `0x${string}`;
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function fixture(){
  let now=1_700_000_000_000,age=0,sendCalls=0,disposed=0,walletCheckCalls=0;
  const deployer=address(1),data=`0x6000${encodeAbiParameters([{type:'address'}],[deployer]).slice(2)}` as `0x${string}`,initCodeHash=keccak256(data);
  const plan=MetaMaskWalletPlanSchema.parse({kind:'DEMO_DEPENDENCY',dependency:'ASSET',chainId:'10143',deployer,recipient:deployer,asset:null,sourceCommit:'a'.repeat(40),data,initCodeHash,planId:keccak256(toBytes(JSON.stringify(['10143',deployer.toLowerCase(),initCodeHash])))});
  const nodes=new Map<string,Node>();
  for(const match of readFileSync('scripts/metamask-page/index.html','utf8').matchAll(/id="([^"]+)"/g)){
    const node:Node={textContent:'',disabled:['check','confirm','send','recover','reconcile'].includes(match[1]),checked:false,value:'',children:[],replaceChildren(){this.children=[];},append(...values){this.children.push(...values);}};nodes.set(match[1],node);
  }
  const timers=new Map<number,{callback:()=>void;at:number;interval?:number}>();let nextTimer=0;
  const schedule=(callback:()=>void,delay:number,interval?:number)=>{const id=++nextTimer;timers.set(id,{callback,at:now+delay,...(interval?{interval}:{})});return id;};
  const events=new Map<string,()=>void>(),requests:string[]=[];
  const responseOverrides=new Map<string,{status:number;raw:string|(()=>string)}>();
  let sendWork:()=>Promise<{attemptId:string;transactionHash:string}>=async()=>({attemptId:randomUUID(),transactionHash:hash(20)});
  let walletCheckWork:(selectedPlan:MetaMaskWalletPlan,selectedCheck:MetaMaskPreflight)=>Promise<void>=async()=>{};
  const walletChecks:{plan:MetaMaskWalletPlan;check:MetaMaskPreflight}[]=[];
  class FakeFlow{
    submitted=null;
    dispose(){disposed++;}
    async connect(){return {account:deployer,chainId:'0x279f',balance:'1000'};}
    async checkWallet(selectedPlan:MetaMaskWalletPlan,selectedCheck:MetaMaskPreflight){walletCheckCalls++;walletChecks.push({plan:structuredClone(selectedPlan),check:structuredClone(selectedCheck)});await walletCheckWork(selectedPlan,selectedCheck);}
    async send(){sendCalls++;return sendWork();}
  }
  class ClockDate extends Date{static now(){return now;}}
  const context=vm.createContext({formatEther,MetaMaskWalletPlanSchema,MetaMaskPreflightSchema,MetaMaskPreflightRejected,MetaMaskNoReservationResponseSchema,strictJsonParse,MetaMaskDeploymentFlow:FakeFlow,Date:ClockDate,
    setTimeout:(callback:()=>void,delay:number)=>schedule(callback,delay),clearTimeout:(id:number)=>timers.delete(id),setInterval:(callback:()=>void,delay:number)=>schedule(callback,delay,delay),clearInterval:(id:number)=>timers.delete(id),
    document:{documentElement:{dataset:{}},getElementById:(id:string)=>nodes.get(id),createElement:()=>({textContent:''})},
    window:{ethereum:{isMetaMask:true,on:()=>{},removeListener:()=>{}},addEventListener:(event:string,callback:()=>void)=>events.set(event,callback)},localStorage:{getItem:()=>null,setItem:()=>{}},
    fetch:async(path:string)=>{requests.push(path);const response=responseOverrides.get(path);if(response){return {ok:response.status>=200&&response.status<300,status:response.status,text:async()=>typeof response.raw==='function'?response.raw():response.raw};}const value=path==='/api/preflight'?{planId:plan.planId,checkId:randomUUID(),checkedAt:new Date(now-age).toISOString(),predictedAddress:address(8),balance:'1000',estimatedMaxCost:'200',transaction:{from:deployer,chainId:'0x279f',data,value:'0x0',nonce:'0x0',gas:'0x64',maxFeePerGas:'0x2',maxPriorityFeePerGas:'0x1'}}:{scope:'LOCAL_OPERATOR_METAMASK_DEPLOYMENT_HANDOFF',ready:true,blockers:[],plan,attempt:null,officialIntegrationVerified:false,transactionsSentByServer:0};return {ok:true,status:200,text:async()=>JSON.stringify(value)};}
  });
  vm.runInContext(source,context);await settle();
  nodes.get('connect')!.onclick!();await settle();
  const clickCheck=async()=>{nodes.get('check')!.onclick!();await settle();};
  const confirm=()=>{nodes.get('confirm')!.checked=true;nodes.get('confirm')!.onchange!();};
  const advance=(elapsed:number,fire=true)=>{now+=elapsed;if(fire)for(const [id,timer]of [...timers]){if(!timers.has(id)||timer.at>now)continue;if(timer.interval)timer.at=now+timer.interval;else timers.delete(id);timer.callback();}};
  return {nodes,requests,timers,plan,walletChecks,clickCheck,confirm,advance,setAge:(value:number)=>{age=value;},setSend:(fn:typeof sendWork)=>{sendWork=fn;},setWalletCheck:(fn:typeof walletCheckWork)=>{walletCheckWork=fn;},setResponse:(path:string,status:number,raw:string|(()=>string))=>{responseOverrides.set(path,{status,raw});},refresh:():Promise<void>=>vm.runInContext('refresh()',context),apiCall:(path:string):Promise<unknown>=>vm.runInContext(`api(${JSON.stringify(path)}, {})`,context),queued:()=>[...timers.values()].map(timer=>timer.callback),pagehide:()=>events.get('pagehide')!(),counts:()=>({sendCalls,disposed,walletCheckCalls})};
}

function recordedAttempt(plan:MetaMaskWalletPlan,status:MetaMaskAttempt['status']):MetaMaskAttempt{
  return {attemptId:randomUUID(),planId:plan.planId,sourceCommit:plan.sourceCommit,chainId:'10143',deployer:plan.deployer,initCodeHash:plan.initCodeHash,nonce:'0x0',gas:'0x64',maxFeePerGas:'0x2',maxPriorityFeePerGas:'0x1',status,transactionHash:status==='RESERVED'?null:hash(20),contractAddress:status==='CONFIRMED'?address(8):null,createdAt:'2023-11-14T22:13:20.000Z',updatedAt:'2023-11-14T22:13:20.000Z'};
}
function recordedStatus(plan:MetaMaskWalletPlan,attempt:MetaMaskAttempt,sourceChanged=false){
  return {scope:'LOCAL_OPERATOR_METAMASK_DEPLOYMENT_HANDOFF',ready:false,blockers:[...(sourceChanged?['SOURCE_REVISION_CHANGED']:[]),'DEPLOYMENT_ATTEMPT_ALREADY_RESERVED'],plan,attempt,officialIntegrationVerified:false,transactionsSentByServer:0};
}

test('existing deployment records keep sending disabled and retain their original hash while showing state and source blockers',async()=>{
  for(const phase of ['RESERVED','SUBMITTED','CONFIRMED','REVERTED'] as const){
    const f=await fixture(),attempt=recordedAttempt(f.plan,phase);f.setResponse('/api/status',200,JSON.stringify(recordedStatus(f.plan,attempt,true)));await f.refresh();
    assert.equal(f.nodes.get('check')!.disabled,true);assert.equal(f.nodes.get('send')!.disabled,true);f.confirm();assert.equal(f.nodes.get('send')!.disabled,true);
    assert.equal(f.nodes.get('hash')!.value,attempt.transactionHash??'');assert.equal(f.counts().sendCalls,0);assert.equal(f.requests.includes('/api/reserve'),false);assert.equal(f.requests.includes('/api/reconcile'),false);
    const text=f.nodes.get('status')!.textContent;assert.match(text,/SOURCE_REVISION_CHANGED/);assert.doesNotMatch(text,/DEPLOYMENT_ATTEMPT_ALREADY_RESERVED/);
    if(phase==='CONFIRMED'){assert.match(text,/本项部署已确认/);assert.ok(text.includes(attempt.contractAddress!));}
    else{assert.doesNotMatch(text,/部署已确认/);assert.match(text,phase==='REVERTED'?/已回滚.*原部署记录已保留/:/待.*核对/);}
    await f.refresh();assert.equal(f.nodes.get('hash')!.value,attempt.transactionHash??'');assert.equal(f.counts().sendCalls,0);
  }
});

test('a submitted record shows confirmation only after an explicit reconcile returns it without changing its original hash',async()=>{
  const f=await fixture();let attempt=recordedAttempt(f.plan,'SUBMITTED');const originalHash=attempt.transactionHash;
  f.setResponse('/api/status',200,()=>JSON.stringify(recordedStatus(f.plan,attempt)));
  f.setResponse('/api/reconcile',200,()=>{attempt={...attempt,status:'CONFIRMED',contractAddress:address(8)};return JSON.stringify({attempt,proof:{status:'CONFIRMED',contractAddress:attempt.contractAddress}});});
  await f.refresh();await f.refresh();assert.doesNotMatch(f.nodes.get('status')!.textContent,/部署已确认/);assert.equal(f.requests.includes('/api/reconcile'),false);
  f.nodes.get('reconcile')!.onclick!();await settle();assert.equal(f.requests.filter(path=>path==='/api/reconcile').length,1);
  assert.match(f.nodes.get('status')!.textContent,/本项部署已确认/);assert.ok(f.nodes.get('status')!.textContent.includes(address(8)));assert.match(f.nodes.get('proof')!.textContent,/finalized/);
  assert.equal(f.nodes.get('hash')!.value,originalHash);assert.equal(f.nodes.get('check')!.disabled,true);assert.equal(f.nodes.get('send')!.disabled,true);assert.equal(f.counts().sendCalls,0);assert.equal(f.requests.includes('/api/reserve'),false);
});

test('wallet account, chain and nonce check must finish before enabling the confirmation checkbox',async()=>{
  const f=await fixture();let complete!:()=>void;f.setWalletCheck(()=>new Promise<void>(resolve=>{complete=resolve;}));
  await f.clickCheck();assert.equal(f.counts().walletCheckCalls,1);assert.equal(f.nodes.get('confirm')!.disabled,true);assert.equal(f.nodes.get('send')!.disabled,true);assert.equal(f.timers.size,0);
  assert.deepEqual(f.walletChecks[0].plan,f.plan);assert.equal(f.walletChecks[0].check.planId,f.plan.planId);assert.equal(f.walletChecks[0].check.transaction.nonce,'0x0');
  assert.equal(f.requests.filter(path=>path==='/api/preflight').length,1);assert.equal(f.requests.filter(path=>path==='/api/reserve').length,0);
  f.nodes.get('check')!.onclick!();f.nodes.get('send')!.onclick!();await settle();assert.equal(f.counts().walletCheckCalls,1);assert.equal(f.counts().sendCalls,0);
  complete();await settle();assert.equal(f.nodes.get('confirm')!.disabled,false);assert.equal(f.nodes.get('confirm')!.checked,false);assert.equal(f.nodes.get('send')!.disabled,true);
  assert.equal(f.nodes.get('result')!.textContent,'钱包账户、网络和交易序号已只读核对，尚未请求钱包发送。');
  assert.equal(f.counts().sendCalls,0);assert.equal(f.requests.filter(path=>path==='/api/reserve').length,0);
  await settle();assert.equal(f.counts().walletCheckCalls,1);assert.equal(f.counts().sendCalls,0);
});

test('a failed wallet check keeps confirmation disabled without reserve, send or automatic retry',async()=>{
  const f=await fixture();let reject!:(error:Error)=>void;f.setWalletCheck(()=>new Promise<void>((_resolve,fail)=>{reject=fail;}));
  await f.clickCheck();assert.equal(f.nodes.get('confirm')!.disabled,true);assert.equal(f.nodes.get('send')!.disabled,true);
  reject(Error('METAMASK_NONCE_MISMATCH'));await settle();assert.equal(f.nodes.get('confirm')!.disabled,true);assert.equal(f.nodes.get('send')!.disabled,true);assert.equal(f.timers.size,0);
  assert.match(f.nodes.get('result')!.textContent,/暂未完成/);assert.doesNotMatch(f.nodes.get('result')!.textContent,/已只读核对/);
  assert.equal(f.counts().walletCheckCalls,1);assert.equal(f.counts().sendCalls,0);assert.equal(f.requests.filter(path=>path==='/api/reserve').length,0);
  await settle();f.advance(60_000);assert.equal(f.counts().walletCheckCalls,1);assert.equal(f.counts().sendCalls,0);assert.equal(f.requests.filter(path=>path==='/api/preflight').length,1);
  f.setWalletCheck(async()=>{});await f.clickCheck();assert.equal(f.counts().walletCheckCalls,2);assert.equal(f.nodes.get('confirm')!.disabled,false);
  assert.equal(f.nodes.get('confirm')!.checked,false);assert.equal(f.nodes.get('send')!.disabled,true);assert.equal(f.counts().sendCalls,0);
});

test('a newly pending wallet check discards a previously confirmed preflight and cannot reuse it after failure',async()=>{
  const f=await fixture();await f.clickCheck();f.confirm();assert.equal(f.nodes.get('send')!.disabled,false);
  let reject!:(error:Error)=>void;f.setWalletCheck(()=>new Promise<void>((_resolve,fail)=>{reject=fail;}));await f.clickCheck();
  assert.equal(f.nodes.get('confirm')!.checked,false);assert.equal(f.nodes.get('confirm')!.disabled,true);assert.equal(f.nodes.get('send')!.disabled,true);assert.equal(f.timers.size,0);
  reject(Error('METAMASK_ACCOUNT_MISMATCH'));await settle();f.nodes.get('send')!.onclick!();await settle();
  assert.equal(f.counts().sendCalls,0);assert.equal(f.nodes.get('confirm')!.disabled,true);assert.equal(f.nodes.get('send')!.disabled,true);
  assert.equal(f.requests.filter(path=>path==='/api/preflight').length,2);assert.equal(f.requests.filter(path=>path==='/api/reserve').length,0);
});

test('preflight expiring or becoming future-dated while wallet checking is pending cannot enable confirmation',async()=>{
  for(const elapsed of [60_000,-1]){
    const f=await fixture();let complete!:()=>void;f.setWalletCheck(()=>new Promise<void>(resolve=>{complete=resolve;}));await f.clickCheck();f.advance(elapsed,false);
    assert.equal(f.nodes.get('confirm')!.disabled,true);complete();await settle();
    assert.equal(f.nodes.get('confirm')!.disabled,true);assert.equal(f.nodes.get('send')!.disabled,true);assert.equal(f.timers.size,0);
    assert.match(f.nodes.get('fees')!.textContent,/重新核对/);assert.match(f.nodes.get('result')!.textContent,/没有请求钱包发送/);
    assert.equal(f.counts().walletCheckCalls,1);assert.equal(f.counts().sendCalls,0);assert.equal(f.requests.filter(path=>path==='/api/reserve').length,0);
  }
});

test('future server timestamp remains rejected after an asynchronous wallet check completes',async()=>{
  const f=await fixture();f.setAge(-1000);let complete!:()=>void;f.setWalletCheck(()=>new Promise<void>(resolve=>{complete=resolve;}));await f.clickCheck();f.advance(999,false);
  complete();await settle();assert.equal(f.nodes.get('confirm')!.disabled,true);assert.equal(f.nodes.get('send')!.disabled,true);assert.equal(f.timers.size,0);
  assert.equal(f.counts().sendCalls,0);assert.equal(f.requests.filter(path=>path==='/api/reserve').length,0);assert.match(f.nodes.get('fees')!.textContent,/重新核对/);
});

test('wallet check latency counts against the original server preflight lifetime rather than restarting it',async()=>{
  const f=await fixture();let complete!:()=>void;f.setWalletCheck(()=>new Promise<void>(resolve=>{complete=resolve;}));await f.clickCheck();f.advance(59_999,false);complete();await settle();
  assert.match(f.nodes.get('fees')!.textContent,/剩余 1 秒/);assert.equal(f.nodes.get('confirm')!.disabled,false);assert.equal(f.nodes.get('send')!.disabled,true);
  f.advance(1);assert.equal(f.nodes.get('confirm')!.disabled,true);assert.equal(f.nodes.get('send')!.disabled,true);assert.equal(f.timers.size,0);
  assert.equal(f.counts().sendCalls,0);assert.equal(f.counts().walletCheckCalls,1);
});

test('preflight countdown remains valid below 60000ms and expires exactly at the boundary',async()=>{
  const f=await fixture();await f.clickCheck();assert.match(f.nodes.get('fees')!.textContent,/剩余 60 秒/);f.confirm();assert.equal(f.nodes.get('send')!.disabled,false);
  f.advance(59_999);assert.match(f.nodes.get('fees')!.textContent,/剩余 1 秒/);assert.equal(f.nodes.get('confirm')!.disabled,false);
  f.advance(1);assert.match(f.nodes.get('fees')!.textContent,/预检已过期.*重新核对/s);assert.equal(f.nodes.get('confirm')!.checked,false);assert.equal(f.nodes.get('confirm')!.disabled,true);assert.equal(f.nodes.get('send')!.disabled,true);assert.equal(f.timers.size,0);assert.equal(f.counts().sendCalls,0);
});

test('send entry rejects an expired preflight when a suspended background timer has not fired',async()=>{
  const f=await fixture();await f.clickCheck();f.confirm();const requestCount=f.requests.length;f.advance(60_000,false);assert.equal(f.nodes.get('send')!.disabled,false);
  f.nodes.get('send')!.onclick!();await settle();assert.equal(f.counts().sendCalls,0);assert.equal(f.requests.length,requestCount);assert.equal(f.nodes.get('confirm')!.checked,false);assert.equal(f.nodes.get('send')!.disabled,true);assert.match(f.nodes.get('result')!.textContent,/没有请求钱包发送/);
});

test('a response already 60000ms old or dated in the future cannot enable wallet confirmation',async()=>{
  for(const age of [60_000,-1]){const f=await fixture();f.setAge(age);await f.clickCheck();assert.equal(f.nodes.get('confirm')!.disabled,true);assert.equal(f.nodes.get('send')!.disabled,true);assert.equal(f.timers.size,0);assert.equal(f.counts().sendCalls,0);assert.match(f.nodes.get('fees')!.textContent,/重新核对/);}
});

test('callbacks queued for an old preflight cannot invalidate a newly reviewed one',async()=>{
  const f=await fixture();await f.clickCheck();f.confirm();const old=f.queued();f.advance(1000,false);await f.clickCheck();const fees=f.nodes.get('fees')!.textContent;f.confirm();
  for(const callback of old)callback();assert.equal(f.nodes.get('fees')!.textContent,fees);assert.equal(f.nodes.get('confirm')!.checked,true);assert.equal(f.nodes.get('send')!.disabled,false);assert.equal(f.counts().sendCalls,0);
});

test('starting a confirmed send clears expiry timers and queued callbacks cannot alter its result',async()=>{
  const f=await fixture();await f.clickCheck();f.confirm();f.advance(59_999,false);const old=f.queued();let resolve!:(value:{attemptId:string;transactionHash:string})=>void;
  f.setSend(()=>new Promise(r=>{resolve=r;}));f.nodes.get('send')!.onclick!();assert.equal(f.counts().sendCalls,1);assert.equal(f.timers.size,0);const result=f.nodes.get('result')!.textContent;
  f.advance(1);for(const callback of old)callback();assert.equal(f.nodes.get('result')!.textContent,result);assert.equal(f.nodes.get('confirm')!.checked,false);
  resolve({attemptId:randomUUID(),transactionHash:hash(20)});await settle();assert.match(f.nodes.get('result')!.textContent,new RegExp(hash(20)));assert.equal(f.counts().sendCalls,1);assert.equal(f.timers.size,0);
});

test('leaving the page cancels preflight timers and queued callbacks without sending',async()=>{
  const f=await fixture();await f.clickCheck();const old=f.queued(),fees=f.nodes.get('fees')!.textContent;f.pagehide();assert.equal(f.timers.size,0);f.advance(60_000);for(const callback of old)callback();assert.equal(f.nodes.get('fees')!.textContent,fees);assert.equal(f.counts().sendCalls,0);assert.equal(f.counts().disposed,1);
});

test('a typed fee-change rejection requires a fresh preflight and a new explicit confirmation without automatic retry',async()=>{
  const f=await fixture();await f.clickCheck();f.confirm();f.setSend(async()=>{throw new MetaMaskPreflightRejected('DEPLOYMENT_PREFLIGHT_CHANGED');});f.nodes.get('send')!.onclick!();await settle();
  assert.match(f.nodes.get('result')!.textContent,/本次未创建发送预留.*重新核对.*再次勾选/s);assert.equal(f.nodes.get('confirm')!.checked,false);assert.equal(f.nodes.get('confirm')!.disabled,true);assert.equal(f.nodes.get('send')!.disabled,true);assert.equal(f.timers.size,0);assert.equal(f.counts().sendCalls,1);assert.equal(f.requests.filter(path=>path==='/api/preflight').length,1);
  await settle();assert.equal(f.counts().sendCalls,1);f.nodes.get('send')!.onclick!();await settle();assert.equal(f.counts().sendCalls,1);
  f.setSend(async()=>({attemptId:randomUUID(),transactionHash:hash(20)}));await f.clickCheck();assert.equal(f.nodes.get('confirm')!.checked,false);assert.equal(f.nodes.get('send')!.disabled,true);assert.equal(f.counts().sendCalls,1);
  f.confirm();f.nodes.get('send')!.onclick!();await settle();assert.equal(f.counts().sendCalls,2);assert.match(f.nodes.get('result')!.textContent,new RegExp(hash(20)));assert.equal(f.requests.filter(path=>path==='/api/preflight').length,2);
});

test('only reserve HTTP409 with complete strict zero-side-effect metadata becomes a typed preflight rejection',async()=>{
  const accepted={code:'DEPLOYMENT_PREFLIGHT_CHANGED',reservationOutcome:'NOT_CREATED_BY_THIS_REQUEST',signaturesRequested:0,transactionsSent:0};
  for(const code of ['DEPLOYMENT_PREFLIGHT_CHANGED','DEPLOYMENT_PREFLIGHT_EXPIRED']){const f=await fixture();f.setResponse('/api/reserve',409,JSON.stringify({...accepted,code}));await assert.rejects(f.apiCall('/api/reserve'),error=>error instanceof MetaMaskPreflightRejected&&error.message===code);assert.equal(f.counts().sendCalls,0);}
  const rejected:unknown[]=[{code:accepted.code},{...accepted,reservationOutcome:'UNKNOWN'},{...accepted,signaturesRequested:1},{...accepted,transactionsSent:1},{...accepted,transactionsSent:'0'},{...accepted,extra:'forbidden'},{...accepted,code:'DEPLOYMENT_ATTEMPT_ALREADY_RESERVED'}];
  for(const value of rejected){const f=await fixture();f.setResponse('/api/reserve',409,JSON.stringify(value));await assert.rejects(f.apiCall('/api/reserve'),error=>!(error instanceof MetaMaskPreflightRejected));assert.equal(f.counts().sendCalls,0);}
  for(const [path,status]of [['/api/reserve',400],['/api/reserve',500],['/api/preflight',409],['/api/record-hash',409]] as const){const f=await fixture();f.setResponse(path,status,JSON.stringify(accepted));await assert.rejects(f.apiCall(path),error=>!(error instanceof MetaMaskPreflightRejected));}
  const duplicate=JSON.stringify(accepted).replace('"transactionsSent":0','"transactionsSent":1,"transactionsSent":0'),escaped=JSON.stringify(accepted).replace('"transactionsSent":0','"transactionsSent":1,"transactions\\u0053ent":0');
  for(const raw of [duplicate,escaped,'{']){const f=await fixture();f.setResponse('/api/reserve',409,raw);await assert.rejects(f.apiCall('/api/reserve'),error=>!(error instanceof MetaMaskPreflightRejected));}
});
