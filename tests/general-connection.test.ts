import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,existsSync,writeFileSync} from 'node:fs';
import {generateKeyPairSync} from 'node:crypto';
import type {PrivyClient} from '@privy-io/node';
import type {Principal} from '../packages/adapters/src/privy-auth.js';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {configuredGeneralConnectionApi} from '../apps/web/src/general-connection-api.js';
import {BrowserSession,type BrowserAuthPort} from '../apps/web/src/browser-session.js';
import {GeneralConnectionPlanSchema,GeneralConnectionConsentSchema} from '../packages/protocol/src/general-connection.js';
import {readTestAddress} from './support/original-authorization.js';
import {writePrivateServiceJsonOnce,readPrivateServiceJson} from '../scripts/create-privy-service-wallets.js';
import {GeneralAutomationProfileSchema,generalProfileHash} from '../packages/automation/src/general-profile.js';
import {GeneralJobScopeSchema} from '../packages/automation/src/background-scope.js';
import {backgroundActorPolicy} from '../packages/adapters/src/privy-background-policy.js';
const configuration={privyAppId:'local-test',meraRpId:null,recoveryDeployment:{chainId:'10143' as const,arbiter:readTestAddress(9),asset:readTestAddress(8),reviewer:readTestAddress(7),committee:[readTestAddress(1),readTestAddress(2),readTestAddress(3)] as [string,string,string],executor:readTestAddress(4)}};
const plan=GeneralConnectionPlanSchema.parse({version:1,planId:'00000000-0000-4000-8000-000000000001',profileHash:'a'.repeat(64),mode:'general',chainId:'10143',asset:configuration.recoveryDeployment.asset,arbiter:configuration.recoveryDeployment.arbiter,amountLimit:null,expiresAt:null,roles:[{role:'buyer',address:readTestAddress(1),walletId:'buyer-wallet',signerId:'buyer-signer',policyId:'buyer-policy'},{role:'seller',address:readTestAddress(2),walletId:'seller-wallet',signerId:'seller-signer',policyId:'seller-policy'}]});
test('initial delegation requires explicit general scope and local processing consent, with strict public-only plan',()=>{
  assert.throws(()=>GeneralConnectionConsentSchema.parse({planId:plan.planId,profileHash:plan.profileHash,role:'buyer'}));
  assert.throws(()=>GeneralConnectionPlanSchema.parse({...plan,authorizationPrivateKey:'never-in-browser'}));
  assert.equal(GeneralConnectionConsentSchema.parse({planId:plan.planId,profileHash:plan.profileHash,role:'buyer',confirmGeneralAuthority:true,localPlaintextProcessingApproved:true}).confirmGeneralAuthority,true);
});
// Disposable local fixtures only: no provider registration, wallet update,
// signature or network request. Test keys never enter the real runtime directory.
function preparedFixture(){
  const directory=mkdtempSync(resolve(realpathSync(tmpdir()),'intentpass-general-fixture-'));
  const profile=GeneralAutomationProfileSchema.parse({version:1,mode:'general',enabled:true,name:'local fixture',deployment:configuration.recoveryDeployment,buyer:readTestAddress(1),seller:readTestAddress(2),maxUnitsPerOrder:null,expiresAt:null}),profileHash=generalProfileHash(profile),publicPlan={...plan,profileHash};
  const publicKeys=new Map<string,string>();const actors=publicPlan.roles.map(r=>{const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});publicKeys.set(r.signerId,pair.publicKey.export({format:'der',type:'spki'}).toString('base64'));return {role:r.role,walletId:r.walletId,signerId:r.signerId,policyId:r.policyId,subject:'local-wallet-owner-'+r.role,authorizationPrivateKey:'wallet-auth:'+pair.privateKey.export({format:'der',type:'pkcs8'}).toString('base64')};});
  writePrivateServiceJsonOnce(resolve(directory,'connection-plan.json'),publicPlan);const pending={profile,profileHash,actors,walletDelegationApproved:false,localPlaintextProcessingApproved:false};writePrivateServiceJsonOnce(resolve(directory,'connection-runtime-pending.json'),pending);
  const zero='0x'+'00'.repeat(32),scope=GeneralJobScopeSchema.parse({version:1,mode:'general-job',chainId:'10143',deployment:configuration.recoveryDeployment,taskId:zero,datasetHash:zero,quoteId:null,buyer:profile.buyer,seller:profile.seller,payee:profile.seller,maxTotalUnits:'1',maxOrders:1,expiresAt:String(Math.floor(Date.now()/1000)+3600),backup:'server-local-aes256gcm',profile,profileHash});
  const delegated=new Set<string>();let reads=0;
  const client={wallets:()=>({get:async(id:string)=>{reads++;const r=publicPlan.roles.find(r=>r.walletId===id)!;return {id,address:r.address,owner_id:'local-wallet-owner-'+r.role,chain_type:'ethereum',archived_at:null,additional_signers:delegated.has(r.role)?[{signer_id:r.signerId,override_policy_ids:[r.policyId]}]:[]};},ethereum:()=>({})}),policies:()=>({get:async(id:string)=>{reads++;const r=publicPlan.roles.find(r=>r.policyId===id)!;return {id,...backgroundActorPolicy(scope,r.role)};}}),keyQuorums:()=>({get:async(id:string)=>({authorization_threshold:1,authorization_keys:[{public_key:publicKeys.get(id)}],user_ids:[],key_quorum_ids:[]})})} as unknown as PrivyClient;
  const api=configuredGeneralConnectionApi({AUTOMATION_DATA_DIRECTORY:directory},{configuration,auth:{authenticate:async()=>{throw Error('unused');}}},client)!;
  const principal=(role:'buyer'|'seller'):Principal=>({subject:'local-user-'+role,wallets:[profile[role] as `0x${string}`]});const request=(role:'buyer'|'seller')=>({planId:publicPlan.planId,profileHash,role});const consent=(role:'buyer'|'seller')=>({...request(role),confirmGeneralAuthority:true,localPlaintextProcessingApproved:true});
  return {directory,api,delegated,pending,principal,request,consent,reads:()=>reads,close:()=>rmSync(directory,{recursive:true,force:true})};
}
test('owner isolation and immutable reservation keep unknown updates in reconciliation without activating the runtime',async()=>{
  const f=preparedFixture();try{const outsider={subject:'local-outsider',wallets:[readTestAddress(5)]};await assert.rejects(f.api.state(outsider),/OWNER_REQUIRED/);await assert.rejects(f.api.reserve(f.consent('buyer'),outsider),/OWNER_REQUIRED/);assert.equal(f.reads(),0);
    assert.equal((await f.api.reserve(f.consent('buyer'),f.principal('buyer')) as {created:boolean}).created,true);assert.deepEqual(await f.api.reserve(f.consent('buyer'),f.principal('buyer')),{created:false,status:'RECONCILE_ONLY'});await assert.rejects(f.api.reserve(f.consent('buyer'),{...f.principal('buyer'),subject:'changed'}),/OWNER_CHANGED/);
    assert.equal((await f.api.check(f.request('buyer'),f.principal('buyer')) as {enabled:boolean}).enabled,false);assert.equal(existsSync(resolve(f.directory,'runtime.json')),false);
  }finally{f.close();}
});
test('both original delegates, both explicit consents and both matching key quorums are required for activation',async()=>{
  const f=preparedFixture();try{await f.api.reserve(f.consent('buyer'),f.principal('buyer'));f.delegated.add('buyer');assert.equal((await f.api.check(f.request('buyer'),f.principal('buyer')) as {enabled:boolean}).enabled,false);f.delegated.add('seller');assert.equal((await f.api.check(f.request('buyer'),f.principal('buyer')) as {enabled:boolean}).enabled,false);
    // A confirmed pre-existing owner connection records consent without re-adding it.
    assert.deepEqual(await f.api.reserve(f.consent('seller'),f.principal('seller')),{created:false,status:'CONNECTED'});assert.equal((await f.api.check(f.request('seller'),f.principal('seller')) as {enabled:boolean}).enabled,true);
    assert.deepEqual(readPrivateServiceJson(resolve(f.directory,'runtime.json')),{...f.pending,walletDelegationApproved:true,localPlaintextProcessingApproved:true});const publicState=await f.api.state(f.principal('buyer'));assert.equal(JSON.stringify(publicState).includes('authorizationPrivateKey'),false);
    f.delegated.delete('seller');assert.equal((await f.api.state(f.principal('buyer')) as {enabled:boolean}).enabled,false);
  }finally{f.close();}
});
test('changed public actor IDs and mismatched consent records cannot enable background access',async()=>{
  const f=preparedFixture();try{await f.api.reserve(f.consent('buyer'),f.principal('buyer'));await f.api.reserve(f.consent('seller'),f.principal('seller'));f.delegated.add('buyer');f.delegated.add('seller');
    const path=resolve(f.directory,'connection-consents/seller.json'),old=readPrivateServiceJson(path) as Record<string,unknown>;writeFileSync(path,JSON.stringify({...old,profileHash:'b'.repeat(64)}));await assert.rejects(f.api.check(f.request('buyer'),f.principal('buyer')),/CONSENT_CHANGED/);assert.equal(existsSync(resolve(f.directory,'runtime.json')),false);
    const planPath=resolve(f.directory,'connection-plan.json'),original=readPrivateServiceJson(planPath) as typeof plan;writeFileSync(planPath,JSON.stringify({...original,roles:[{...original.roles[0],signerId:'changed'},original.roles[1]]}));await assert.rejects(f.api.state(f.principal('buyer')),/PLAN_CHANGED/);
  }finally{f.close();}
});
test('owner session rejects absent confirmation or wrong account before the SDK and invalidates late owner updates on logout',async()=>{
  let calls=0,release!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>{entered=r;}),wait=new Promise<void>(r=>{release=r;});let slow=false;
  const port:BrowserAuthPort={initialize:async()=>{},sendCode:async()=>{},login:async()=>{},token:async()=>'local-token',logout:async()=>{},connectGeneralWallet:async(_input,role,active)=>{calls++;assert.equal(role,'buyer');if(slow){entered();await wait;}active();return {status:'OWNER_REQUEST_COMPLETED'};}};
  const session=new BrowserSession(async()=>port,async path=>new Response(JSON.stringify(path==='/api/config'?configuration:{subject:'local-buyer',wallets:[readTestAddress(1)]})));
  await assert.rejects(session.connectGeneral(plan,'buyer',false),/CONFIRMATION_REQUIRED/);await assert.rejects(session.connectGeneral(plan,'seller',true),/OWNER_REQUIRED/);assert.equal(calls,0);
  assert.equal((await session.connectGeneral(plan,'buyer',true)).status,'OWNER_REQUEST_COMPLETED');assert.equal(calls,1);
  slow=true;const pending=session.connectGeneral(plan,'buyer',true);await started;await session.logout();release();await assert.rejects(pending,/SESSION_CHANGED/);
});
test('missing prepared resources remain read-only and do not claim owner connection or expose secrets',async()=>{
  const directory=mkdtempSync(resolve(realpathSync(tmpdir()),'intentpass-general-connect-'));
  try{const api=configuredGeneralConnectionApi({AUTOMATION_DATA_DIRECTORY:directory,PRIVY_APP_ID:'local-test',PRIVY_APP_SECRET:'local-synthetic-secret'},{configuration,auth:{authenticate:async()=>({subject:'local-user',wallets:[readTestAddress(1)]})}})!;
    assert.deepEqual(await api.state({subject:'local-user',wallets:[readTestAddress(1)]}),{status:'PREPARATION_REQUIRED',mode:'general',amountLimit:null,expiresAt:null,canGrant:false});
  }finally{rmSync(directory,{recursive:true,force:true});}
});
