import {resolve} from 'node:path';
import {readFileSync,existsSync} from 'node:fs';
import {z} from 'zod';
import {WorkflowStore} from '../packages/storage/src/workflow-store.js';
import {BackgroundVault} from '../packages/storage/src/background-vault.js';
import {EncryptedWorkflowVault} from '../apps/worker/src/workflow-vault.js';
import {WorkflowWorker} from '../apps/worker/src/workflow-worker.js';
import {intentpassWorkflowRegistry,type GeneralRuntimeConfiguration} from '../apps/worker/src/intentpass-workflows.js';
import {workflowDigest} from '../packages/automation/src/workflow.js';
import {GeneralAutomationProfileSchema,generalProfileHash} from '../packages/automation/src/general-profile.js';
import {privateServiceDirectory,readPrivateServiceJson} from './create-privy-service-wallets.js';
import {ProviderIdSchema} from '../packages/protocol/src/day4-origin-types.js';
const directory=resolve('.tools/general-automation');privateServiceDirectory(directory);
const rawVault=new BackgroundVault(resolve(directory,'vault')),vault=new EncryptedWorkflowVault(rawVault,workflowDigest('IntentPass.GeneralWorkflow.v1')),store=new WorkflowStore(resolve(directory,'queue.db'));
const config=():GeneralRuntimeConfiguration|undefined=>{
  const path=resolve(directory,'runtime.json');if(!existsSync(path))return undefined;
  const actor=z.object({role:z.enum(['buyer','seller']),walletId:ProviderIdSchema,signerId:ProviderIdSchema,policyId:ProviderIdSchema,subject:z.string().min(1).max(512),authorizationPrivateKey:z.string().min(1).max(8192)}).strict();
  const c=z.object({profile:GeneralAutomationProfileSchema,profileHash:z.string(),actors:z.tuple([actor,actor]),walletDelegationApproved:z.boolean(),localPlaintextProcessingApproved:z.boolean()}).strict().parse(readPrivateServiceJson(path));
  if(generalProfileHash(c.profile)!==c.profileHash)throw Error('GENERAL_PROFILE_CHANGED');return c;
};
const worker=new WorkflowWorker(store,vault,intentpassWorkflowRegistry({directory,configuration:config}));
try{
  const command=process.argv[2];
  if(command==='enqueue'&&process.argv.length===4){const input=JSON.parse(readFileSync(resolve(process.argv[3]),'utf8'));const job=await worker.submit(input);console.log(JSON.stringify({id:job.id,status:job.status,workflow:job.workflow.name,stepCount:job.workflow.steps.length}));}
  else if(command==='list')console.log(JSON.stringify(store.list().map(j=>({id:j.id,status:j.status,workflow:j.workflow.name,step:j.cursor,stepCount:j.workflow.steps.length,runAt:j.runAt}))));
  else if(command==='tick')console.log(JSON.stringify(await worker.tick()));
  else if(command==='cancel'&&process.argv.length===4){store.cancel(process.argv[3],Date.now());console.log(JSON.stringify({id:process.argv[3],status:store.get(process.argv[3])!.status}));}
  else if(command==='output'&&process.argv.length===4){const job=store.get(process.argv[3]);if(!job)throw Error('WORKFLOW_JOB_MISSING');const outputs:Record<string,unknown>={};for(let i=0;i<job.cursor;i++){const s=store.step(job.id,i);if(s.resultRef)outputs[job.workflow.steps[i].id]=await vault.open(s.resultRef);}console.log(JSON.stringify(outputs));}
  else if(command==='serve'){
    let running=true;for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{running=false;});
    console.log(JSON.stringify({status:'RUNNING',mode:'general',hardCodedJobLimit:null,hardCodedAmountLimit:null,hardCodedLifetime:null}));
    while(running){const job=await worker.tick();if(job)console.log(JSON.stringify({id:job.id,status:job.status,step:job.cursor}));else await new Promise(r=>setTimeout(r,1000));}
  }else throw Error('WORKFLOW_COMMAND_INVALID');
}catch(error){const code=error instanceof Error&&/^(?:WORKFLOW|GENERAL)_[A-Z_]+$/.test(error.message)?error.message:'WORKFLOW_OPERATION_UNAVAILABLE';console.error(JSON.stringify({status:'ATTENTION',code}));process.exitCode=1;}
finally{store.close();rawVault.dispose();}
