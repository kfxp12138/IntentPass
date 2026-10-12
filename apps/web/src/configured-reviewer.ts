import {isAbsolute,dirname} from 'node:path';
import {statSync} from 'node:fs';
import type {BrowserApi} from './browser-api.js';
import {createPrivyClient} from '../../../packages/adapters/src/privy-auth.js';
import {PrivyReceiptSigner} from '../../../packages/adapters/src/privy-receipt-signer.js';
import {ReceiptStore} from '../../../packages/storage/src/receipt-store.js';
export const reviewerConfigNames=['PRIVY_REVIEWER_WALLET_ID','PRIVY_REVIEWER_POLICY_ID','PRIVY_REVIEWER_SIGNER_ID','PRIVY_REVIEWER_AUTHORIZATION_PRIVATE_KEY','REVIEW_RECEIPT_DB_PATH'] as const;
export function configuredReviewer(env:NodeJS.ProcessEnv,browser:BrowserApi,rule:{model:string;questionConfigHash:string}){
  const d=browser.configuration.recoveryDeployment,path=env.REVIEW_RECEIPT_DB_PATH;
  if(!d||!reviewerConfigNames.every(n=>env[n])||!env.PRIVY_APP_ID||!env.PRIVY_APP_SECRET||!path||!isAbsolute(path)||!path.endsWith('.db')||!statSync(dirname(path)).isDirectory()||env.PRIVY_REVIEWER_WALLET_ID===env.PRIVY_WALLET_ID||env.PRIVY_REVIEWER_POLICY_ID===env.PRIVY_POLICY_ID||d.reviewer.toLowerCase()===d.executor.toLowerCase())throw new Error('REVIEWER_CONFIGURATION_INVALID');
  if(d.chainId!=='143'&&d.chainId!=='10143')throw new Error('REVIEWER_CONFIGURATION_INVALID');
  const store=new ReceiptStore(path);
  try{const signer=new PrivyReceiptSigner(createPrivyClient({appId:env.PRIVY_APP_ID,appSecret:env.PRIVY_APP_SECRET}),{chainId:d.chainId,arbiter:d.arbiter,address:d.reviewer,model:rule.model,questionConfigHash:rule.questionConfigHash,walletId:env.PRIVY_REVIEWER_WALLET_ID!,policyId:env.PRIVY_REVIEWER_POLICY_ID!,signerId:env.PRIVY_REVIEWER_SIGNER_ID!,authorizationPrivateKey:env.PRIVY_REVIEWER_AUTHORIZATION_PRIVATE_KEY!},store);return {signer,store,close:()=>store.close()};}catch{store.close();throw new Error('REVIEWER_CONFIGURATION_INVALID');}
}
