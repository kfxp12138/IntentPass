import {pacedHttp} from '../../../packages/adapters/src/paced-rpc.js';
import {isAbsolute} from 'node:path';
import {createPublicClient,type Address} from 'viem';
import type {BrowserApi} from './browser-api.js';
import type {DeliveryApi} from './delivery-api.js';
import {DeliveryStore} from '../../../packages/storage/src/delivery-store.js';
import {DeliveryReader} from '../../../packages/capsule/src/delivery-read.js';
import {EscrowReader} from '../../../packages/protocol/src/escrow-read.js';
import {committeeHash} from '../../../packages/protocol/src/escrow.js';
import {address} from '../../../packages/protocol/src/schemas.js';
export function configuredDeliveryApi(env:NodeJS.ProcessEnv,browser:BrowserApi|undefined):DeliveryApi|undefined{
  if(!env.DELIVERY_DB_PATH)return undefined;if(!isAbsolute(env.DELIVERY_DB_PATH)||!env.DELIVERY_DB_PATH.endsWith('.db'))throw new Error('DELIVERY_CONFIGURATION_INVALID');
  const d=browser?.configuration.recoveryDeployment;if(!browser||!d||!env.MONAD_RPC_URL||!env.ELIGIBILITY_GATE_ADDRESS)return undefined;if(!['143','10143'].includes(d.chainId))throw new Error('DELIVERY_MONAD_CHAIN_REQUIRED');
  const client=createPublicClient({transport:pacedHttp(env.MONAD_RPC_URL,{timeout:20000})}),reader=new EscrowReader(client,{chainId:d.chainId,arbiter:d.arbiter as Address,asset:d.asset as Address,gate:address.parse(env.ELIGIBILITY_GATE_ADDRESS) as Address,reviewer:d.reviewer as Address,committeeHash:committeeHash(d.committee)}),proof=new DeliveryReader(client,d,reader);
  return {auth:browser.auth,deployment:d,store:new DeliveryStore(env.DELIVERY_DB_PATH),read:id=>reader.read(id),receipt:(input,wallets)=>proof.read(input,wallets)};
}
