import {pacedHttp} from '../../../packages/adapters/src/paced-rpc.js';
import {isAbsolute} from 'node:path';
import {createPublicClient} from 'viem';
import type {BrowserApi} from './browser-api.js';
import type {PreflightApi} from './preflight-api.js';
import type {ApprovalApi} from './approval-api.js';
import {ApprovalStore} from '../../../packages/storage/src/approval-store.js';
import {ExactApprovalReader} from '../../../packages/capsule/src/asset-approval-read.js';
export function configuredApprovalApi(env:NodeJS.ProcessEnv,browser:BrowserApi|undefined,preflight:PreflightApi|undefined):ApprovalApi|undefined {
  if(!env.APPROVAL_DB_PATH)return undefined;
  if(!isAbsolute(env.APPROVAL_DB_PATH)||!env.APPROVAL_DB_PATH.endsWith('.db'))throw new Error('APPROVAL_CONFIGURATION_INVALID');
  if(!browser?.configuration.recoveryDeployment||!preflight||!env.MONAD_RPC_URL)return undefined;
  const deployment=browser.configuration.recoveryDeployment,reader=new ExactApprovalReader(createPublicClient({transport:pacedHttp(env.MONAD_RPC_URL,{timeout:20000})}),deployment);
  return {auth:browser.auth,deployment,store:new ApprovalStore(env.APPROVAL_DB_PATH),preflight:input=>preflight.read(input),receipt:(input,wallets,step,hash)=>reader.read(input,wallets,step,hash)};
}
