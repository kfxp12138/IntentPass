import {pacedHttp} from '../../../packages/adapters/src/paced-rpc.js';
import {isAbsolute} from 'node:path';
import {createPublicClient,type Address} from 'viem';
import type {BrowserApi} from './browser-api.js';
import type {FundingApi} from './funding-api.js';
import {createPrivyClient} from '../../../packages/adapters/src/privy-auth.js';
import {PrivyRestrictedSender} from '../../../packages/adapters/src/privy-sender.js';
import {FundingStore} from '../../../packages/storage/src/funding-store.js';
import {FundingWorker} from '../../worker/src/funding.js';
import {viemFundingPort} from '../../worker/src/funding-port.js';
import {EscrowReader} from '../../../packages/protocol/src/escrow-read.js';
import {PurchasePreflightReader} from '../../../packages/protocol/src/purchase-preflight.js';
import {committeeHash} from '../../../packages/protocol/src/escrow.js';
import {address} from '../../../packages/protocol/src/schemas.js';
/** Explicit config, no wallet/policy creation, no autonomous startup or sponsor readiness claim. */
export function configuredFundingApi(env:NodeJS.ProcessEnv,browser:BrowserApi|undefined):FundingApi|undefined {
  if(!env.FUNDING_DB_PATH)return undefined;
  if(!isAbsolute(env.FUNDING_DB_PATH)||!env.FUNDING_DB_PATH.endsWith('.db'))throw new Error('FUNDING_CONFIGURATION_INVALID');
  const d=browser?.configuration.recoveryDeployment,keys=['PRIVY_APP_ID','PRIVY_APP_SECRET','PRIVY_WALLET_ID','PRIVY_POLICY_ID','PRIVY_SIGNER_ID','PRIVY_AUTHORIZATION_PRIVATE_KEY','MONAD_RPC_URL','ELIGIBILITY_GATE_ADDRESS'];
  if(!browser||!d||keys.some(k=>!env[k]?.trim()))return undefined;
  if(!['143','10143'].includes(d.chainId))throw new Error('FUNDING_CONFIGURATION_INVALID');
  const client=createPublicClient({transport:pacedHttp(env.MONAD_RPC_URL,{timeout:20000})}),deployment={chainId:d.chainId,arbiter:d.arbiter as Address,asset:d.asset as Address,gate:address.parse(env.ELIGIBILITY_GATE_ADDRESS) as Address,reviewer:d.reviewer as Address,committeeHash:committeeHash(d.committee)};
  const sender=new PrivyRestrictedSender(createPrivyClient({appId:env.PRIVY_APP_ID!,appSecret:env.PRIVY_APP_SECRET!,verificationKey:env.PRIVY_JWT_VERIFICATION_KEY}),{chainId:d.chainId,arbiter:d.arbiter as Address,address:d.executor as Address,walletId:env.PRIVY_WALLET_ID!,policyId:env.PRIVY_POLICY_ID!,signerId:env.PRIVY_SIGNER_ID!,authorizationPrivateKey:env.PRIVY_AUTHORIZATION_PRIVATE_KEY!,gasLimit:env.PRIVY_GAS_LIMIT??'2000000',sensitiveValues:[env.PRIVY_APP_SECRET!,env.PRIVY_AUTHORIZATION_PRIVATE_KEY!]});
  const reader=new EscrowReader(client,deployment),preflight=new PurchasePreflightReader(client,deployment,d.executor),store=new FundingStore(env.FUNDING_DB_PATH);
  return {auth:browser.auth,worker:new FundingWorker(store,viemFundingPort(reader,preflight,sender),d)};
}
