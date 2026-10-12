import type {IncomingMessage,ServerResponse} from 'node:http';
import {resolve,isAbsolute} from 'node:path';
import {existsSync} from 'node:fs';
import {z} from 'zod';
import {WorkflowStore} from '../../../packages/storage/src/workflow-store.js';
import {BackgroundVault} from '../../../packages/storage/src/background-vault.js';
import {EncryptedWorkflowVault} from '../../worker/src/workflow-vault.js';
import {WorkflowWorker} from '../../worker/src/workflow-worker.js';
import {intentpassWorkflowRegistry,type GeneralRuntimeConfiguration} from '../../worker/src/intentpass-workflows.js';
import {GeneralAutomationProfileSchema,generalProfileHash} from '../../../packages/automation/src/general-profile.js';
import {workflowDigest,WorkflowSubmissionSchema} from '../../../packages/automation/src/workflow.js';
import {MemoryPayloadSchema} from '../../../packages/capsule/src/format.js';
import {privateServiceDirectory,readPrivateServiceJson} from '../../../scripts/create-privy-service-wallets.js';
import {ProviderIdSchema} from '../../../packages/protocol/src/day4-origin-types.js';
import {readProcurementCompletion} from '../../worker/src/procurement-completion.js';
import type {BrowserApi} from './browser-api.js';
import {serveAuthenticatedJson} from './auth-json-api.js';
import {LocalTaskContextSchema} from '../../../packages/protocol/src/local-sdk-read.js';
import {GeneralConnectionPlanSchema,GeneralConnectionConsentSchema} from '../../../packages/protocol/src/general-connection.js';
import {address} from '../../../packages/protocol/src/schemas.js';
import {WorkflowSubmitRequestSchema} from '../../../packages/protocol/src/workflow-api.js';
export interface WorkflowApi {auth:BrowserApi['auth'];store:WorkflowStore;vault:EncryptedWorkflowVault;worker:WorkflowWorker;configuration:()=>GeneralRuntimeConfiguration|undefined;taskOwner?:()=>{subject:string;address:string}|undefined;recovery?:(jobId:string)=>unknown;close():Promise<void>;}
export function configuredWorkflowApi(env:NodeJS.ProcessEnv,browser:BrowserApi|undefined):WorkflowApi|undefined{
  if(!env.AUTOMATION_DATA_DIRECTORY||!browser)return undefined;if(!isAbsolute(env.AUTOMATION_DATA_DIRECTORY))throw Error('GENERAL_DIRECTORY_INVALID');
  const directory=resolve(env.AUTOMATION_DATA_DIRECTORY);privateServiceDirectory(directory);
  const raw=new BackgroundVault(resolve(directory,'vault')),vault=new EncryptedWorkflowVault(raw,workflowDigest('IntentPass.GeneralWorkflow.v1')),store=new WorkflowStore(resolve(directory,'queue.db'));
  const configuration=():GeneralRuntimeConfiguration|undefined=>{const path=resolve(directory,'runtime.json');if(!existsSync(path))return undefined;
    const actor=z.object({role:z.enum(['buyer','seller']),walletId:ProviderIdSchema,signerId:ProviderIdSchema,policyId:ProviderIdSchema,subject:z.string().min(1).max(512),authorizationPrivateKey:z.string().min(1).max(8192)}).strict();
    const c=z.object({profile:GeneralAutomationProfileSchema,profileHash:z.string(),actors:z.tuple([actor,actor]),walletDelegationApproved:z.boolean(),localPlaintextProcessingApproved:z.boolean()}).strict().parse(readPrivateServiceJson(path));if(generalProfileHash(c.profile)!==c.profileHash)throw Error('GENERAL_PROFILE_CHANGED');return c;};
  const worker=new WorkflowWorker(store,vault,intentpassWorkflowRegistry({directory,configuration,env}));let closed=false,running:Promise<unknown>|undefined;
  const timer=setInterval(()=>{if(!closed&&!running){running=worker.tick();void running.catch(()=>{}).finally(()=>{running=undefined;});}},1000);timer.unref();
  const recovery=(jobId:string)=>readProcurementCompletion(directory,jobId);
  const taskOwner=()=>{
    const c=configuration(),path=resolve(directory,'connection-consents/buyer.json');if(!c||!existsSync(path))return undefined;
    const consent=GeneralConnectionConsentSchema.extend({subject:z.string().min(1).max(512),address}).strict().parse(readPrivateServiceJson(path)),plan=GeneralConnectionPlanSchema.parse(readPrivateServiceJson(resolve(directory,'connection-plan.json')));
    if(consent.role!=='buyer'||consent.planId!==plan.planId||consent.profileHash!==plan.profileHash||plan.profileHash!==generalProfileHash(c.profile)||consent.address.toLowerCase()!==c.profile.buyer.toLowerCase()||plan.roles[0].address.toLowerCase()!==c.profile.buyer.toLowerCase())throw Error('GENERAL_CONTEXT_OWNER_CHANGED');
    return {subject:consent.subject,address:consent.address};
  };
  return {auth:browser.auth,store,vault,worker,configuration,taskOwner,recovery,close:async()=>{closed=true;clearInterval(timer);await running?.catch(()=>{});store.close();raw.dispose();}};
}
export function serveWorkflow(req:IncomingMessage,res:ServerResponse,api:WorkflowApi){return serveAuthenticatedJson(req,res,{auth:api.auth,failureCode:'WORKFLOW_SERVICE_UNAVAILABLE',invoke:async(input,principal)=>{
  const request=z.object({action:z.enum(['list','submit','output','cancel','context']),jobId:z.string().optional(),submission:z.unknown().optional(),confirm:z.boolean().optional()}).strict().parse(input),owner=principal.subject;
  if(request.action==='context'){
    const config=api.configuration(),originalOwner=api.taskOwner?.();if(!config?.profile.enabled||originalOwner?.subject!==owner||!principal.wallets.some(w=>w.toLowerCase()===config.profile.buyer.toLowerCase()))return {status:'REJECT',code:'WORKFLOW_BUYER_CONTEXT_UNAVAILABLE'};
    const p=config.profile;return LocalTaskContextSchema.parse({status:'CONFIGURED_CONTEXT',chainId:p.deployment.chainId,buyer:p.buyer,seller:p.seller,asset:p.deployment.asset,arbiter:p.deployment.arbiter,configurationOnly:true});
  }
  if(request.action==='list')return {mode:'general',workerRunning:true,limits:{jobCount:null,amountPerOrder:api.configuration()?.profile.maxUnitsPerOrder??null,expiresAt:api.configuration()?.profile.expiresAt??null},financialConfigurationPresent:api.configuration()?.profile.enabled===true,jobs:api.store.listOwned(owner).map(j=>{const recovery=api.recovery?.(j.id);return {id:j.id,workflow:j.workflow.name,status:recovery?'SUCCEEDED':j.status,step:recovery?j.workflow.steps.length:j.cursor,stepCount:j.workflow.steps.length,cancelRequested:j.cancelRequested};})};
  if(request.action==='submit'){
    const parsed=WorkflowSubmitRequestSchema.safeParse({submission:request.submission,confirm:request.confirm});if(!parsed.success)return {status:'REJECT',code:'WORKFLOW_SUBMISSION_OR_CONFIRMATION_INVALID'};
    const submission=parsed.data.submission;if(submission.workflow.steps.some(s=>s.handler==='intentpass.procurement')){const data=submission.input as {memory?:unknown},memory=MemoryPayloadSchema.parse(data?.memory??submission.input),configuration=api.configuration();if(!configuration||api.taskOwner?.()?.subject!==owner||!memory.taskInput||!principal.wallets.some(w=>w.toLowerCase()===memory.taskInput!.buyer.toLowerCase())||memory.taskInput.buyer.toLowerCase()!==configuration.profile.buyer.toLowerCase())return {status:'REJECT',code:'WORKFLOW_BUYER_MISMATCH'};
      // Same task/version/profile is one purchase across tabs, SDK clients and lost responses.
      // Conflicting content retains the original job and fails instead of buying again.
      submission.idempotencyKey=workflowDigest({operation:'IntentPass.ApprovedTaskProcurement.v1',profileHash:generalProfileHash(configuration.profile),taskId:memory.policy.taskId.toLowerCase(),policyVersion:memory.policy.version});
    }
    try{const job=await api.worker.submit(submission,owner);return {id:job.id,status:api.recovery?.(job.id)?'SUCCEEDED':job.status};}
    catch(error){if(error instanceof Error&&error.message==='WORKFLOW_IDEMPOTENCY_CONFLICT')return {status:'REJECT',code:'WORKFLOW_IDEMPOTENCY_CONFLICT'};throw error;}
  }
  const job=api.store.owned(owner,z.string().min(1).max(128).parse(request.jobId));
  if(request.action==='cancel'){if(request.confirm!==true)return {status:'REJECT',code:'WORKFLOW_CONFIRMATION_REQUIRED'};api.store.cancel(job.id,Date.now());return {id:job.id,status:api.store.get(job.id)!.status};}
  const outputs:Record<string,unknown>=Object.create(null);for(let i=0;i<job.cursor;i++){const step=api.store.step(job.id,i);if(step.resultRef)outputs[job.workflow.steps[i].id]=await api.vault.open(step.resultRef);}
  const recovery=api.recovery?.(job.id);if(recovery)outputs.procurement=recovery;return {id:job.id,status:recovery?'SUCCEEDED':job.status,outputs};
}});}
