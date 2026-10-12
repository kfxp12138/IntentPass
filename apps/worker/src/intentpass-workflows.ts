import {z} from 'zod';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {WorkflowRegistry,type WorkflowResult} from './workflow-worker.js';
import {createReport} from '../../../packages/protocol/src/report.js';
import {MemoryPayloadSchema} from '../../../packages/capsule/src/format.js';
import {GeneralAutomationProfileSchema} from '../../../packages/automation/src/general-profile.js';
import {generalJobScope,executionScopeHash} from '../../../packages/automation/src/background-scope.js';
import {executeProcurement} from './procurement-runtime.js';
import {createBackgroundActor,type BackgroundActorConfig} from '../../../packages/adapters/src/privy-background-actor.js';
import {createPrivyClient} from '../../../packages/adapters/src/privy-auth.js';
import {BackgroundVault} from '../../../packages/storage/src/background-vault.js';
import {privateServiceDirectory} from '../../../scripts/create-privy-service-wallets.js';
import {JsonValueSchema,type JsonValue} from '../../../packages/automation/src/workflow.js';
import type {GeneralAutomationProfile} from '../../../packages/automation/src/general-profile.js';
import {reconcileProcurement} from './procurement-reconciliation.js';
import {CatalogResponseSchema} from '../../../packages/protocol/src/purchase-api.js';
export interface GeneralRuntimeConfiguration {profile:GeneralAutomationProfile;actors:readonly [BackgroundActorConfig,BackgroundActorConfig];walletDelegationApproved:boolean;localPlaintextProcessingApproved:boolean;}
export function intentpassWorkflowRegistry(options?:{directory:string;configuration:()=>GeneralRuntimeConfiguration|undefined;env?:NodeJS.ProcessEnv;clock?:()=>number}){
  const registry=new WorkflowRegistry(),clock=options?.clock??Date.now;
  registry.register('intentpass.report',{effect:'READ',execute:async context=>{
    const {dataset}=z.object({dataset:z.array(z.number().int().refine(Number.isSafeInteger)).min(1).max(10000)}).passthrough().parse(context.input);
    return {status:'COMPLETE',output:JsonValueSchema.parse(createReport(dataset))};
  }});
  registry.register('intentpass.digest',{effect:'READ',execute:async context=>({status:'COMPLETE',output:{sha256:createHash('sha256').update(JSON.stringify(context.outputs)).digest('hex')}})});
  registry.register('intentpass.procurement',{effect:'WRITE',execute:async context=>{
    if(!options)throw Error('GENERAL_RUNTIME_CONFIGURATION_REQUIRED');
    const configuration=options.configuration();
    if(!configuration?.profile.enabled||configuration.walletDelegationApproved!==true||configuration.localPlaintextProcessingApproved!==true)return {status:'WAITING',nextAt:clock()+15000};
    const request=z.union([MemoryPayloadSchema,z.object({memory:MemoryPayloadSchema,catalogue:CatalogResponseSchema}).strict()]).parse(context.input),memory='memory'in request?request.memory:request,catalogue='memory'in request?request.catalogue:undefined;
    const profile=GeneralAutomationProfileSchema.parse(configuration.profile),scope=generalJobScope(profile,memory,BigInt(Math.floor(clock()/1000)));
    const env=options.env??process.env;if(!env.PRIVY_APP_ID||!env.PRIVY_APP_SECRET)return {status:'WAITING',nextAt:clock()+15000};
    const client=createPrivyClient({appId:env.PRIVY_APP_ID,appSecret:env.PRIVY_APP_SECRET});
    try{for(const config of configuration.actors){const port=createBackgroundActor(client,scope,config,()=>undefined,async()=>{throw Error('GENERAL_UNUSED_TOKEN');});try{await port.initialize();}finally{await port.logout();}}}catch{return {status:'WAITING',nextAt:clock()+15000};}
    context.assertActive();const jobs=resolve(options.directory,'procurements');privateServiceDirectory(jobs);const directory=resolve(jobs,context.jobId);privateServiceDirectory(directory);
    const result=await context.dispatch(async()=>JsonValueSchema.parse(await executeProcurement(scope,memory,configuration.actors,directory,{scopeHash:executionScopeHash(scope),walletDelegationApproved:true,localPlaintextProcessingApproved:true},env,undefined,context.assertActive,catalogue)));
    if((result as {status?:string}).status==='CONFIRMED')return {status:'COMPLETE',output:result};
    return ['REVIEW_STOPPED','CHAIN_BLOCKED','RECEIPT_EXPIRED'].includes(String((result as {reason?:string}).reason))?{status:'FAILED'}:{status:'UNKNOWN',nextAt:clock()+15000};
  },reconcile:async(context,dispatch):Promise<WorkflowResult>=>{
    // A recorded positive response already contains the original validated payout.
    if(dispatch&&typeof dispatch==='object'&&!Array.isArray(dispatch)&&(dispatch as {status?:string}).status==='CONFIRMED')return {status:'COMPLETE',output:dispatch};
    if(!options)return {status:'UNKNOWN',nextAt:clock()+15000};
    return reconcileProcurement(resolve(options.directory,'procurements',context.jobId),options.env??process.env,clock);
  }});
  return registry;
}
