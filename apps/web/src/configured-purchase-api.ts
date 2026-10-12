import {pacedHttp} from '../../../packages/adapters/src/paced-rpc.js';
import {address,positiveUint} from '../../../packages/protocol/src/schemas.js';
import {committeeHash} from '../../../packages/protocol/src/escrow.js';
import {ChatPlanner} from '../../../packages/adapters/src/planner.js';
import {JevHttp} from '../../../packages/adapters/src/jev-review.js';
import {loadActivatedReviewPolicy} from '../../../packages/adapters/src/review-policy.js';
import {FileQuoteCatalog,type CatalogApi} from './catalog-api.js';
import {ProposalService} from './services/propose.js';
import {ReviewService} from './services/review.js';
import type {ProposeApi} from './propose-api.js';
import type {ReviewApi} from './review-api.js';
import type {BrowserApi} from './browser-api.js';
import {createPublicClient,type Address} from 'viem';
import {PurchasePreflightReader} from '../../../packages/protocol/src/purchase-preflight.js';
import type {PreflightApi} from './preflight-api.js';
import type {OrderPreparationApi} from './order-preparation-api.js';
import {configuredReviewer,reviewerConfigNames} from './configured-reviewer.js';
import {ReviewStore} from '../../../packages/storage/src/review-store.js';
import {ReceiptRecoveryService} from './services/receipt-recovery.js';
import type {ReceiptRecoveryApi} from './receipt-recovery-api.js';
import {receiptRecoveryGuard} from './receipt-recovery-guard.js';
export function configuredPurchaseApis(env:NodeJS.ProcessEnv,browserApi:BrowserApi|undefined,options:{proposalStartedAt?:string;reviewAttemptNamespace?:string}={}):{orderPreparationApi?:OrderPreparationApi;catalogApi?:CatalogApi;proposeApi?:ProposeApi;reviewApi?:ReviewApi;receiptRecoveryApi?:ReceiptRecoveryApi;preflightApi?:PreflightApi;closeReview?:()=>void} {
  const signingRequested=reviewerConfigNames.some(n=>!!env[n]);
  if(env.REVIEW_JOURNAL_DB_PATH&&(!browserApi?.configuration.recoveryDeployment||!env.TYPESAFE_API_KEY||!env.JEV_MODEL||!env.REVIEW_POLICY_PATH||!env.ELIGIBILITY_GATE_ADDRESS))throw new Error('REVIEW_JOURNAL_CONFIGURATION_INVALID');
  if(signingRequested&&(!reviewerConfigNames.every(n=>env[n])||!browserApi?.configuration.recoveryDeployment||!env.TYPESAFE_API_KEY||!env.JEV_MODEL||!env.REVIEW_POLICY_PATH||!env.ELIGIBILITY_GATE_ADDRESS))throw new Error('REVIEWER_CONFIGURATION_INVALID');
  if(!browserApi)return {};
  const auth=browserApi.auth,d=browserApi.configuration.recoveryDeployment;
  const catalog=env.QUOTE_CATALOG_PATH?new FileQuoteCatalog(env.QUOTE_CATALOG_PATH):undefined;
  const catalogApi=catalog?{auth,list:()=>catalog.list()}:undefined;
  if(!d||!env.ELIGIBILITY_GATE_ADDRESS)return {catalogApi};
  const deployment={chainId:positiveUint.parse(d.chainId),arbiter:d.arbiter as Address,asset:d.asset as Address,gate:address.parse(env.ELIGIBILITY_GATE_ADDRESS) as Address,reviewer:d.reviewer as Address,committeeHash:committeeHash(d.committee)};
  const reader=env.MONAD_RPC_URL?new PurchasePreflightReader(createPublicClient({transport:pacedHttp(env.MONAD_RPC_URL,{timeout:20000})}),deployment,d.executor):undefined;
  const preflightApi=reader?{auth,read:(input:unknown)=>reader.read(input)}:undefined;
  let orderPreparationApi:OrderPreparationApi|undefined,proposeApi:ProposeApi|undefined,reviewApi:ReviewApi|undefined,receiptRecoveryApi:ReceiptRecoveryApi|undefined,closeReview:(()=>void)|undefined;
  if(catalog&&env.PLANNER_API_URL&&env.PLANNER_API_KEY&&env.PLANNER_MODEL&&env.PURCHASE_BOND&&env.DELIVERY_SECONDS&&env.SETTLEMENT_SECONDS) {
    proposeApi={auth,service:new ProposalService(new ChatPlanner(env.PLANNER_API_URL,env.PLANNER_API_KEY,env.PLANNER_MODEL),catalog,deployment,{bond:env.PURCHASE_BOND,deliverySeconds:env.DELIVERY_SECONDS,settlementSeconds:env.SETTLEMENT_SECONDS,...(options.proposalStartedAt===undefined?{}:{startedAt:options.proposalStartedAt})})};
  }
  if(env.TYPESAFE_API_KEY&&env.JEV_MODEL&&env.REVIEW_POLICY_PATH) {
    if(!env.REVIEW_JOURNAL_DB_PATH)throw new Error('REVIEW_JOURNAL_CONFIGURATION_INVALID');
    const rule=loadActivatedReviewPolicy(env.REVIEW_POLICY_PATH,env.JEV_MODEL);
    const jev=new JevHttp(env.TYPESAFE_API_KEY,rule.model,undefined,rule.questionVersion??1),journal=new ReviewStore(env.REVIEW_JOURNAL_DB_PATH??'');
    try{const reviewer=signingRequested?configuredReviewer(env,browserApi,rule):undefined;
      closeReview=()=>{try{reviewer?.close();}finally{journal.close();}};
      orderPreparationApi={auth,deployment:d,rule};
      reviewApi={auth,service:new ReviewService(jev,deployment,rule.minConfidence,reviewer?.signer,undefined,journal,options.reviewAttemptNamespace)};browserApi.configuration.purchaseRule=rule;
      if(reviewer&&reader&&env.FUNDING_DB_PATH)receiptRecoveryApi={auth,service:new ReceiptRecoveryService(journal,reviewer.store,reviewer.signer,deployment,rule,receiptRecoveryGuard(reader.client,deployment,env.FUNDING_DB_PATH))};
    }catch{journal.close();throw new Error('REVIEWER_CONFIGURATION_INVALID');}
  }
  return {catalogApi,proposeApi,reviewApi,receiptRecoveryApi,preflightApi,closeReview,orderPreparationApi};
}
