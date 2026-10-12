import {resolve,basename} from 'node:path';
import {z} from 'zod';
import {createHash} from 'node:crypto';
import {ExecutionScopeSchema,executionScopeHash,type ExecutionScope} from '../../../packages/automation/src/background-scope.js';
import {BackgroundVault} from '../../../packages/storage/src/background-vault.js';
import {BackgroundProcurement} from './background-procurement.js';
import {createBackgroundSessions} from './background-sessions.js';
import {MemoryPayloadSchema} from '../../../packages/capsule/src/format.js';
import {createPrivyClient} from '../../../packages/adapters/src/privy-auth.js';
import {configuredBrowserApi} from '../../web/src/browser-api.js';
import {createApp} from '../../web/src/server.js';
import {configuredPurchaseApis} from '../../web/src/configured-purchase-api.js';
import {configuredOrderApi} from '../../web/src/configured-order-api.js';
import {configuredApprovalApi} from '../../web/src/configured-approval-api.js';
import {configuredFundingApi} from '../../web/src/configured-funding-api.js';
import {configuredFulfillmentApi} from '../../web/src/configured-fulfillment-api.js';
import {configuredDeliveryApi} from '../../web/src/configured-delivery-api.js';
import {configuredAcceptanceApi} from '../../web/src/configured-acceptance-api.js';
import {configuredVoteApi} from '../../web/src/configured-vote-api.js';
import {configuredWithdrawalApi} from '../../web/src/configured-withdrawal-api.js';
import {configuredAllocationApi} from '../../web/src/configured-allocation-api.js';
import {PurchaseFlow} from '../../web/src/purchase-flow.js';
import {PurchaseClient} from '../../../packages/protocol/src/purchase-client.js';
import {AssetApprovalFlow} from '../../web/src/asset-approval-flow.js';
import {OriginalFundingFlow} from '../../web/src/original-funding-flow.js';
import {AutomaticPayment} from '../../web/src/purchase-automation.js';
import {CompleteOrderAutomation} from '../../web/src/order-automation.js';

import type {BackgroundActorConfig} from '../../../packages/adapters/src/privy-background-actor.js';
import type {BackgroundActivation} from './background-procurement.js';
import {writePrivateServiceJsonOnce} from '../../../scripts/create-privy-service-wallets.js';
import {CatalogResponseSchema} from '../../../packages/protocol/src/purchase-api.js';

export async function executeProcurement(scopeInput:unknown,memoryInput:unknown,configs:readonly [BackgroundActorConfig,BackgroundActorConfig],directory:string,activation:BackgroundActivation,environment:NodeJS.ProcessEnv=process.env,progress:(stage:string)=>void=()=>{},assertActive:()=>void=()=>{},catalogue?:unknown,attemptNamespace?:string){
  const scope=ExecutionScopeSchema.parse(scopeInput),plan={scope,scopeHash:executionScopeHash(scope)},memory=MemoryPayloadSchema.parse(memoryInput);
  if(!memory.taskInput)throw Error('BACKGROUND_TASK_REQUIRED');
  let bundle:Awaited<ReturnType<typeof createBackgroundSessions>>|undefined,vault:BackgroundVault|undefined;
  try{
  const base=configuredBrowserApi(environment);if(!base||JSON.stringify(base.configuration.recoveryDeployment)!==JSON.stringify(plan.scope.deployment))throw Error('BACKGROUND_DEPLOYMENT_CHANGED');
  const env:NodeJS.ProcessEnv={...environment,PURCHASE_BOND:'0',DELIVERY_SECONDS:plan.scope.mode==='general-job'?plan.scope.profile.deliverySeconds:'1800',SETTLEMENT_SECONDS:plan.scope.mode==='general-job'?plan.scope.profile.settlementSeconds:'3600'};
  if(catalogue!==undefined){const book=CatalogResponseSchema.parse(catalogue),path=resolve(directory,'task-catalogue.json');writePrivateServiceJsonOnce(path,book);env.QUOTE_CATALOG_PATH=path;}
  let flow:PurchaseFlow|undefined;
  bundle=await createBackgroundSessions(createPrivyClient({appId:env.PRIVY_APP_ID!,appSecret:env.PRIVY_APP_SECRET!}),plan.scope,configs,base.configuration,async auth=>{
    const proposalStartedAt=plan.scope.mode==='general-job'?String(BigInt(plan.scope.expiresAt)-BigInt(plan.scope.profile.settlementSeconds)):undefined;
    const reviewAttemptNamespace=plan.scope.mode==='general-job'?z.uuid().parse(attemptNamespace??basename(directory)):undefined;
    const browser={...base,auth},purchase=configuredPurchaseApis(env,browser,{proposalStartedAt,reviewAttemptNamespace}),order=configuredOrderApi(env),approval=configuredApprovalApi(env,browser,purchase.preflightApi),funding=configuredFundingApi(env,browser),fulfillment=configuredFulfillmentApi(env,browser),delivery=configuredDeliveryApi(env,browser),acceptance=configuredAcceptanceApi(env,browser,fulfillment),vote=configuredVoteApi(env,browser,acceptance),withdrawal=configuredWithdrawalApi(env,browser),allocation=configuredAllocationApi(env,browser);
    const cleanup=()=>{purchase.closeReview?.();approval?.store.close();funding?.worker.store.close();delivery?.store.close();acceptance?.store.close();vote?.store.close();withdrawal?.store.close();allocation?.store.close();};
    try{
      if(!order||!approval||!funding||!fulfillment||!delivery||!acceptance||!vote||!withdrawal||!allocation||!purchase.proposeApi||!purchase.reviewApi||!purchase.preflightApi||!purchase.catalogApi)throw Error('BACKGROUND_API_CONFIGURATION_REQUIRED');
      const app=await createApp({webMode:'production',browserApi:browser,orderApi:{...order,auth},approvalApi:approval,fundingApi:funding,fulfillmentApi:fulfillment,deliveryApi:delivery,acceptanceApi:acceptance,voteApi:vote,withdrawalApi:withdrawal,allocationApi:allocation,...purchase});
      await new Promise<void>((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
      const bound=app.server.address();if(!bound||typeof bound==='string')throw Error('BACKGROUND_LOOPBACK_API_REQUIRED');
      return {baseUrl:`http://127.0.0.1:${bound.port}/`,close:async()=>{await app.close();cleanup();}};
    }catch(error){cleanup();throw error;}
  },()=>flow?.authorization?.payload,async original=>{if(!vault)throw Error('BACKGROUND_BACKUP_UNAVAILABLE');vault.save('checkpoint',createHash('sha256').update(`${plan.scopeHash}:original-signed-grant-response`).digest('hex'),plan.scopeHash,{stage:'ORIGINAL_SIGNED_GRANT_RESPONSE',payload:original});});
  const task={policy:memory.policy,evidence:memory.evidence,taskInput:memory.taskInput},api=new PurchaseClient(bundle.baseUrl,()=>bundle!.buyer.token());
  flow=new PurchaseFlow(()=>task,bundle.buyer,api);
  const buyer=await bundle.buyer.verified();
  vault=new BackgroundVault(resolve(directory,'vault'));
  writePrivateServiceJsonOnce(resolve(directory,'job-reference.json'),{scopeHash:plan.scopeHash,sellerSubject:configs[1].subject});
  vault.save('checkpoint',createHash('sha256').update(`${plan.scopeHash}:runtime-scope`).digest('hex'),plan.scopeHash,{scope:plan.scope});
  const run=new BackgroundProcurement(plan.scope,vault,{flow,assertDelegationReady:()=>bundle!.assertReady(),payment:(payload,ready)=>new AutomaticPayment(payload,new AssetApprovalFlow(payload,buyer.subject,ready,bundle!.buyer,api),new OriginalFundingFlow(payload,buyer.subject,ready,bundle!.buyer,api),()=>api.preflight({intent:(payload as {intent:unknown}).intent,grant:(payload as {grant:unknown}).grant})),fulfillment:(payload,dataset)=>new CompleteOrderAutomation({payload,dataset},bundle!.baseUrl,{seller:bundle!.seller,members:[{index:plan.scope.deployment.committee.findIndex(w=>w.toLowerCase()===plan.scope.buyer.toLowerCase()) as 0|1|2,session:bundle!.buyer},{index:plan.scope.deployment.committee.findIndex(w=>w.toLowerCase()===plan.scope.seller.toLowerCase()) as 0|1|2,session:bundle!.seller}],settler:bundle!.buyer,payee:bundle!.seller})});
  return await run.run(memory,activation,progress,assertActive);
  }finally{try{await bundle?.close();}finally{vault?.dispose();}}
}
