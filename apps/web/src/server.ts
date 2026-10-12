import {configuredGeneralConnectionApi,serveGeneralConnection,type GeneralConnectionApi} from './general-connection-api.js';
import {configuredWorkflowApi,serveWorkflow,type WorkflowApi} from './workflow-api.js';
import {serveAllocation,type AllocationApi} from './allocation-api.js';
import {configuredAllocationApi} from './configured-allocation-api.js';
import {serveWithdrawal,type WithdrawalApi} from './withdrawal-api.js';
import {configuredWithdrawalApi} from './configured-withdrawal-api.js';
import {serveVote,type VoteApi} from './vote-api.js';
import {configuredVoteApi} from './configured-vote-api.js';
import {serveAcceptance,type AcceptanceApi} from './acceptance-api.js';
import {configuredAcceptanceApi} from './configured-acceptance-api.js';
import {serveDelivery,serveOrderDelivery,type DeliveryApi} from './delivery-api.js';
import {configuredDeliveryApi} from './configured-delivery-api.js';
import {serveFulfillment,type FulfillmentApi} from './fulfillment-api.js';
import {configuredFulfillmentApi} from './configured-fulfillment-api.js';
import {serveFunding,type FundingApi} from './funding-api.js';
import {configuredFundingApi} from './configured-funding-api.js';
import {serveApproval,type ApprovalApi} from './approval-api.js';
import {configuredApprovalApi} from './configured-approval-api.js';
import {serveProposal,type ProposeApi} from './propose-api.js';
import {serveCapsule,type CapsuleApi} from './capsule-api.js';
import {configuredCapsuleApi} from './configured-capsule-api.js';
import {serveBrowser,configuredBrowserApi,type BrowserApi} from './browser-api.js';
import {serveCatalog,type CatalogApi} from './catalog-api.js';
import {serveDemoQuote,configuredDemoQuoteApi,type DemoQuoteApi} from './demo-quote-api.js';
import {configuredPurchaseApis} from './configured-purchase-api.js';
import {servePreflight,type PreflightApi} from './preflight-api.js';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import {productionWeb,privateDevelopmentFile,privateFsDeny,webRequestPath,WebPathRejected} from './static-web.js';
import { integrationStatus } from '../../../packages/adapters/src/status.js';
import {serveReview,type ReviewApi} from './review-api.js';
import {serveReceiptRecovery,type ReceiptRecoveryApi} from './receipt-recovery-api.js';
import {configuredOrderApi} from './configured-order-api.js';
import {serveOrder,serveOriginalOrder,type OrderApi} from './order-api.js';
import {serveOrderPreparation,type OrderPreparationApi} from './order-preparation-api.js';
import { settlementRoute } from '../../../packages/protocol/src/route.js';
import {configuredLocalSdkApi,serveLocalSdk,serveLocalSdkProcurement,type LocalSdkApi} from './local-sdk-api.js';

export async function createApp(options:{localSdkApi?:LocalSdkApi;generalConnectionApi?:GeneralConnectionApi;workflowApi?:WorkflowApi;webMode?:'development'|'production';distDirectory?:string;demoQuoteApi?:DemoQuoteApi;orderPreparationApi?:OrderPreparationApi;dependencyPrebundling?:boolean;orderApi?:OrderApi;reviewApi?:ReviewApi;receiptRecoveryApi?:ReceiptRecoveryApi;proposeApi?:ProposeApi;capsuleApi?:CapsuleApi;browserApi?:BrowserApi;catalogApi?:CatalogApi;preflightApi?:PreflightApi;approvalApi?:ApprovalApi;fundingApi?:FundingApi;fulfillmentApi?:FulfillmentApi;deliveryApi?:DeliveryApi;acceptanceApi?:AcceptanceApi;voteApi?:VoteApi;withdrawalApi?:WithdrawalApi;allocationApi?:AllocationApi}={}) {
  const webRoot=fileURLToPath(new URL('../',import.meta.url)),production=options.webMode==='production',serveBuilt=production?await productionWeb(options.distDirectory??fileURLToPath(new URL('../dist/',import.meta.url))):undefined;
  let closing=false,closePromise:Promise<void>|undefined;
  const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if(closing)return send(503,{code:'WEB_SERVICE_UNAVAILABLE'});
    let path:string;try{path=webRequestPath(req.url);}catch(error){return send(error instanceof WebPathRejected?error.status:400,{code:'WEB_PATH_REJECTED'});}
    if(path==='/api/local/sdk-procurement'){if(!options.localSdkApi)return send(503,{code:'LOCAL_SDK_CHECK_DISABLED'});void serveLocalSdkProcurement(req,res,options.localSdkApi);return;}
    if(path==='/api/local/sdk-workflow-read'){if(!options.localSdkApi)return send(503,{code:'LOCAL_SDK_CHECK_DISABLED'});void serveLocalSdk(req,res,options.localSdkApi,true);return;}
    if(path==='/api/local/sdk-order-read'){if(!options.localSdkApi)return send(503,{code:'LOCAL_SDK_CHECK_DISABLED'});void serveLocalSdk(req,res,options.localSdkApi);return;}
    if(path==='/api/automation/connection'){if(!options.generalConnectionApi)return send(503,{code:'GENERAL_CONNECTION_CONFIGURATION_REQUIRED'});void serveGeneralConnection(req,res,options.generalConnectionApi);return;}
    if(path==='/api/automation/workflows'){if(!options.workflowApi)return send(503,{code:'WORKFLOW_CONFIGURATION_REQUIRED'});void serveWorkflow(req,res,options.workflowApi);return;}
    if (path === '/health') {
      if (req.method !== 'GET') return send(405, { code: 'METHOD_NOT_ALLOWED' });
      return send(200, { service: 'intentpass', stage: 'D1', liveness: 'OK', ready: false,
        settlementRoute, integrations: integrationStatus() });
    }
    if(['/api/withdrawals/prepare','/api/withdrawals/reserve','/api/withdrawals/query','/api/withdrawals/reconcile'].includes(path)&&options.withdrawalApi){void serveWithdrawal(req,res,path.slice('/api/withdrawals/'.length) as 'prepare'|'reserve'|'query'|'reconcile',options.withdrawalApi);return;}
    if(['/api/votes/prepare','/api/votes/reserve','/api/votes/query','/api/votes/reconcile'].includes(path)&&options.voteApi){void serveVote(req,res,path.slice('/api/votes/'.length) as 'prepare'|'reserve'|'query'|'reconcile',options.voteApi);return;}
    if((path==='/api/acceptances/reserve'||path==='/api/acceptances/query'||path==='/api/acceptances/record-signature')&&options.acceptanceApi){void serveAcceptance(req,res,path.endsWith('/reserve')?'reserve':path.endsWith('/query')?'query':'signature',options.acceptanceApi);return;}
    const originalOrder=path.match(/^\/api\/orders\/([^/]+)\/read-original$/);if(originalOrder){if(!options.orderApi?.deployment)return send(503,{code:'AUTH_CONFIGURATION_REQUIRED',status:'BLOCKED'});void serveOriginalOrder(req,res,originalOrder[1],{...options.orderApi,deployment:options.orderApi.deployment});return;}
    const orderDelivery=path.match(/^\/api\/orders\/([^/]+)\/deliver$/);if(orderDelivery){if(!options.deliveryApi)return send(503,{code:'AUTH_CONFIGURATION_REQUIRED',status:'BLOCKED'});void serveOrderDelivery(req,res,orderDelivery[1],options.deliveryApi);return;}
    if((path==='/api/deliveries/reserve'||path==='/api/deliveries/reconcile')&&options.deliveryApi){void serveDelivery(req,res,path.endsWith('/reserve')?'reserve':'reconcile',options.deliveryApi);return;}
    if((path==='/api/orders/prepare-delivery'||path==='/api/orders/prepare-acceptance')&&options.fulfillmentApi){void serveFulfillment(req,res,path.endsWith('/prepare-delivery')?'delivery':'acceptance',options.fulfillmentApi);return;}
    if(['/api/allocations/prepare','/api/allocations/trigger','/api/allocations/query','/api/allocations/reconcile'].includes(path)&&options.allocationApi){void serveAllocation(req,res,path.endsWith('/prepare')?'prepare':path.endsWith('/trigger')?'trigger':path.endsWith('/reconcile')?'reconcile':'query',options.allocationApi);return;}
    if(path==='/api/orders/prepare'){if(options.orderPreparationApi){void serveOrderPreparation(req,res,options.orderPreparationApi);return;}return send(503,{code:'AUTH_CONFIGURATION_REQUIRED',status:'BLOCKED'});}
    if(['/api/orders/submit','/api/orders/reconcile'].includes(path)&&!options.fundingApi)return send(503,{code:'AUTH_CONFIGURATION_REQUIRED',status:'BLOCKED'});
    if((path==='/api/orders/submit'||path==='/api/orders/reconcile'||path==='/api/intent/submit'||path==='/api/intent/reconcile')&&options.fundingApi){void serveFunding(req,res,path.endsWith('/submit')?'submit':'reconcile',options.fundingApi,path.startsWith('/api/orders/'));return;}
    if((path==='/api/asset-approvals/reserve'||path==='/api/asset-approvals/reconcile')&&options.approvalApi){void serveApproval(req,res,path.endsWith('/reserve')?'reserve':'reconcile',options.approvalApi);return;}
    if(path==='/api/intent/propose'&&options.proposeApi){void serveProposal(req,res,options.proposeApi);return;}
    if(path==='/api/intent/preflight'&&options.preflightApi){void servePreflight(req,res,options.preflightApi);return;}
    if(path==='/api/catalog'&&options.catalogApi){void serveCatalog(req,res,options.catalogApi);return;}
    if(['/api/demo-quotes','/api/demo-quotes/reserve','/api/demo-quotes/record'].includes(path)&&options.demoQuoteApi){void serveDemoQuote(req,res,path.endsWith('/reserve')?'reserve':path.endsWith('/record')?'record':'list',options.demoQuoteApi);return;}
    if((path==='/api/config'||path==='/api/session')&&options.browserApi){void serveBrowser(req,res,path,options.browserApi);return;}
    if(path==='/api/intent/review'&&options.reviewApi){void serveReview(req,res,options.reviewApi);return;}
    if(path==='/api/intent/receipt-recovery'&&options.receiptRecoveryApi){void serveReceiptRecovery(req,res,options.receiptRecoveryApi);return;}
    if(path.startsWith('/api/capsules/')&&options.capsuleApi){void serveCapsule(req,res,path.slice('/api/capsules/'.length),options.capsuleApi);return;}
    if (path.startsWith('/api/orders/') && options.orderApi) {
      void serveOrder(req,res,path.slice('/api/orders/'.length),options.orderApi);return;
    }
    if (path.startsWith('/api/')) {
      // Authentication must exist before exposing review, wallet, or stored capsule APIs.
      return send(503, { code: 'AUTH_CONFIGURATION_REQUIRED', status: 'BLOCKED',
        message: '真实认证与集成尚未完成，此接口暂不可用。' });
    }
    if(serveBuilt){void serveBuilt(req,res,path);return;}
    void privateDevelopmentFile(path,webRoot).then(blocked=>{if(blocked){send(403,{code:'WEB_FILE_ACCESS_DENIED'});return;}vite!.middlewares(req,res,()=>send(404,{code:'NOT_FOUND'}));}).catch(()=>send(503,{code:'WEB_SERVICE_UNAVAILABLE'}));
  });
  const vite = production?undefined:await (await import('vite')).createServer({ root: webRoot,
    ...(options.dependencyPrebundling===false?{optimizeDeps:{noDiscovery:true,include:[]}}:{}),
    server: { middlewareMode: true, host: '127.0.0.1', hmr: { server },fs:{strict:true,deny:privateFsDeny} }, appType: 'spa' });
  return { server, close: () => closePromise??=(async () => {
    closing=true;
    // Stop new HTTP work, including requests on an existing keep-alive socket.
    server.closeIdleConnections();
    server.closeAllConnections();
    // Vite closes its watcher and environments concurrently. Drain transforms
    // first: a pending import can otherwise add a watched file after the watcher
    // closed and reopen the native macOS watcher, leaving the process alive.
    if(vite){await Promise.all(Object.values(vite.environments).map(environment=>environment.close()));await vite.close();}
    await new Promise<void>((resolve, reject) => server.close(e => e&&(e as NodeJS.ErrnoException).code!=='ERR_SERVER_NOT_RUNNING' ? reject(e) : resolve()));
  })() };
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (existsSync('.env')) loadEnvFile('.env');
  let orderApi:OrderApi|undefined,capsuleApi:CapsuleApi|undefined,browserApi:BrowserApi|undefined,demoQuoteApi:DemoQuoteApi|undefined;
  try {orderApi=configuredOrderApi(process.env);capsuleApi=configuredCapsuleApi(process.env);browserApi=configuredBrowserApi(process.env);demoQuoteApi=configuredDemoQuoteApi(process.env,browserApi);}catch{console.error('SERVICE_CONFIGURATION_INVALID');process.exit(1);}
  let purchaseApis:ReturnType<typeof configuredPurchaseApis>;
  try{purchaseApis=configuredPurchaseApis(process.env,browserApi);}catch{capsuleApi?.store.close();console.error('PURCHASE_CONFIGURATION_INVALID');process.exit(1);}
  let approvalApi:ApprovalApi|undefined;
  try{approvalApi=configuredApprovalApi(process.env,browserApi,purchaseApis.preflightApi);}catch{purchaseApis.closeReview?.();capsuleApi?.store.close();console.error('APPROVAL_CONFIGURATION_INVALID');process.exit(1);}
  let allocationApi:AllocationApi|undefined,fundingApi:FundingApi|undefined,fulfillmentApi:FulfillmentApi|undefined,deliveryApi:DeliveryApi|undefined,acceptanceApi:AcceptanceApi|undefined,voteApi:VoteApi|undefined,withdrawalApi:WithdrawalApi|undefined;
  try{allocationApi=configuredAllocationApi(process.env,browserApi);fundingApi=configuredFundingApi(process.env,browserApi);fulfillmentApi=configuredFulfillmentApi(process.env,browserApi);deliveryApi=configuredDeliveryApi(process.env,browserApi);acceptanceApi=configuredAcceptanceApi(process.env,browserApi,fulfillmentApi);voteApi=configuredVoteApi(process.env,browserApi,acceptanceApi);withdrawalApi=configuredWithdrawalApi(process.env,browserApi);}catch{purchaseApis.closeReview?.();capsuleApi?.store.close();approvalApi?.store.close();fundingApi?.worker.store.close();deliveryApi?.store.close();acceptanceApi?.store.close();voteApi?.store.close();withdrawalApi?.store.close();allocationApi?.store.close();console.error('EXECUTION_CONFIGURATION_INVALID');process.exit(1);}
  let workflowApi:WorkflowApi|undefined;
  try{workflowApi=configuredWorkflowApi(process.env,browserApi);}catch{console.error('WORKFLOW_CONFIGURATION_INVALID');process.exit(1);}
  const generalConnectionApi=configuredGeneralConnectionApi(process.env,browserApi);
  const webMode=process.argv.includes('--production')?'production':'development';
  let app:Awaited<ReturnType<typeof createApp>>;
  try{app=await createApp({localSdkApi:configuredLocalSdkApi(process.env,browserApi),generalConnectionApi,workflowApi,webMode,demoQuoteApi,orderApi,capsuleApi,browserApi,approvalApi,fundingApi,fulfillmentApi,deliveryApi,acceptanceApi,voteApi,withdrawalApi,allocationApi,...purchaseApis});}catch{await workflowApi?.close();purchaseApis.closeReview?.();capsuleApi?.store.close();approvalApi?.store.close();fundingApi?.worker.store.close();deliveryApi?.store.close();acceptanceApi?.store.close();voteApi?.store.close();withdrawalApi?.store.close();allocationApi?.store.close();console.error(webMode==='production'?'PRODUCTION_BUILD_REQUIRED':'WEB_SERVICE_UNAVAILABLE');process.exit(1);}
  const port = Number(process.env.PORT ?? 3000);
  app.server.listen(port, '127.0.0.1', () => console.log(`IntentPass ${webMode}: http://127.0.0.1:${port} (integration readiness requires acceptance)`));
  for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal, async () => { await app.close();await workflowApi?.close();purchaseApis.closeReview?.();capsuleApi?.store.close();approvalApi?.store.close();fundingApi?.worker.store.close();deliveryApi?.store.close();acceptanceApi?.store.close();voteApi?.store.close();withdrawalApi?.store.close();allocationApi?.store.close(); process.exit(0); });
}
