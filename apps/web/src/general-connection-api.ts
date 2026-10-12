import type {IncomingMessage,ServerResponse} from 'node:http';
import {resolve} from 'node:path';
import {existsSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {GeneralConnectionPlanSchema,GeneralConnectionRequestSchema,GeneralConnectionConsentSchema} from '../../../packages/protocol/src/general-connection.js';
import {GeneralAutomationProfileSchema,generalProfileHash} from '../../../packages/automation/src/general-profile.js';
import {GeneralJobScopeSchema} from '../../../packages/automation/src/background-scope.js';
import {inspectBackgroundAuthority} from '../../../packages/adapters/src/privy-background-policy.js';
import {createBackgroundActor} from '../../../packages/adapters/src/privy-background-actor.js';
import {createPrivyClient} from '../../../packages/adapters/src/privy-auth.js';
import {privateServiceDirectory,readPrivateServiceJson,writePrivateServiceJsonOnce} from '../../../scripts/create-privy-service-wallets.js';
import {ProviderIdSchema} from '../../../packages/protocol/src/day4-origin-types.js';
import type {BrowserApi} from './browser-api.js';
import {serveAuthenticatedJson} from './auth-json-api.js';
const actor=z.object({role:z.enum(['buyer','seller']),walletId:ProviderIdSchema,signerId:ProviderIdSchema,policyId:ProviderIdSchema,subject:z.string().min(1).max(512),authorizationPrivateKey:z.string().min(1).max(8192)}).strict();
export interface GeneralConnectionApi {auth:BrowserApi['auth'];state:(principal:import('../../../packages/adapters/src/privy-auth.js').Principal)=>Promise<unknown>;reserve:(input:unknown,principal:import('../../../packages/adapters/src/privy-auth.js').Principal)=>Promise<unknown>;check:(input:unknown,principal:import('../../../packages/adapters/src/privy-auth.js').Principal)=>Promise<unknown>;}
export function configuredGeneralConnectionApi(env:NodeJS.ProcessEnv,browser:BrowserApi|undefined,provider?:ReturnType<typeof createPrivyClient>):GeneralConnectionApi|undefined{
  const directory=env.AUTOMATION_DATA_DIRECTORY,d=browser?.configuration.recoveryDeployment;if(!directory||!browser||!d)return undefined;
  const client=provider??createPrivyClient({appId:env.PRIVY_APP_ID!,appSecret:env.PRIVY_APP_SECRET!}),ackDir=resolve(directory,'connection-consents');privateServiceDirectory(ackDir);
  const load=()=>{const plan=GeneralConnectionPlanSchema.parse(readPrivateServiceJson(resolve(directory,'connection-plan.json'))),pending=z.object({profile:GeneralAutomationProfileSchema,profileHash:z.string(),actors:z.tuple([actor,actor]),walletDelegationApproved:z.literal(false),localPlaintextProcessingApproved:z.literal(false)}).strict().parse(readPrivateServiceJson(resolve(directory,'connection-runtime-pending.json')));
    if(plan.profileHash!==pending.profileHash||generalProfileHash(pending.profile)!==plan.profileHash||!isDeepStrictEqual(pending.profile.deployment,d)||plan.amountLimit!==pending.profile.maxUnitsPerOrder||plan.expiresAt!==pending.profile.expiresAt||plan.asset.toLowerCase()!==d.asset.toLowerCase()||plan.arbiter.toLowerCase()!==d.arbiter.toLowerCase())throw Error('GENERAL_CONNECTION_PLAN_CHANGED');
    for(let i=0;i<2;i++){const r=plan.roles[i],a=pending.actors[i];if(a.role!==r.role||a.walletId!==r.walletId||a.signerId!==r.signerId||a.policyId!==r.policyId||r.address.toLowerCase()!==pending.profile[r.role].toLowerCase())throw Error('GENERAL_CONNECTION_PLAN_CHANGED');}return {plan,pending};};
  const scope=(pending:ReturnType<typeof load>['pending'])=>{const zero='0x'+'00'.repeat(32);return GeneralJobScopeSchema.parse({version:1,mode:'general-job',chainId:'10143',deployment:d,taskId:zero,datasetHash:zero,quoteId:null,buyer:pending.profile.buyer,seller:pending.profile.seller,payee:pending.profile.seller,maxTotalUnits:'1',maxOrders:1,expiresAt:String(Math.floor(Date.now()/1000)+3600),backup:'server-local-aes256gcm',profile:pending.profile,profileHash:pending.profileHash});};
  const verify=async(loaded:ReturnType<typeof load>)=>{const s=scope(loaded.pending);const connected:Record<string,boolean>={buyer:false,seller:false};for(const a of loaded.pending.actors){try{await inspectBackgroundAuthority(s,a,{wallet:id=>client.wallets().get(id),policy:id=>client.policies().get(id)});connected[a.role]=true;}catch{/* A missing or changed authority is not connected. */}}return {...loaded,connected};};
  const owned=(p:import('../../../packages/adapters/src/privy-auth.js').Principal,address:string)=>p.wallets.some(w=>w.toLowerCase()===address.toLowerCase());
  const consentSchema=GeneralConnectionConsentSchema.extend({subject:z.string().min(1).max(512),address:z.string()}).strict();
  const consentPresent=(loaded:ReturnType<typeof load>,role:'buyer'|'seller')=>{const path=resolve(ackDir,role+'.json');if(!existsSync(path))return false;const c=consentSchema.parse(readPrivateServiceJson(path)),r=loaded.plan.roles.find(r=>r.role===role)!;if(c.role!==role||c.planId!==loaded.plan.planId||c.profileHash!==loaded.plan.profileHash||c.address.toLowerCase()!==r.address.toLowerCase())throw Error('GENERAL_CONNECTION_CONSENT_CHANGED');return true;};
  const runtimeFor=(loaded:ReturnType<typeof load>)=>({...loaded.pending,walletDelegationApproved:true,localPlaintextProcessingApproved:true});
  const enabled=(l:Awaited<ReturnType<typeof verify>>)=>{const path=resolve(directory,'runtime.json');if(!l.connected.buyer||!l.connected.seller||!l.plan.roles.every(r=>consentPresent(l,r.role))||!existsSync(path))return false;if(!isDeepStrictEqual(readPrivateServiceJson(path),runtimeFor(l)))throw Error('GENERAL_CONNECTION_RUNTIME_CHANGED');return true;};
  const requested=(input:unknown,principal:import('../../../packages/adapters/src/privy-auth.js').Principal)=>{const request=GeneralConnectionRequestSchema.parse(input),l=load();if(request.planId!==l.plan.planId||request.profileHash!==l.plan.profileHash)throw Error('GENERAL_CONNECTION_PLAN_CHANGED');const role=l.plan.roles.find(r=>r.role===request.role)!;if(!owned(principal,role.address))throw Error('GENERAL_CONNECTION_OWNER_REQUIRED');return {request,l,role};};
  return {auth:browser.auth,state:async principal=>{if(!existsSync(resolve(directory,'connection-plan.json')))return {status:'PREPARATION_REQUIRED',mode:'general',amountLimit:null,expiresAt:null,canGrant:false};const loaded=load(),mine=loaded.plan.roles.filter(r=>owned(principal,r.address)).map(r=>r.role);if(!mine.length)throw Error('GENERAL_CONNECTION_OWNER_REQUIRED');const l=await verify(loaded);return {status:l.connected.buyer&&l.connected.seller?'CONNECTED':'OWNER_AUTHORIZATION_REQUIRED',plan:l.plan,connected:l.connected,ownedRoles:mine,enabled:enabled(l)};},reserve:async(input,principal)=>{
    const request=GeneralConnectionConsentSchema.parse(input),{l:loaded,role}=requested({planId:request.planId,profileHash:request.profileHash,role:request.role},principal),l=await verify(loaded);
    const path=resolve(ackDir,request.role+'.json'),record={...request,subject:principal.subject,address:role.address};if(existsSync(path)){if(!isDeepStrictEqual(readPrivateServiceJson(path),record))throw Error('GENERAL_CONNECTION_OWNER_CHANGED');return {created:false,status:l.connected[request.role]?'CONNECTED':'RECONCILE_ONLY'};}writePrivateServiceJsonOnce(path,record);return l.connected[request.role]?{created:false,status:'CONNECTED'}:{created:true,plan:l.plan};
  },check:async(input,principal)=>{
    const {request,l:loaded}=requested(input,principal),l=await verify(loaded);
    if(!l.connected[request.role])return {status:'PENDING_OR_UNAVAILABLE',connected:l.connected,enabled:false};
    if(l.connected.buyer&&l.connected.seller&&l.plan.roles.every(r=>consentPresent(l,r.role))){
      for(const a of l.pending.actors){const p=createBackgroundActor(client,scope(l.pending),a,()=>undefined,async()=>{throw Error('GENERAL_UNUSED_TOKEN');});try{await p.initialize();}finally{await p.logout();}}
      const runtime=runtimeFor(l),path=resolve(directory,'runtime.json');if(!existsSync(path))writePrivateServiceJsonOnce(path,runtime);else if(!isDeepStrictEqual(readPrivateServiceJson(path),runtime))throw Error('GENERAL_CONNECTION_RUNTIME_CHANGED');
    }
    return {status:'CONNECTED',connected:l.connected,enabled:enabled(l)};
  }};
}
export function serveGeneralConnection(req:IncomingMessage,res:ServerResponse,api:GeneralConnectionApi){return serveAuthenticatedJson(req,res,{auth:api.auth,failureCode:'GENERAL_CONNECTION_UNAVAILABLE',invoke:async(body,principal)=>{const r=z.object({action:z.enum(['state','reserve','check']),request:z.unknown().optional()}).strict().parse(body);return r.action==='state'?api.state(principal):r.action==='reserve'?api.reserve(r.request,principal):api.check(r.request,principal);}});}
