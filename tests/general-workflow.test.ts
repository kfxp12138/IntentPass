import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {WorkflowStore} from '../packages/storage/src/workflow-store.js';
import {WorkflowRegistry,WorkflowWorker,type WorkflowVault,type WorkflowContext} from '../apps/worker/src/workflow-worker.js';
import {WorkflowSchema,workflowDigest,type JsonValue} from '../packages/automation/src/workflow.js';
import {BackgroundVault} from '../packages/storage/src/background-vault.js';
import {EncryptedWorkflowVault} from '../apps/worker/src/workflow-vault.js';
import {intentpassWorkflowRegistry} from '../apps/worker/src/intentpass-workflows.js';
import {GeneralAutomationProfileSchema} from '../packages/automation/src/general-profile.js';
import {generalJobScope,assertBackgroundTask,executionScopeHash} from '../packages/automation/src/background-scope.js';
import {backgroundActorPolicy} from '../packages/adapters/src/privy-background-policy.js';
import {originalAuthorizationFixture,readTestHash} from './support/original-authorization.js';
import {createReport} from '../packages/protocol/src/report.js';

function fixture(registry=new WorkflowRegistry()){
  const root=mkdtempSync(resolve(realpathSync(tmpdir()),'intentpass-workflows-')),path=resolve(root,'queue.db'),store=new WorkflowStore(path),raw=new BackgroundVault(resolve(root,'vault')),vault=new EncryptedWorkflowVault(raw,workflowDigest('test-runtime'));
  let now=1000;const worker=new WorkflowWorker(store,vault,registry,()=>now,1000);
  return {root,path,store,vault,raw,registry,worker,clock:()=>now,setTime:(t:number)=>{now=t;},close:()=>{store.close();raw.dispose();rmSync(root,{recursive:true,force:true});}};
}
function submit(key:string,handler:string,effect:'READ'|'WRITE'='READ',input:JsonValue={secret:'LOCAL_PRIVATE_INPUT'}){return {idempotencyKey:key,workflow:{name:'general-example',version:'1',steps:[{id:'first',handler,effect,retryDelayMs:100,maxAttempts:3}]},input,runAt:0};}
test('arbitrary workflows and datasets enqueue repeatedly, preserve exact requests and keep input/output out of SQLite',async()=>{
  const f=fixture(intentpassWorkflowRegistry());try{
    const definition={name:'自动报告与摘要',version:'1',steps:[{id:'report',handler:'intentpass.report',effect:'READ'},{id:'digest',handler:'intentpass.digest',effect:'READ'}]};
    for(let i=0;i<3;i++){const request={idempotencyKey:`different-${i}`,workflow:definition,input:{dataset:[i,i+2,i+7],secret:'LOCAL_PRIVATE_INPUT'},runAt:0},job=await f.worker.submit(request);assert.equal((await f.worker.submit(request)).id,job.id);
      assert.equal((await f.worker.tick())!.status,'QUEUED');assert.equal((await f.worker.tick())!.status,'SUCCEEDED');
      const record=f.store.step(job.id,0),result=await f.vault.open(record.resultRef!) as {sum:string};assert.equal(result.sum,String(3*i+9));
      await assert.rejects(f.worker.submit({...request,input:{dataset:[999]}}),/IDEMPOTENCY_CONFLICT/);
    }
    assert.equal(f.store.list().length,3);
    for(const name of readdirSync(f.root).filter(name=>name.startsWith('queue.db')))assert.equal(readFileSync(resolve(f.root,name)).includes(Buffer.from('LOCAL_PRIVATE_INPUT')),false);
  }finally{f.close();}
});
test('read failures retry with backoff, scheduled tasks wait, and unknown handlers or versions cannot execute',async()=>{
  const f=fixture();let calls=0;f.registry.register('flaky',{effect:'READ',execute:async()=>{if(++calls===1)throw Error('private provider error');return {status:'COMPLETE',output:{value:42}};}});
  try{
    await assert.rejects(f.worker.submit(submit('missing','not-registered')),/HANDLER_UNAVAILABLE/);
    const request=submit('flaky','flaky'),job=await f.worker.submit({...request,runAt:2000});assert.equal(await f.worker.tick(),null);f.setTime(2000);assert.equal((await f.worker.tick())!.status,'WAITING');assert.equal(await f.worker.tick(),null);f.setTime(2100);assert.equal((await f.worker.tick())!.status,'SUCCEEDED');assert.equal(calls,2);
    await assert.rejects(f.worker.submit({...submit('changed','flaky'),workflow:{name:'versioned',version:'1',steps:[{id:'first',handler:'flaky',handlerVersion:'2',effect:'READ'}]}}),/VERSION_MISMATCH/);
    assert.equal(f.store.get(job.id)!.cursor,1);
  }finally{f.close();}
});
test('two workers cannot claim the same live job and an expired read lease fences old work after restart',async()=>{
  const f=fixture();f.registry.register('read',{effect:'READ',execute:async()=>({status:'COMPLETE',output:'ok'})});const other=new WorkflowStore(f.path);
  try{
    const job=await f.worker.submit(submit('lease','read')),old=f.store.claim(1000,1000)!;assert.equal(other.claim(1000,1000),undefined);
    const fresh=other.claim(2000,1000)!;assert.equal(fresh.id,job.id);assert.notEqual(fresh.lease,old.lease);assert.throws(()=>f.store.markDispatch(old,2000),/LEASE_LOST/);
  }finally{other.close();f.close();}
});
test('dispatched writes survive crashes and only original reconciliation can complete; no second send',async()=>{
  const f=fixture();let sends=0,reconciles=0;f.registry.register('money',{effect:'WRITE',execute:async c=>{await c.dispatch(async key=>{sends++;return {hash:'LOCAL_TRANSACTION',key};});throw Error('lost response');},reconcile:async(_c,original)=>{reconciles++;return original?{status:'COMPLETE',output:original}:{status:'UNKNOWN',nextAt:f.clock()+100};}});
  try{
    const job=await f.worker.submit(submit('write','money','WRITE'));assert.equal((await f.worker.tick())!.status,'RECONCILING');assert.equal(sends,1);f.setTime(1100);const restarted=new WorkflowWorker(f.store,f.vault,f.registry,f.clock,1000);
    assert.equal((await restarted.tick())!.status,'SUCCEEDED');assert.equal(sends,1);assert.equal(reconciles,1);assert.equal(f.store.step(job.id,0).dispatched,true);
  }finally{f.close();}
});
test('unknown effects cannot resend even after lease expiration; other jobs continue while reconciliation waits',async()=>{
  const f=fixture();let sends=0;f.registry.register('unknown',{effect:'WRITE',execute:async c=>{await c.dispatch(async()=>{sends++;throw Error('send timed out');});return {status:'FAILED'};},reconcile:async c=>{await assert.rejects(c.dispatch(async()=>{sends++;return 'duplicate';}),/ORIGINAL_DISPATCH_LOCKED/);return {status:'UNKNOWN',nextAt:f.clock()+1000};}});
  f.registry.register('normal',{effect:'READ',execute:async()=>({status:'COMPLETE',output:'next job'})});
  try{await f.worker.submit(submit('unknown','unknown','WRITE'));await f.worker.tick();const next=await f.worker.submit(submit('next','normal'));assert.equal((await f.worker.tick())!.id,next.id);f.setTime(1100);assert.equal((await f.worker.tick())!.status,'RECONCILING');assert.equal(sends,1);}finally{f.close();}
});
test('cancellation after dispatch records late original results and reconciles without running later steps',async()=>{
  const f=fixture();let started!:()=>void,finish!:(v:JsonValue)=>void,later=0;const reached=new Promise<void>(r=>{started=r;}),waiting=new Promise<JsonValue>(r=>{finish=r;});
  f.registry.register('pending',{effect:'WRITE',execute:async c=>({status:'COMPLETE',output:await c.dispatch(async()=>{started();return waiting;})}),reconcile:async(_c,original)=>original?{status:'COMPLETE',output:original}:{status:'UNKNOWN',nextAt:f.clock()+100}});
  f.registry.register('later',{effect:'READ',execute:async()=>{later++;return {status:'COMPLETE',output:'unexpected'};}});
  try{
    const job=await f.worker.submit({idempotencyKey:'cancel',workflow:{name:'cancel-case',version:'1',steps:[{id:'send',handler:'pending',effect:'WRITE',retryDelayMs:100},{id:'later',handler:'later',effect:'READ'}]},input:{},runAt:0}),running=f.worker.tick();await reached;f.store.cancel(job.id,f.clock());finish({hash:'ORIGINAL_HASH'});await running;
    assert.equal(f.store.get(job.id)!.status,'RECONCILING');assert.ok(f.store.step(job.id,0).dispatchRef);assert.equal((await f.worker.tick())!.status,'CANCELLED');assert.equal(later,0);
  }finally{f.close();}
});
test('general IntentPass profile has no demo amount or lifetime cap, chooses quotes per job and derives isolated order contexts',async()=>{
  const f=await originalAuthorizationFixture('10143',{singleReportBackground:true});
  const profile=GeneralAutomationProfileSchema.parse({version:1,mode:'general',enabled:true,name:'长期自动化',deployment:f.deployment,buyer:f.buyer.address,seller:f.seller.address,deliverySeconds:'172800',settlementSeconds:'259200'});
  assert.equal(profile.maxUnitsPerOrder,null);assert.equal(profile.expiresAt,null);
  const memories=[[1,2,3],[8,13,21]].map((dataset,i)=>({schemaVersion:1,kind:'memory',policy:{...f.payload.policy,taskId:readTestHash(20+i),datasetHash:createReport(dataset).datasetHash,budget:'500'},evidence:f.payload.evidence,taskInput:{dataset,buyer:f.buyer.address,seller:f.seller.address}}));
  const scopes=memories.map(m=>generalJobScope(profile,m,1000n));assert.notEqual(executionScopeHash(scopes[0]),executionScopeHash(scopes[1]));
  for(let i=0;i<2;i++){assert.equal(scopes[i].quoteId,null);assert.equal(scopes[i].maxTotalUnits,'500');assertBackgroundTask(scopes[i],memories[i],1000n);const rules=backgroundActorPolicy(scopes[i],'buyer').rules;
    assert.equal(rules.some(r=>r.conditions.some(c=>(c as {field_source?:string}).field_source==='system')),false);
    assert.equal(rules.some(r=>r.conditions.some(c=>['amount','approve.amount','deadline'].includes((c as {field?:string}).field??''))),false);
  }
  assert.throws(()=>generalJobScope({...profile,maxUnitsPerOrder:'100'},memories[0],1000n));
  assert.throws(()=>generalJobScope({...profile,expiresAt:'260199'},memories[0],1000n),/EXPIRES_BEFORE_SETTLEMENT/);
  assert.equal(generalJobScope({...profile,expiresAt:'260200'},memories[0],1000n).expiresAt,'260200');
});
