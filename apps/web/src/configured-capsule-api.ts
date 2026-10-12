import {isAbsolute} from 'node:path';
import {PrivyAuthenticator,createPrivyClient} from '../../../packages/adapters/src/privy-auth.js';
import {CapsuleStore} from '../../../packages/storage/src/capsule-store.js';
import type {CapsuleApi} from './capsule-api.js';
/** Ciphertext-only service requires real authentication and explicit durable storage. */
export function configuredCapsuleApi(env:NodeJS.ProcessEnv):CapsuleApi|undefined {
  if(!env.PRIVY_APP_ID?.trim()||!env.PRIVY_APP_SECRET?.trim()||!env.CAPSULE_DB_PATH?.trim())return undefined;
  if(!isAbsolute(env.CAPSULE_DB_PATH)||!env.CAPSULE_DB_PATH.endsWith('.db'))throw new Error('CAPSULE_STORAGE_INVALID');
  const auth=new PrivyAuthenticator(createPrivyClient({appId:env.PRIVY_APP_ID,appSecret:env.PRIVY_APP_SECRET,verificationKey:env.PRIVY_JWT_VERIFICATION_KEY}));
  return {auth,store:new CapsuleStore(env.CAPSULE_DB_PATH)};
}
