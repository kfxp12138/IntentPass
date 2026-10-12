import {randomBytes} from 'node:crypto';
import type {PrivyClient} from '@privy-io/node';
import {BrowserSession,type BrowserAuthPort} from '../../web/src/browser-session.js';
import {AuthenticationRejected,type Authenticator} from '../../../packages/adapters/src/privy-auth.js';
import {createBackgroundActor,type BackgroundActorConfig} from '../../../packages/adapters/src/privy-background-actor.js';
import {ExecutionScopeSchema} from '../../../packages/automation/src/background-scope.js';
import type {BrowserConfiguration} from '../../../packages/capsule/src/session-schema.js';
import type {UnsignedAuthorization} from '../../../packages/capsule/src/authorization.js';

/** Authenticator is supplied only to a separate loopback worker API. Opaque
 * capabilities stay in process RAM and are never browser or Privy access tokens.
 */
export async function createBackgroundSessions(client:PrivyClient,scopeInput:unknown,configs:readonly [BackgroundActorConfig,BackgroundActorConfig],
  configuration:BrowserConfiguration,api:(auth:Authenticator)=>Promise<{baseUrl:string;close():Promise<void>}>,getUnsigned:()=>UnsignedAuthorization|undefined,onGrantSignature?:(original:unknown)=>Promise<void>){
  configs=Object.freeze([Object.freeze({...configs[0]}),Object.freeze({...configs[1]})]) as readonly [BackgroundActorConfig,BackgroundActorConfig];
  const scope=ExecutionScopeSchema.parse(scopeInput),roles=['buyer','seller'] as const;
  if(configs[0].role!=='buyer'||configs[1].role!=='seller'||['walletId','signerId','policyId'].some(key=>configs[0][key as keyof BackgroundActorConfig]===configs[1][key as keyof BackgroundActorConfig]))throw Error('BACKGROUND_DISTINCT_ROLES_REQUIRED');
  const tokens=roles.map(()=>randomBytes(32).toString('base64url')),ports:BrowserAuthPort[]=[],sessions:BrowserSession[]=[];
  // These process-local tokens are minted only after the actual actor readiness
  // proof below. Every sign/send still rechecks current provider authority.
  const auth:Authenticator={authenticate:async token=>{const i=tokens.indexOf(token);if(i<0||!token||BigInt(Math.floor(Date.now()/1000))>=BigInt(scope.expiresAt))throw new AuthenticationRejected();return {subject:configs[i].subject,wallets:[scope[roles[i]] as `0x${string}`]};}};
  let server:Awaited<ReturnType<typeof api>>|undefined;
  try{
    for(let i=0;i<2;i++){const port=createBackgroundActor(client,scope,configs[i],()=>getUnsigned(),async()=>tokens[i],undefined,onGrantSignature);ports.push(port);await port.initialize();}
    server=await api(auth);
    const base=new URL(server.baseUrl);if(base.protocol!=='http:'||base.hostname!=='127.0.0.1'||base.pathname!=='/'||base.username||base.password)throw Error('BACKGROUND_LOOPBACK_API_REQUIRED');
    for(let i=0;i<2;i++)sessions.push(new BrowserSession(async()=>ports[i],(input,init)=>fetch(new URL(String(input),base),init),{role:roles[i]}));
    const assertReady=async()=>{for(const port of ports)await port.initialize();};
    return {buyer:sessions[0],seller:sessions[1],baseUrl:server.baseUrl,assertReady,configuration,close:async()=>{for(const session of sessions)await session.logout();tokens.fill('');await server!.close();}};
  }catch(error){tokens.fill('');for(const port of ports)await port.logout();await server?.close();throw error;}
}
