import {pacedHttp} from '../../../packages/adapters/src/paced-rpc.js';
import {isAbsolute} from 'node:path';
import {createPublicClient,type Address} from 'viem';
import type {BrowserApi} from './browser-api.js';
import type {AcceptanceApi} from './acceptance-api.js';
import type {VoteApi} from './vote-api.js';
import {VoteStore} from '../../../packages/storage/src/vote-store.js';
import {VoteReader} from '../../../packages/capsule/src/vote-read.js';
import {EscrowReader} from '../../../packages/protocol/src/escrow-read.js';
import {committeeHash} from '../../../packages/protocol/src/escrow.js';
import {address} from '../../../packages/protocol/src/schemas.js';
export function configuredVoteApi(env:NodeJS.ProcessEnv,browser:BrowserApi|undefined,acceptance:AcceptanceApi|undefined):VoteApi|undefined{
  if(!env.VOTE_DB_PATH)return undefined;if(!isAbsolute(env.VOTE_DB_PATH)||!env.VOTE_DB_PATH.endsWith('.db'))throw new Error('VOTE_CONFIGURATION_INVALID');const d=browser?.configuration.recoveryDeployment;
  if(!browser||!d||!acceptance||!env.MONAD_RPC_URL||!env.ELIGIBILITY_GATE_ADDRESS)return undefined;if(!['143','10143'].includes(d.chainId)||acceptance.auth!==browser.auth||JSON.stringify(acceptance.deployment)!==JSON.stringify(d))throw new Error('VOTE_CONFIGURATION_INVALID');
  const client=createPublicClient({transport:pacedHttp(env.MONAD_RPC_URL,{timeout:20000})}),orders=new EscrowReader(client,{chainId:d.chainId,arbiter:d.arbiter as Address,asset:d.asset as Address,gate:address.parse(env.ELIGIBILITY_GATE_ADDRESS) as Address,reviewer:d.reviewer as Address,committeeHash:committeeHash(d.committee)}),proof=new VoteReader(client,d,orders);
  return {auth:browser.auth,deployment:d,store:new VoteStore(env.VOTE_DB_PATH),signatures:acceptance.store,read:id=>orders.read(id),receipt:(r,wallets)=>proof.read(r,wallets)};
}
