import {pacedHttp} from '../../../packages/adapters/src/paced-rpc.js';
import {isAbsolute} from 'node:path';
import {createPublicClient,type Address} from 'viem';
import type {BrowserApi} from './browser-api.js';
import type {WithdrawalApi} from './withdrawal-api.js';
import {WithdrawalStore} from '../../../packages/storage/src/withdrawal-store.js';
import {WithdrawalReader} from '../../../packages/capsule/src/withdrawal-read.js';
import {EscrowReader} from '../../../packages/protocol/src/escrow-read.js';
import {committeeHash} from '../../../packages/protocol/src/escrow.js';
import {address} from '../../../packages/protocol/src/schemas.js';
export function configuredWithdrawalApi(env:NodeJS.ProcessEnv,browser:BrowserApi|undefined):WithdrawalApi|undefined{if(!env.WITHDRAWAL_DB_PATH)return undefined;if(!isAbsolute(env.WITHDRAWAL_DB_PATH)||!env.WITHDRAWAL_DB_PATH.endsWith('.db'))throw new Error('WITHDRAWAL_CONFIGURATION_INVALID');const d=browser?.configuration.recoveryDeployment;if(!browser||!d||!env.MONAD_RPC_URL||!env.ELIGIBILITY_GATE_ADDRESS)return undefined;if(!['143','10143'].includes(d.chainId))throw new Error('WITHDRAWAL_CONFIGURATION_INVALID');const client=createPublicClient({transport:pacedHttp(env.MONAD_RPC_URL,{timeout:20000})}),orders=new EscrowReader(client,{chainId:d.chainId,arbiter:d.arbiter as Address,asset:d.asset as Address,gate:address.parse(env.ELIGIBILITY_GATE_ADDRESS) as Address,reviewer:d.reviewer as Address,committeeHash:committeeHash(d.committee)}),reader=new WithdrawalReader(client,d,orders);return {auth:browser.auth,deployment:d,store:new WithdrawalStore(env.WITHDRAWAL_DB_PATH),prepare:(r,w)=>reader.prepare(r,w),receipt:(r,w)=>reader.read(r,w)};}
