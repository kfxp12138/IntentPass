import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {BackgroundScopeSchema,backgroundScopeHash} from '../packages/automation/src/background-scope.js';
import {BackgroundVault} from '../packages/storage/src/background-vault.js';
import {BackgroundProcurement} from '../apps/worker/src/background-procurement.js';
import {createBackgroundSessions} from '../apps/worker/src/background-sessions.js';
import {readPrivateServiceJson} from './create-privy-service-wallets.js';
import {MemoryPayloadSchema} from '../packages/capsule/src/format.js';
import {createPrivyClient} from '../packages/adapters/src/privy-auth.js';
import {ProviderIdSchema} from '../packages/protocol/src/day4-origin-types.js';
import {configuredBrowserApi} from '../apps/web/src/browser-api.js';
import {createApp} from '../apps/web/src/server.js';
import {configuredPurchaseApis} from '../apps/web/src/configured-purchase-api.js';
import {configuredOrderApi} from '../apps/web/src/configured-order-api.js';
import {configuredApprovalApi} from '../apps/web/src/configured-approval-api.js';
import {configuredFundingApi} from '../apps/web/src/configured-funding-api.js';
import {configuredFulfillmentApi} from '../apps/web/src/configured-fulfillment-api.js';
import {configuredDeliveryApi} from '../apps/web/src/configured-delivery-api.js';
import {configuredAcceptanceApi} from '../apps/web/src/configured-acceptance-api.js';
import {configuredVoteApi} from '../apps/web/src/configured-vote-api.js';
import {configuredWithdrawalApi} from '../apps/web/src/configured-withdrawal-api.js';
import {configuredAllocationApi} from '../apps/web/src/configured-allocation-api.js';
import {PurchaseFlow} from '../apps/web/src/purchase-flow.js';
import {PurchaseClient} from '../packages/protocol/src/purchase-client.js';
import {AssetApprovalFlow} from '../apps/web/src/asset-approval-flow.js';
import {OriginalFundingFlow} from '../apps/web/src/original-funding-flow.js';
import {AutomaticPayment} from '../apps/web/src/purchase-automation.js';
import {CompleteOrderAutomation} from '../apps/web/src/order-automation.js';

let bundle:Awaited<ReturnType<typeof createBackgroundSessions>>|undefined,vault:BackgroundVault|undefined;
try{
  if(process.argv.length!==4||process.argv[2]!=='--run'||!/^[a-f0-9]{64}$/.test(process.argv[3]))throw Error('BACKGROUND_ARGUMENT_INVALID');
  const directory=resolve('.tools/background-plans',process.argv[3]),plan=z.object({scope:BackgroundScopeSchema,scopeHash:z.string()}).passthrough().parse(readPrivateServiceJson(resolve(directory,'plan.json')));
  if(backgroundScopeHash(plan.scope)!==process.argv[3]||plan.scopeHash!==process.argv[3])throw Error('BACKGROUND_PLAN_CHANGED');
  let activation:{scopeHash:string;walletDelegationApproved:true;localPlaintextProcessingApproved:true};
  try{activation=z.object({scopeHash:z.literal(plan.scopeHash),walletDelegationApproved:z.literal(true),localPlaintextProcessingApproved:z.literal(true)}).strict().parse(readPrivateServiceJson(resolve(directory,'activation.json')));}catch{throw Error('BACKGROUND_INITIAL_SETUP_APPROVAL_REQUIRED');}
  const actor=z.object({role:z.enum(['buyer','seller']),walletId:ProviderIdSchema,signerId:ProviderIdSchema,policyId:ProviderIdSchema,subject:z.string().min(1).max(512),authorizationPrivateKey:z.string().min(1).max(8192)}).strict();
  let configs:[z.infer<typeof actor>,z.infer<typeof actor>];
  try{configs=z.tuple([actor,actor]).parse(readPrivateServiceJson(resolve(directory,'actors.json')));}catch{throw Error('BACKGROUND_DELEGATION_CONFIGURATION_REQUIRED');}
  const memory=z.object({memory:MemoryPayloadSchema}).passthrough().parse(readPrivateServiceJson(resolve('.tools/demo-procurement/policy6-task-local.json'))).memory;
  // A new arrangement is new input; original files, signatures and unknown records stay unchanged.
  memory.policy={...memory.policy,version:String(BigInt(memory.policy.version)+1n)};
  if(!memory.taskInput)throw Error('BACKGROUND_TASK_REQUIRED');
  const base=configuredBrowserApi(process.env);if(!base||JSON.stringify(base.configuration.recoveryDeployment)!==JSON.stringify(plan.scope.deployment))throw Error('BACKGROUND_DEPLOYMENT_CHANGED');
  const env:NodeJS.ProcessEnv={...process.env,PURCHASE_BOND:'0',DELIVERY_SECONDS:'1800',SETTLEMENT_SECONDS:'3600'};
  let flow:PurchaseFlow|undefined;
  bundle=await createBackgroundSessions(createPrivyClient({appId:env.PRIVY_APP_ID!,appSecret:env.PRIVY_APP_SECRET!}),plan.scope,configs,base.configuration,async auth=>{
    const browser={...base,auth},purchase=configuredPurchaseApis(env,browser),order=configuredOrderApi(env),approval=configuredApprovalApi(env,browser,purchase.preflightApi),funding=configuredFundingApi(env,browser),fulfillment=configuredFulfillmentApi(env,browser),delivery=configuredDeliveryApi(env,browser),acceptance=configuredAcceptanceApi(env,browser,fulfillment),vote=configuredVoteApi(env,browser,acceptance),withdrawal=configuredWithdrawalApi(env,browser),allocation=configuredAllocationApi(env,browser);
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
  const run=new BackgroundProcurement(plan.scope,vault,{flow,assertDelegationReady:()=>bundle!.assertReady(),payment:(payload,ready)=>new AutomaticPayment(payload,new AssetApprovalFlow(payload,buyer.subject,ready,bundle!.buyer,api),new OriginalFundingFlow(payload,buyer.subject,ready,bundle!.buyer,api),()=>api.preflight({intent:(payload as {intent:unknown}).intent,grant:(payload as {grant:unknown}).grant})),fulfillment:(payload,dataset)=>new CompleteOrderAutomation({payload,dataset},bundle!.baseUrl,{seller:bundle!.seller,members:[{index:plan.scope.deployment.committee.findIndex(w=>w.toLowerCase()===plan.scope.buyer.toLowerCase()) as 0|1|2,session:bundle!.buyer},{index:plan.scope.deployment.committee.findIndex(w=>w.toLowerCase()===plan.scope.seller.toLowerCase()) as 0|1|2,session:bundle!.seller}],settler:bundle!.buyer,payee:bundle!.seller})});
  const result=await run.run({...memory,taskInput:memory.taskInput},activation,stage=>console.log(JSON.stringify({stage,scopeHash:plan.scopeHash})));
  console.log(JSON.stringify(result));if(result.status!=='CONFIRMED')process.exitCode=1;
}catch(error){const code=error instanceof Error&&/^BACKGROUND_[A-Z_]+$/.test(error.message)?error.message:'BACKGROUND_RUN_BLOCKED_OR_ORIGINAL_OUTCOME_UNRESOLVED';console.error(JSON.stringify({status:'ATTENTION',code,mayRetryFinancialAction:false}));process.exitCode=1;}
finally{try{await bundle?.close();}finally{vault?.dispose();}}
