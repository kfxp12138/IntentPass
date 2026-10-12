import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createApp} from '../apps/web/src/server.js';
import {configuredWorkflowApi} from '../apps/web/src/workflow-api.js';
import {configuredLocalSdkApi} from '../apps/web/src/local-sdk-api.js';
import {PurchaseClient} from '../packages/protocol/src/purchase-client.js';
import {GeneralAutomationProfileSchema} from '../packages/automation/src/general-profile.js';
import {AuthenticationRejected} from '../packages/adapters/src/privy-auth.js';
import {originalAuthorizationFixture} from './support/original-authorization.js';
import {runExample} from '../examples/client/client.js';

// Real HTTP, child CLI, SQLite queue and computation. Identity and chain are explicit local doubles.
async function fixture(procurementEnabled=false){
  const f=await originalAuthorizationFixture('10143',{singleReportBackground:true});
  const directory=mkdtempSync(resolve(realpathSync(tmpdir()),'intentpass-sdk-queue-'));
  const auth={authenticate:async(token:string)=>{if(!['owner','other'].includes(token))throw new AuthenticationRejected();return {subject:token,wallets:[f.buyer.address]};}};
  const browser={auth,configuration:{privyAppId:'local-double',meraRpId:null,recoveryDeployment:null}},api=configuredWorkflowApi({AUTOMATION_DATA_DIRECTORY:directory},browser)!;
  const paid={...f.snapshot('ALLOCATED_PAID'),credits:{buyer:'0',payee:'0'},withdrawn:{buyer:'0',payee:'10'},accounting:{locked:'0',outstanding:'0',balance:'0'}};
  const app=await createApp({dependencyPrebundling:false,browserApi:browser,workflowApi:api,localSdkApi:configuredLocalSdkApi({INTENTPASS_LOCAL_SDK_READ_ENABLED:'1',...(procurementEnabled?{INTENTPASS_LOCAL_SDK_PROCUREMENT_ENABLED:'1'}:{})},browser),orderApi:{auth,read:async()=>paid}});
  await new Promise<void>(r=>app.server.listen(0,'127.0.0.1',r));const address=app.server.address();assert.ok(address&&typeof address==='object');const url=`http://127.0.0.1:${address.port}`;
  const call=(body:unknown,token='owner')=>fetch(url+'/api/automation/workflows',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const cli=(args:string[],input:unknown)=>new Promise<{code:number|null;value:any;error:string}>((done,reject)=>{const child=spawn(process.execPath,['--import','tsx','examples/client/index.ts',...args],{env:{PATH:process.env.PATH,INTENTPASS_URL:url,INTENTPASS_TOKEN:'owner'},stdio:['pipe','pipe','pipe']});let out='',error='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>error+=c);child.on('error',reject);child.on('close',code=>done({code,value:out?JSON.parse(out):undefined,error}));child.stdin.end(JSON.stringify(input));});
  return {f,api,paid,app,url,call,cli,client:new PurchaseClient(url,async()=>'owner'),close:async()=>{await app.close();await api.close();rmSync(directory,{recursive:true,force:true});}};
}
const report={idempotencyKey:'one-report',workflow:{name:'SDK 本机报告',version:'1',steps:[{id:'report',handler:'intentpass.report',effect:'READ'}]},input:{dataset:[2,4,6]},runAt:0};
test('independent CLI submits, computes, lists and reads a durable report; a lost response retry returns the same job',async()=>{
  const x=await fixture();try{
    const first=await x.cli(['workflow-submit','--confirm'],{submission:report,confirm:true});assert.equal(first.code,0);
    const retry=await x.cli(['workflow-submit','--confirm'],{submission:report,confirm:true});assert.equal(retry.value.id,first.value.id);
    await x.api.worker.tick();
    const listed=await x.cli(['workflows'],{});assert.equal(listed.value.jobs.length,1);assert.equal(listed.value.jobs[0].status,'SUCCEEDED');
    const summary=await x.cli(['workflow-output'],{jobId:first.value.id});assert.equal(summary.code,0);assert.deepEqual(summary.value.completedSteps,['report']);assert.equal('outputs'in summary.value,false);
    const output=await x.cli(['workflow-output','--print-payload'],{jobId:first.value.id});assert.equal(output.value.outputs.report.sum,'12');
    const other=new PurchaseClient(x.url,async()=>'other');await assert.rejects(other.workflowOutput(first.value.id));
    await assert.rejects(x.client.submitWorkflow({submission:{...report,input:{dataset:[9]}},confirm:true}));assert.equal(x.api.store.list().length,1);
  }finally{await x.close();}
});
test('CLI confirmation gates run before reading input; explicit cancellation never reports a pending job paid',async()=>{
  for(const args of [['workflow-submit'],['workflow-cancel'],['workflow-submit','--local-session-input','--confirm']])assert.equal(await runExample(args,{}, {input:async()=>assert.fail('must not read'),out:()=>assert.fail(),error:()=>{}}),1);
  const x=await fixture();try{
    const job=await x.client.submitWorkflow({submission:{...report,runAt:Date.now()+600000}});
    await assert.rejects(x.client.cancelWorkflow(job.id,false));
    const cancelled=await x.cli(['workflow-cancel','--confirm'],{jobId:job.id,confirm:true});assert.equal(cancelled.code,0);assert.equal(cancelled.value.status,'CANCELLED');
    const checked=await x.cli(['check-workflow'],{jobId:job.id,orderId:x.f.payload.intent.orderId});assert.equal(checked.code,1);assert.equal(checked.value,undefined);
  }finally{await x.close();}
});
test('procurement requires original owner and confirmation, and changing caller keys cannot purchase the same task twice',async()=>{
  const x=await fixture();try{
    const profile=GeneralAutomationProfileSchema.parse({version:1,mode:'general',enabled:true,name:'Local double',buyer:x.f.buyer.address,seller:x.f.seller.address,deployment:x.f.deployment});
    x.api.configuration=()=>({profile,actors:[] as any,walletDelegationApproved:false,localPlaintextProcessingApproved:false});x.api.taskOwner=()=>({subject:'owner',address:x.f.buyer.address});
    const submission={...report,workflow:{name:'原报告后台采购与结算',version:'1',steps:[{id:'procurement',handler:'intentpass.procurement',effect:'WRITE',retryDelayMs:15000}]},input:{schemaVersion:1,kind:'memory',policy:{...x.f.payload.policy,taskId:'0x'+'ab'.repeat(32)},evidence:x.f.payload.evidence,taskInput:{dataset:x.f.dataset,buyer:x.f.buyer.address,seller:x.f.seller.address}},runAt:Date.now()+600000};
    assert.equal((await(await x.call({action:'submit',submission})).json()).status,'REJECT');
    assert.equal((await(await x.call({action:'submit',submission,confirm:true},'other')).json()).status,'REJECT');
    assert.equal(x.api.store.list().length,0);
    const a=await x.client.submitWorkflow({submission,confirm:true}),b=await x.client.submitWorkflow({submission:{...submission,idempotencyKey:'new-key'},confirm:true});assert.equal(a.id,b.id);assert.equal(x.api.store.list().length,1);
    await assert.rejects(x.client.submitWorkflow({submission:{...submission,input:{...submission.input,evidence:{...submission.input.evidence,taskText:'changed'}}},confirm:true}));assert.equal(x.api.store.list().length,1);
    await assert.rejects(x.client.submitWorkflow({submission:{...submission,input:{...submission.input,policy:{...submission.input.policy,taskId:'0x'+submission.input.policy.taskId.slice(2).toUpperCase()}}},confirm:true}));assert.equal(x.api.store.list().length,1);
  }finally{await x.close();}
});
test('independent child binds owned completed workflow to expected paid chain order and rejects another owner or order',async()=>{
  const x=await fixture();try{
    const job=await x.client.submitWorkflow({submission:{...report,runAt:Date.now()+600000}});x.api.recovery=id=>id===job.id?{status:'CONFIRMED',orderId:x.f.payload.intent.orderId,payoutHash:'0x'+'ab'.repeat(32)}:undefined;
    const request={jobId:job.id,orderId:x.f.payload.intent.orderId};
    const call=(body:unknown,token='owner')=>fetch(x.url+'/api/local/sdk-workflow-read',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
    const response=await call(request);assert.equal(response.status,200);const value=await response.json();assert.equal(value.status,'AUTHENTICATED_WORKFLOW_ORDER_READ');assert.equal(value.order.withdrawn.payee,'10');assert.equal(value.transactionsSent,0);assert.equal('outputs'in value,false);
    assert.equal((await call(request,'other')).status,503);assert.equal((await call({...request,orderId:'0x'+'ff'.repeat(32)})).status,503);
    x.paid.withdrawn.payee='0';assert.equal((await call(request)).status,503);
  }finally{await x.close();}
});
test('SDK rejects substituted workflow IDs and unknown states and responses cannot trigger retries',async()=>{
  let requests=0;const client=new PurchaseClient('http://127.0.0.1',async()=>'local-double',async()=>{requests++;return new Response(JSON.stringify({id:'wrong',status:'SUCCEEDED',outputs:{}}));});
  await assert.rejects(client.workflowOutput('original'),/WORKFLOW_RESPONSE_MISMATCH/);assert.equal(requests,1);
  const bad=new PurchaseClient('http://127.0.0.1',async()=>'local-double',async()=>new Response(JSON.stringify({id:'original',status:'MADE_UP',outputs:{}})));await assert.rejects(bad.workflowOutput('original'));
});

test('opt-in procurement bridge runs an independent authenticated CLI and reserves only one original task across retries',async()=>{
  const x=await fixture(true);try{
    const profile=GeneralAutomationProfileSchema.parse({version:1,mode:'general',enabled:true,name:'Local double',buyer:x.f.buyer.address,seller:x.f.seller.address,deployment:x.f.deployment});
    x.api.configuration=()=>({profile,actors:[] as any,walletDelegationApproved:false,localPlaintextProcessingApproved:false});x.api.taskOwner=()=>({subject:'owner',address:x.f.buyer.address});
    const memory={schemaVersion:1,kind:'memory',policy:x.f.payload.policy,evidence:x.f.payload.evidence,taskInput:{dataset:x.f.dataset,buyer:x.f.buyer.address,seller:x.f.seller.address}};
    const call=(body:unknown,token='owner')=>fetch(x.url+'/api/local/sdk-procurement',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Host:'untrusted.invalid'},body:JSON.stringify(body)});
    assert.equal((await call({memory,confirm:true},'invalid')).status,401);
    assert.equal((await(await call({memory,confirm:false})).json()).status,'REJECT');
    assert.equal((await(await call({memory,confirm:true,command:'anything'})).json()).status,'REJECT');
    assert.equal((await call({memory,confirm:true},'other')).status,503);assert.equal(x.api.store.list().length,0);
    const first=await call({memory,confirm:true});assert.equal(first.status,200);const a=await first.json();
    assert.equal(a.status,'WORKFLOW_SUBMISSION_RECORDED');assert.equal(a.paymentVerified,false);assert.equal(a.taskId,memory.policy.taskId);assert.equal(JSON.stringify(a).includes(memory.evidence.taskText),false);
    const b=await(await call({memory,confirm:true})).json();assert.equal(b.jobId,a.jobId);assert.equal(x.api.store.list().length,1);
    assert.equal((await call({memory:{...memory,evidence:{...memory.evidence,taskText:'changed'}},confirm:true})).status,503);assert.equal(x.api.store.list().length,1);
  }finally{await x.close();}
});
test('read-only configuration never enables procurement and CLI cannot mix session flags or omit confirmation',async()=>{
  const x=await fixture();try{
    const r=await fetch(x.url+'/api/local/sdk-procurement',{method:'POST',headers:{Authorization:'Bearer owner','Content-Type':'application/json'},body:'{}'});assert.equal((await r.json()).code,'LOCAL_SDK_PROCUREMENT_DISABLED');assert.equal(x.api.store.list().length,0);
  }finally{await x.close();}
  for(const args of [['procure'],['procure','--local-procurement-input'],['submit','--local-procurement-input','--confirm'],['procure','--local-session-input','--confirm'],['procure','--local-procurement-input','--confirm','--print-payload']])assert.equal(await runExample(args,{}, {input:async()=>assert.fail('must not read'),out:()=>assert.fail(),error:()=>{}}),1);
});
