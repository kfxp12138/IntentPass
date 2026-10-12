import {pacedHttp} from '../../../packages/adapters/src/paced-rpc.js';
import {createPublicClient,type Address} from 'viem';
import {PrivyAuthenticator,createPrivyClient} from '../../../packages/adapters/src/privy-auth.js';
import {EscrowReader} from '../../../packages/protocol/src/escrow-read.js';
import {address,positiveUint} from '../../../packages/protocol/src/schemas.js';
import {committeeHash} from '../../../packages/protocol/src/escrow.js';
import type {OrderApi} from './order-api.js';
import {OriginalOrderReadDeploymentSchema} from '../../../packages/protocol/src/original-order-read.js';
import {assetConfigurationKey,configuredAssetAddress} from '../../../packages/protocol/src/asset-mode.js';
/** Config enables read-only access. It never turns integration acceptance or financial readiness green. */
export function configuredOrderApi(env:NodeJS.ProcessEnv):OrderApi|undefined {
  const required=['PRIVY_APP_ID','PRIVY_APP_SECRET','MONAD_RPC_URL','CHAIN_ID','ARBITER_ADDRESS',assetConfigurationKey(env),'ELIGIBILITY_GATE_ADDRESS','REVIEWER_ADDRESS','COMMITTEE_ADDRESSES'];
  if(required.some(key=>!env[key]?.trim()))return undefined;
  const reader=new EscrowReader(createPublicClient({transport:pacedHttp(env.MONAD_RPC_URL,{timeout:20000})}),{
    chainId:positiveUint.parse(env.CHAIN_ID),arbiter:address.parse(env.ARBITER_ADDRESS) as Address,asset:address.parse(configuredAssetAddress(env)) as Address,
    gate:address.parse(env.ELIGIBILITY_GATE_ADDRESS) as Address,reviewer:address.parse(env.REVIEWER_ADDRESS) as Address,
    committeeHash:committeeHash(env.COMMITTEE_ADDRESSES!.split(',').map(v=>v.trim())),
  });
  const deployment=env.PRIVY_EXECUTOR_ADDRESS?.trim()?OriginalOrderReadDeploymentSchema.parse({chainId:reader.deployment.chainId,arbiter:reader.deployment.arbiter,asset:reader.deployment.asset,reviewer:reader.deployment.reviewer,committee:env.COMMITTEE_ADDRESSES!.split(',').map(v=>v.trim()),executor:env.PRIVY_EXECUTOR_ADDRESS}):undefined;
  return {auth:new PrivyAuthenticator(createPrivyClient({appId:env.PRIVY_APP_ID!,appSecret:env.PRIVY_APP_SECRET!,verificationKey:env.PRIVY_JWT_VERIFICATION_KEY})),read:id=>reader.read(id),...(deployment?{deployment}:{})};
}
