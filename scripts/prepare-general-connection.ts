import {generateKeyPairSync,createPrivateKey,createPublicKey,randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {GeneralAutomationProfileSchema,generalProfileHash} from '../packages/automation/src/general-profile.js';
import {GeneralJobScopeSchema} from '../packages/automation/src/background-scope.js';
import {backgroundActorPolicy} from '../packages/adapters/src/privy-background-policy.js';
import {semanticPrivyPolicyRules} from '../packages/adapters/src/privy-policy.js';
import {GeneralConnectionPlanSchema} from '../packages/protocol/src/general-connection.js';
import {ProviderIdSchema} from '../packages/protocol/src/day4-origin-types.js';
import {privateServiceDirectory,writePrivateServiceJsonOnce,readPrivateServiceJson} from './create-privy-service-wallets.js';
import {parsePrivyServiceOwnerConfiguration} from './privy-service-bootstrap.js';
import {readPrivyServiceOwnerConfiguration} from './prepare-privy-service-wallets.js';
import {configuredBrowserApi} from '../apps/web/src/browser-api.js';
import {createPrivyClient} from '../packages/adapters/src/privy-auth.js';
import {correctedGeneralPolicyRequest} from './general-policy-format-correction.js';

const materialSchema=z.object({version:z.literal(1),planId:z.uuid(),profileHash:z.string(),roles:z.tuple([z.object({role:z.literal('buyer'),privateKey:z.string(),publicKey:z.string(),policyKey:z.uuid()}).strict(),z.object({role:z.literal('seller'),privateKey:z.string(),publicKey:z.string(),policyKey:z.uuid()}).strict()])}).strict();
export async function prepareGeneralConnection(directory:string,env:NodeJS.ProcessEnv,port?:ReturnType<typeof createPrivyClient>){
  const d=configuredBrowserApi(env)?.configuration.recoveryDeployment;if(!d||d.chainId!=='10143'||env.SETTLEMENT_ASSET_MODE!=='demo-erc20')throw Error('GENERAL_CONNECTION_CONFIGURATION_REQUIRED');
  privateServiceDirectory(directory);const owner=parsePrivyServiceOwnerConfiguration(readPrivyServiceOwnerConfiguration()),profile=GeneralAutomationProfileSchema.parse({version:1,mode:'general',enabled:true,name:'IntentPass 通用后台',deployment:d,buyer:d.committee[0],seller:d.committee[1],maxUnitsPerOrder:null,expiresAt:null}),profileHash=generalProfileHash(profile);
  const materialPath=resolve(directory,'connection-material.json');
  if(!existsSync(materialPath)){const key=(role:'buyer'|'seller')=>{const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});return {role,privateKey:'wallet-auth:'+pair.privateKey.export({type:'pkcs8',format:'der'}).toString('base64'),publicKey:pair.publicKey.export({type:'spki',format:'der'}).toString('base64'),policyKey:randomUUID()};};writePrivateServiceJsonOnce(materialPath,{version:1,planId:randomUUID(),profileHash,roles:[key('buyer'),key('seller')]});}
  const material=materialSchema.parse(readPrivateServiceJson(materialPath));if(material.profileHash!==profileHash)throw Error('GENERAL_CONNECTION_PROFILE_CHANGED');
  for(const role of material.roles){const privateKey=createPrivateKey({key:Buffer.from(role.privateKey.replace(/^wallet-auth:/,''),'base64'),format:'der',type:'pkcs8'});if(privateKey.asymmetricKeyDetails?.namedCurve!=='prime256v1'||createPublicKey(privateKey).export({format:'der',type:'spki'}).toString('base64')!==role.publicKey)throw Error('GENERAL_CONNECTION_KEY_MISMATCH');}
  const client=port??createPrivyClient({appId:env.PRIVY_APP_ID!,appSecret:env.PRIVY_APP_SECRET!}),wallets=new Map<string,{id:string;ownerId:string;address:string}>();let reads=0;
  for await(const wallet of client.wallets().list()){if(++reads>500)throw Error('GENERAL_CONNECTION_LOOKUP_LIMIT');for(const role of ['buyer','seller'] as const)if(wallet.address.toLowerCase()===profile[role].toLowerCase()){if(wallets.has(role)||!wallet.owner_id)throw Error('GENERAL_CONNECTION_WALLET_AMBIGUOUS');wallets.set(role,{id:wallet.id,ownerId:wallet.owner_id,address:wallet.address});}}
  if(wallets.size!==2)throw Error('GENERAL_CONNECTION_WALLET_REQUIRED');
  const journal=resolve(directory,'connection-registration');privateServiceDirectory(journal);
  const operation=async(step:string,request:unknown,create:()=>Promise<unknown>,get:(id:string)=>Promise<unknown>,check:(raw:unknown)=>{id:string})=>{
    const reserved=resolve(journal,step+'-reserved.json'),response=resolve(journal,step+'-response.json');
    if(!existsSync(reserved)){writePrivateServiceJsonOnce(reserved,{profileHash,request});let result:unknown;try{result=await create();}catch(error){const e=error as {status?:unknown;error?:unknown};writePrivateServiceJsonOnce(resolve(journal,step+'-failure.json'),{httpStatus:typeof e?.status==='number'?e.status:null,providerError:e?.error??null});throw Error('GENERAL_CONNECTION_REGISTRATION_OUTCOME_UNKNOWN');}writePrivateServiceJsonOnce(response,{result:check(result)});}
    if(!isDeepStrictEqual(readPrivateServiceJson(reserved),{profileHash,request})||!existsSync(response))throw Error('GENERAL_CONNECTION_REGISTRATION_OUTCOME_UNKNOWN');
    const result=z.object({result:z.object({id:ProviderIdSchema}).passthrough()}).strict().parse(readPrivateServiceJson(response)).result;if(check(await get(result.id)).id!==result.id)throw Error('GENERAL_CONNECTION_RESOURCE_CHANGED');return result.id;
  };
  const dummy='0x'+'00'.repeat(32),scope=GeneralJobScopeSchema.parse({version:1,mode:'general-job',chainId:'10143',deployment:d,taskId:dummy,datasetHash:dummy,quoteId:null,buyer:profile.buyer,seller:profile.seller,payee:profile.seller,maxTotalUnits:'1',maxOrders:1,expiresAt:String(Math.floor(Date.now()/1000)+3600),backup:'server-local-aes256gcm',profile,profileHash});
  const configs=[],roles=[];
  for(const role of material.roles){
    const quorumRequest={display_name:role.role==='buyer'?'IPGenBuyer':'IPGenSeller',authorization_threshold:1 as const,public_keys:[role.publicKey]};
    const signerId=await operation(role.role+'-quorum',quorumRequest,()=>client.keyQuorums().create(quorumRequest),id=>client.keyQuorums().get(id),raw=>{const q=z.object({id:ProviderIdSchema,authorization_threshold:z.literal(1),authorization_keys:z.array(z.object({public_key:z.literal(role.publicKey)}).passthrough()).length(1),user_ids:z.array(z.string()).length(0).nullable(),key_quorum_ids:z.array(z.string()).length(0).optional()}).passthrough().parse(raw);return {id:q.id};});
    const policy=backgroundActorPolicy(scope,role.role),request={...policy,owner_id:owner.operatorOwner.quorumId,idempotency_key:role.policyKey};
    const corrected=correctedGeneralPolicyRequest(journal,role.role,request,profileHash);
    const policyId=await operation(corrected.step,corrected.request,()=>client.policies().create(corrected.request as Parameters<ReturnType<typeof client.policies>['create']>[0]),id=>client.policies().get(id),raw=>{const p=z.object({id:ProviderIdSchema,owner_id:z.literal(owner.operatorOwner.quorumId),version:z.literal('1.0'),chain_type:z.literal('ethereum'),rules:z.array(z.unknown())}).passthrough().parse(raw);if(!isDeepStrictEqual(semanticPrivyPolicyRules(p.rules as typeof policy.rules),semanticPrivyPolicyRules(policy.rules)))throw Error('GENERAL_CONNECTION_POLICY_MISMATCH');return {id:p.id};});
    const wallet=wallets.get(role.role)!;configs.push({role:role.role,walletId:wallet.id,signerId,policyId,subject:wallet.ownerId,authorizationPrivateKey:role.privateKey});roles.push({role:role.role,address:wallet.address,walletId:wallet.id,signerId,policyId});
  }
  const plan=GeneralConnectionPlanSchema.parse({version:1,planId:material.planId,profileHash,mode:'general',chainId:'10143',asset:d.asset,arbiter:d.arbiter,amountLimit:null,expiresAt:null,roles});
  for(const [file,data] of [['connection-plan.json',plan],['connection-runtime-pending.json',{profile,profileHash,actors:configs,walletDelegationApproved:false,localPlaintextProcessingApproved:false}]] as const){const path=resolve(directory,file);if(!existsSync(path))writePrivateServiceJsonOnce(path,data);else if(!isDeepStrictEqual(readPrivateServiceJson(path),data))throw Error('GENERAL_CONNECTION_PLAN_CHANGED');}
  return {plan,status:'OWNER_AUTHORIZATION_REQUIRED' as const,walletsChanged:0,signaturesRequested:0,transactionsSent:0};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{const result=await prepareGeneralConnection(resolve(process.env.AUTOMATION_DATA_DIRECTORY??'.tools/general-automation'),process.env);console.log(JSON.stringify({status:result.status,planId:result.plan.planId,profileHash:result.plan.profileHash,amountLimit:null,expiresAt:null,roles:result.plan.roles.map(r=>({role:r.role,address:r.address})),walletsChanged:0,signaturesRequested:0,transactionsSent:0}));}catch(error){console.error(JSON.stringify({status:'BLOCKED',code:error instanceof Error&&/^GENERAL_CONNECTION_[A-Z_]+$/.test(error.message)?error.message:'GENERAL_CONNECTION_SETUP_UNAVAILABLE',retryCreationAllowed:false,walletsChanged:0,transactionsSent:0}));process.exitCode=1;}}
