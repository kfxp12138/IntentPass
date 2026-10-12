import {pacedHttp} from '../../../packages/adapters/src/paced-rpc.js';
import {createPublicClient,type Address} from 'viem';
import type {BrowserApi} from './browser-api.js';
import type {FulfillmentApi} from './fulfillment-api.js';
import {EscrowReader} from '../../../packages/protocol/src/escrow-read.js';
import {committeeHash} from '../../../packages/protocol/src/escrow.js';
import {address} from '../../../packages/protocol/src/schemas.js';
/** Read-only preparation; no wallet, signer, operator policy or database. */
export function configuredFulfillmentApi(env:NodeJS.ProcessEnv,browser:BrowserApi|undefined):FulfillmentApi|undefined {
  const d=browser?.configuration.recoveryDeployment;if(!browser||!d||!env.MONAD_RPC_URL||!env.ELIGIBILITY_GATE_ADDRESS)return undefined;
  if(!['143','10143'].includes(d.chainId))throw new Error('FULFILLMENT_MONAD_CHAIN_REQUIRED');
  const reader=new EscrowReader(createPublicClient({transport:pacedHttp(env.MONAD_RPC_URL,{timeout:20000})}),{chainId:d.chainId,arbiter:d.arbiter as Address,asset:d.asset as Address,gate:address.parse(env.ELIGIBILITY_GATE_ADDRESS) as Address,reviewer:d.reviewer as Address,committeeHash:committeeHash(d.committee)});
  return {auth:browser.auth,deployment:d,read:id=>reader.read(id)};
}
