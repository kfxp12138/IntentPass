import {isAbsolute} from 'node:path';
import type {BrowserApi} from './browser-api.js';
import type {FulfillmentApi} from './fulfillment-api.js';
import type {AcceptanceApi} from './acceptance-api.js';
import {AcceptanceStore} from '../../../packages/storage/src/acceptance-store.js';
/** Reuses the fixed production finalized reader; no signer or wallet configuration. */
export function configuredAcceptanceApi(env:NodeJS.ProcessEnv,browser:BrowserApi|undefined,fulfillment:FulfillmentApi|undefined):AcceptanceApi|undefined{
  if(!env.ACCEPTANCE_DB_PATH)return undefined;if(!isAbsolute(env.ACCEPTANCE_DB_PATH)||!env.ACCEPTANCE_DB_PATH.endsWith('.db'))throw new Error('ACCEPTANCE_CONFIGURATION_INVALID');
  const d=browser?.configuration.recoveryDeployment;if(!browser||!d||!fulfillment)return undefined;if(!['143','10143'].includes(d.chainId)||JSON.stringify(d)!==JSON.stringify(fulfillment.deployment)||fulfillment.auth!==browser.auth)throw new Error('ACCEPTANCE_CONFIGURATION_INVALID');
  return {auth:browser.auth,deployment:d,store:new AcceptanceStore(env.ACCEPTANCE_DB_PATH),read:id=>fulfillment.read(id)};
}
