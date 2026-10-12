import {pacedHttp} from '../../../packages/adapters/src/paced-rpc.js';
import {isAbsolute} from 'node:path';
import {createPublicClient,type Address} from 'viem';
import type {BrowserApi} from './browser-api.js';
import type {AllocationApi} from './allocation-api.js';
import {createPrivyClient} from '../../../packages/adapters/src/privy-auth.js';
import {PrivyRestrictedSender} from '../../../packages/adapters/src/privy-sender.js';
import {SettlementStore} from '../../../packages/storage/src/settlement-store.js';
import {AllocationReader} from '../../../packages/capsule/src/allocation-read.js';
import {viemSettlementPort} from '../../worker/src/viem-port.js';
import {EscrowReader} from '../../../packages/protocol/src/escrow-read.js';
import {committeeHash} from '../../../packages/protocol/src/escrow.js';
import {address} from '../../../packages/protocol/src/schemas.js';
/** Explicit config, no wallet/policy creation, no autonomous startup or sponsor readiness claim. */
export function configuredAllocationApi(env:NodeJS.ProcessEnv,browser:BrowserApi|undefined):AllocationApi|undefined {
  if(!env.ALLOCATION_DB_PATH)return undefined;
  if(!isAbsolute(env.ALLOCATION_DB_PATH)||!env.ALLOCATION_DB_PATH.endsWith('.db'))throw new Error('ALLOCATION_CONFIGURATION_INVALID');
  const d=browser?.configuration.recoveryDeployment,keys=['PRIVY_APP_ID','PRIVY_APP_SECRET','PRIVY_WALLET_ID','PRIVY_POLICY_ID','PRIVY_SIGNER_ID','PRIVY_AUTHORIZATION_PRIVATE_KEY','MONAD_RPC_URL','ELIGIBILITY_GATE_ADDRESS'];
  if(!browser||!d||keys.some(k=>!env[k]?.trim()))return undefined;
  if(!['143','10143'].includes(d.chainId))throw new Error('ALLOCATION_CONFIGURATION_INVALID');
  const client=createPublicClient({transport:pacedHttp(env.MONAD_RPC_URL,{timeout:20000})}),deployment={chainId:d.chainId,arbiter:d.arbiter as Address,asset:d.asset as Address,gate:address.parse(env.ELIGIBILITY_GATE_ADDRESS) as Address,reviewer:d.reviewer as Address,committeeHash:committeeHash(d.committee)};
  const sender=new PrivyRestrictedSender(createPrivyClient({appId:env.PRIVY_APP_ID!,appSecret:env.PRIVY_APP_SECRET!,verificationKey:env.PRIVY_JWT_VERIFICATION_KEY}),{chainId:d.chainId,arbiter:d.arbiter as Address,address:d.executor as Address,walletId:env.PRIVY_WALLET_ID!,policyId:env.PRIVY_POLICY_ID!,signerId:env.PRIVY_SIGNER_ID!,authorizationPrivateKey:env.PRIVY_AUTHORIZATION_PRIVATE_KEY!,gasLimit:env.PRIVY_GAS_LIMIT??'2000000',sensitiveValues:[env.PRIVY_APP_SECRET!,env.PRIVY_AUTHORIZATION_PRIVATE_KEY!]});
  const orders=new EscrowReader(client,deployment),reader=new AllocationReader(client,d,orders),store=new SettlementStore(env.ALLOCATION_DB_PATH);
  return {auth:browser.auth,deployment:d,reader,store,port:viemSettlementPort(orders,sender)};
}
