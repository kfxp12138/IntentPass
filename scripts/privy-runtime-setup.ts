import {createHash,createPrivateKey,createPublicKey,generateKeyPairSync,randomUUID} from 'node:crypto';
import {existsSync,readFileSync,lstatSync} from 'node:fs';
import {resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {getAddress} from 'viem';
import type {PrivyClient} from '@privy-io/node';
import {ProviderIdSchema} from '../packages/protocol/src/day4-origin-types.js';
import {escrowPolicy} from '../packages/adapters/src/privy-sender.js';
import {receiptPolicy} from '../packages/adapters/src/privy-receipt-signer.js';
import {semanticPrivyPolicyRules} from '../packages/adapters/src/privy-policy.js';
import {inspectPrivyRoles} from './privy-role-preparation.js';
import {parsePrivyServiceOwnerConfiguration,inspectPrivyServiceOwner,canonicalP256PublicKey,type PrivyServiceOwnerConfiguration,type PrivyServiceOwnerReadPort} from './privy-service-bootstrap.js';
import {canonicalServicePath,privateServiceDirectory,readPrivateServiceJson,writePrivateServiceJsonOnce} from './create-privy-service-wallets.js';

const roleNames=['reviewer','executor'] as const;
type RoleName=typeof roleNames[number];
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail=(code:string):never=>{throw Error('PRIVY_RUNTIME_'+code);};
const address=z.string().transform(value=>getAddress(value));
const roleSchema=z.object({walletId:ProviderIdSchema,initialPolicyId:ProviderIdSchema,address}).strict();
const configSchema=z.object({appId:z.string().min(1).max(128),chainId:z.literal('10143'),arbiter:address,model:z.string().regex(/^jev-\d+\.\d+\.\d+$/),questionConfigHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),roles:z.object({reviewer:roleSchema,executor:roleSchema}).strict()}).strict();
export type RuntimeConfig=z.infer<typeof configSchema>&{owner:PrivyServiceOwnerConfiguration};
type Material={planId:string;configurationHash:string;roles:Record<RoleName,{privateKey:string;publicKey:string;policyIdempotencyKey:string}>};
export interface RuntimePort extends PrivyServiceOwnerReadPort {
  createQuorum(input:{display_name:string;authorization_threshold:1;public_keys:string[]}):Promise<unknown>;
  quorum(id:string):Promise<unknown>;
  createPolicy(input:ReturnType<typeof receiptPolicy>|ReturnType<typeof escrowPolicy>,ownerId:string,idempotencyKey:string):Promise<unknown>;
  policy(id:string):Promise<unknown>;
  wallet(id:string):Promise<unknown>;
  addSigner(walletId:string,input:{additional_signers:{signer_id:string;override_policy_ids:string[]}[]}):Promise<unknown>;
}
function configuration(input:RuntimeConfig){const {owner,...rest}=input;const c=configSchema.parse(rest),o=parsePrivyServiceOwnerConfiguration(owner);if(c.roles.reviewer.address===c.roles.executor.address||c.roles.reviewer.walletId===c.roles.executor.walletId||c.roles.reviewer.initialPolicyId===c.roles.executor.initialPolicyId)fail('DISTINCT_ROLES_REQUIRED');return {...c,owner:o};}
function publicKey(privateKey:string){try{const key=createPrivateKey({key:Buffer.from(privateKey.replace(/^wallet-auth:/,''),'base64'),type:'pkcs8',format:'der'});if(key.asymmetricKeyDetails?.namedCurve!=='prime256v1')fail('KEY_INVALID');return createPublicKey(key).export({type:'spki',format:'der'}).toString('base64');}catch{return fail('KEY_INVALID');}}
/** Runtime signing material stays in a fixed private file and never enters a plan/report. */
export function prepareRuntimeSetup(root:string,input:RuntimeConfig){
  const c=configuration(input),configurationHash=hash(c),directory=resolve(root,'.tools/privy-runtime');privateServiceDirectory(directory);
  const path=resolve(directory,'material.json');
  if(!existsSync(path)){
    const role=()=>{const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});return {privateKey:'wallet-auth:'+pair.privateKey.export({type:'pkcs8',format:'der'}).toString('base64'),publicKey:pair.publicKey.export({type:'spki',format:'der'}).toString('base64'),policyIdempotencyKey:randomUUID()};};
    const material:Material={planId:randomUUID(),configurationHash,roles:{reviewer:role(),executor:role()}};
    try{writePrivateServiceJsonOnce(path,material);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  }
  const m=z.object({planId:z.uuid(),configurationHash:z.literal(configurationHash),roles:z.object({reviewer:z.object({privateKey:z.string(),publicKey:z.string(),policyIdempotencyKey:z.uuid()}).strict(),executor:z.object({privateKey:z.string(),publicKey:z.string(),policyIdempotencyKey:z.uuid()}).strict()}).strict()}).strict().parse(readPrivateServiceJson(path));
  for(const name of roleNames)if(publicKey(m.roles[name].privateKey)!==canonicalP256PublicKey(m.roles[name].publicKey))fail('KEY_MISMATCH');
  if(m.roles.reviewer.publicKey===m.roles.executor.publicKey||c.owner.operatorOwner.expectedPublicKeys.some(k=>roleNames.some(n=>m.roles[n].publicKey===k)))fail('MANAGEMENT_AND_RUNTIME_KEYS_NOT_SEPARATE');
  const policies={reviewer:receiptPolicy({chainId:c.chainId,arbiter:c.arbiter,address:c.roles.reviewer.address,model:c.model,questionConfigHash:c.questionConfigHash}),executor:escrowPolicy(c.chainId,c.arbiter)};
  return {schemaVersion:1 as const,planId:m.planId,configurationHash,configuration:c,roles:roleNames.map(role=>({role,...c.roles[role],publicKey:m.roles[role].publicKey,policyIdempotencyKey:m.roles[role].policyIdempotencyKey,policy:policies[role]})),walletSignaturesRequested:0,transactionsSent:0};
}
export function readOperatorAuthorization(root:string,owner:PrivyServiceOwnerConfiguration){
  const path=resolve(root,'.tools/privy-operator-authorization.key');canonicalServicePath(path);const s=lstatSync(path);if(!s.isFile()||s.nlink!==1||(s.mode&0o777)!==0o600||s.size>8192)fail('OPERATOR_KEY_FILE_INVALID');
  const key=readFileSync(path,'utf8').trim();if(owner.operatorOwner.authorizationThreshold!==1||!owner.operatorOwner.expectedPublicKeys.includes(publicKey(key)))fail('OPERATOR_KEY_MISMATCH');return key;
}
export function runtimePort(client:PrivyClient,operatorKey:string):RuntimePort {
  const quorums=client.keyQuorums(),policies=client.policies(),wallets=client.wallets();
  return Object.freeze({quorum:quorums.get.bind(quorums),createQuorum:quorums.create.bind(quorums),policy:policies.get.bind(policies),wallet:wallets.get.bind(wallets),
    createPolicy:(policy:ReturnType<typeof receiptPolicy>|ReturnType<typeof escrowPolicy>,ownerId:string,idempotencyKey:string)=>policies.create({...policy,owner_id:ownerId,idempotency_key:idempotencyKey}),
    addSigner:(walletId:string,input:{additional_signers:{signer_id:string;override_policy_ids:string[]}[]})=>wallets.update(walletId,{...input,authorization_context:{authorization_private_keys:[operatorKey]}})});
}
const policySchema=z.object({id:ProviderIdSchema,owner_id:ProviderIdSchema,version:z.literal('1.0'),chain_type:z.literal('ethereum'),rules:z.array(z.object({method:z.string(),action:z.string(),conditions:z.array(z.unknown())}).strip())}).strip();
const rules=(p:{rules:{method:string;action:string;conditions:unknown[]}[]})=>semanticPrivyPolicyRules(p.rules);
const walletSchema=z.object({id:ProviderIdSchema,address,owner_id:ProviderIdSchema,policy_ids:z.array(ProviderIdSchema),chain_type:z.literal('ethereum'),additional_signers:z.array(z.object({signer_id:ProviderIdSchema,override_policy_ids:z.array(ProviderIdSchema)}).strip()),archived_at:z.null().default(null),exported_at:z.null(),imported_at:z.null(),automations:z.array(z.unknown()).length(0).default([])}).strip();
export async function installRuntimeSetup(options:{root:string;config:RuntimeConfig;approved:boolean;port:RuntimePort;verifyDeployment:()=>Promise<void>;correctInvalidQuorumName?:boolean}){
  if(options.approved!==true)fail('APPROVAL_REQUIRED');const plan=prepareRuntimeSetup(options.root,options.config),binding=hash(plan),c=plan.configuration,ownerId=c.owner.operatorOwner.quorumId,port=options.port;
  await options.verifyDeployment();await inspectPrivyServiceOwner(c.owner,port);
  const directory=resolve(options.root,'.tools/privy-runtime/execution');privateServiceDirectory(directory);const activePath=resolve(directory,'active.json');
  const active={planId:plan.planId,binding};if(!existsSync(activePath)){try{writePrivateServiceJsonOnce(activePath,active);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}}
  if(!isDeepStrictEqual(readPrivateServiceJson(activePath),active))fail('ORIGINAL_PLAN_REQUIRED');
  const current=()=>{if(hash(prepareRuntimeSetup(options.root,options.config))!==binding)fail('PLAN_CHANGED');};
  let mutations=0,recoveredUpdates=0;
  const operation=async<T extends {id:string}>(step:string,request:unknown,mutate:()=>Promise<unknown>,check:(raw:unknown)=>T,get:(id:string)=>Promise<unknown>,recover?:()=>Promise<unknown>)=>{
    current();const reservation=resolve(directory,step+'.reserved.json'),response=resolve(directory,step+'.response.json');const record={binding,step,request};
    if(existsSync(reservation)){
      if(!isDeepStrictEqual(readPrivateServiceJson(reservation),record))fail('RESERVATION_MISMATCH');
      if(!existsSync(response)){
        if(!recover)return fail('OUTCOME_UNKNOWN');let observed:T;try{observed=check(await recover());}catch{return fail('OUTCOME_UNKNOWN');}
        writePrivateServiceJsonOnce(response,{binding,step,result:observed,recoveredByCurrentState:true});recoveredUpdates++;
      }
    }else{
      if(existsSync(response))fail('RECORD_INVALID');await inspectPrivyServiceOwner(c.owner,port);current();
      try{writePrivateServiceJsonOnce(reservation,record);}catch{return fail('OUTCOME_UNKNOWN');}
      let result:unknown;try{mutations++;result=await mutate();}catch(error){
        // Retain diagnostics privately; no raw provider error enters public output.
        try{const e=error as {status?:unknown;name?:unknown;message?:unknown;error?:unknown};const details={status:typeof e?.status==='number'?e.status:null,name:typeof e?.name==='string'?e.name:null,message:typeof e?.message==='string'?e.message.slice(0,8192):null,error:e?.error??null};if(Buffer.byteLength(JSON.stringify(details))<=16384)writePrivateServiceJsonOnce(resolve(directory,step+'.failure.json'),details);}catch{/* The original reservation still prevents a repeated mutation. */}
        return fail('OUTCOME_UNKNOWN');
      }
      try{const data=JSON.stringify(result);if(!data||Buffer.byteLength(data)>65536)fail('RESPONSE_TOO_LARGE');writePrivateServiceJsonOnce(response,{binding,step,result,recoveredByCurrentState:false});}catch{return fail('OUTCOME_UNKNOWN');}
    }
    const stored=z.object({binding:z.literal(binding),step:z.literal(step),result:z.unknown(),recoveredByCurrentState:z.boolean()}).strict().parse(readPrivateServiceJson(response));
    const original=check(stored.result);let actual:T;try{actual=check(await get(original.id));}catch{return fail('READ_OR_SCOPE_UNAVAILABLE');}if(!isDeepStrictEqual(original,actual))fail('RESOURCE_CHANGED');current();return actual;
  };
  const resultRoles:{role:RoleName;address:ReturnType<typeof getAddress>;walletId:string;initialPolicyId:string;policyId:string;signerId:string}[]=[];
  for(const role of plan.roles){
    const baseline=policySchema.parse(await port.policy(role.initialPolicyId));if(baseline.id!==role.initialPolicyId||baseline.owner_id!==ownerId||!isDeepStrictEqual(baseline.rules,[{method:'*',action:'DENY',conditions:[]}]))fail('INITIAL_POLICY_CHANGED');
    const before=walletSchema.parse(await port.wallet(role.walletId));if(before.id!==role.walletId||before.address!==role.address||before.owner_id!==ownerId||!isDeepStrictEqual(before.policy_ids,[role.initialPolicyId]))fail('INITIAL_WALLET_CHANGED');
    const patchReserved=existsSync(resolve(directory,role.role+'-delegate.reserved.json'));if(!patchReserved&&before.additional_signers.length)fail('UNEXPECTED_SIGNER');
    const quorumRequest={display_name:`IntentPass ${role.role} ${plan.planId.slice(0,8)}`,authorization_threshold:1 as const,public_keys:[role.publicKey]};
    // Published OpenAPI caps display_name at 50; SDK types omit this constraint.
    if(quorumRequest.display_name.length>50)fail('QUORUM_NAME_INVALID');
    let quorumStep=role.role+'-key';const oldReservationPath=resolve(directory,quorumStep+'.reserved.json');
    if(existsSync(oldReservationPath)&&!existsSync(resolve(directory,quorumStep+'.response.json'))){
      const previous=readPrivateServiceJson(oldReservationPath) as {binding?:string;step?:string;request?:unknown};
      const invalidOriginal={...quorumRequest,display_name:`IntentPass ${role.role} runtime ${plan.planId}`};
      if(previous.binding===binding&&previous.step===quorumStep&&isDeepStrictEqual(previous.request,invalidOriginal)&&invalidOriginal.display_name.length>50){
        const correctionPath=resolve(directory,quorumStep+'.name-correction.json');
        if(!options.correctInvalidQuorumName&&!existsSync(correctionPath))fail('INVALID_NAME_CORRECTION_REQUIRED');
        const correction={binding,step:quorumStep,reason:'ORIGINAL_REQUEST_VIOLATES_PUBLISHED_DISPLAY_NAME_MAX_50',source:'https://docs.privy.io/api-reference/key-quorums/create',originalRequest:invalidOriginal,correctedRequest:quorumRequest,originalProviderOutcome:'UNKNOWN',originalReservationPreserved:true};
        if(!existsSync(correctionPath))writePrivateServiceJsonOnce(correctionPath,correction);else if(!isDeepStrictEqual(readPrivateServiceJson(correctionPath),correction))fail('CORRECTION_MISMATCH');
        // A separately recorded schema correction, never release the old slot or
        // assume that its original HTTP result was captured. One valid attempt only.
        quorumStep=role.role+'-key-name-correction';
      }
    }
    const checkQuorum=(raw:unknown)=>{const q=z.object({id:ProviderIdSchema,authorization_threshold:z.literal(1),authorization_keys:z.array(z.object({public_key:z.string()}).strip()).length(1),user_ids:z.array(z.string()).length(0).nullable(),key_quorum_ids:z.array(z.string()).length(0).optional()}).strip().parse(raw);if(q.authorization_keys[0].public_key!==role.publicKey)fail('RUNTIME_KEY_MISMATCH');return {id:q.id,publicKey:role.publicKey,threshold:1};};
    const quorum=await operation(quorumStep,quorumRequest,()=>port.createQuorum(quorumRequest),checkQuorum,id=>port.quorum(id));
    const policyRequest={...role.policy,owner_id:ownerId,idempotency_key:role.policyIdempotencyKey};
    const checkPolicy=(raw:unknown)=>{const p=policySchema.parse(raw),normalized=rules(p);if(p.owner_id!==ownerId||!isDeepStrictEqual(normalized,rules(role.policy)))fail('POLICY_SCOPE_CHANGED');return {...p,rules:normalized};};
    const policy=await operation(role.role+'-policy',policyRequest,()=>port.createPolicy(role.policy,ownerId,role.policyIdempotencyKey),checkPolicy,id=>port.policy(id));
    const patch={additional_signers:[{signer_id:quorum.id,override_policy_ids:[policy.id]}]};
    const checkWallet=(raw:unknown)=>{const w=walletSchema.parse(raw);if(w.id!==role.walletId||w.address!==role.address||w.owner_id!==ownerId||!isDeepStrictEqual(w.policy_ids,[role.initialPolicyId])||!isDeepStrictEqual(w.additional_signers,patch.additional_signers))fail('WALLET_SCOPE_CHANGED');return w;};
    await operation(role.role+'-delegate',patch,()=>port.addSigner(role.walletId,patch),checkWallet,id=>port.wallet(id),()=>port.wallet(role.walletId));
    resultRoles.push({role:role.role,address:role.address,walletId:role.walletId,initialPolicyId:role.initialPolicyId,policyId:policy.id,signerId:quorum.id});
  }
  const role=(name:RoleName)=>resultRoles.find(r=>r.role===name)!;
  await inspectPrivyRoles({assetMode:'demo-erc20',chainId:c.chainId,arbiter:c.arbiter,model:c.model,questionConfigHash:c.questionConfigHash,reviewer:{address:role('reviewer').address,walletId:role('reviewer').walletId,policyId:role('reviewer').policyId,signerId:role('reviewer').signerId},executor:{address:role('executor').address,walletId:role('executor').walletId,policyId:role('executor').policyId,signerId:role('executor').signerId}},port);
  await inspectPrivyServiceOwner(c.owner,port);await options.verifyDeployment();current();
  const summary={planId:plan.planId,binding,roles:resultRoles,arbiter:c.arbiter,delegatedScopeVerified:true,managementKeySeparate:true};const path=resolve(directory,'verified.json');if(!existsSync(path))writePrivateServiceJsonOnce(path,summary);else if(!isDeepStrictEqual(readPrivateServiceJson(path),summary))fail('RECORD_INVALID');
  return {...summary,mutationsThisRun:mutations,recoveredUpdates,walletSignaturesRequested:0,transactionsSent:0};
}
