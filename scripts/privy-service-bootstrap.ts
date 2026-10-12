import {createPublicKey,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {PrivyClient} from '@privy-io/node';
import {z} from 'zod';
import {ProviderIdSchema} from '../packages/protocol/src/day4-origin-types.js';

export const privyServiceBootstrapSources=[
  'https://docs.privy.io/controls/policies/example-policies/ethereum#deny-all-requests',
  'https://docs.privy.io/controls/policies/overview',
  'https://docs.privy.io/controls/policies/create-a-policy',
  'https://docs.privy.io/controls/authorization-keys/using-owners/assign',
  'https://docs.privy.io/controls/authorization-keys/keys/create/key',
  'https://docs.privy.io/controls/key-quorum/create',
] as const;
export const privyServiceBootstrapSourceFacts=[
  'The official deny-all example uses method *, no conditions, and action DENY.',
  'Policies cover signing, transactions and key export; unresolved methods default to DENY.',
  'Ownerless policies can be changed using the application secret; owned policies require owner authorization.',
  'Resource owner_id is a real key-quorum identifier; owner and owner_id are mutually exclusive.',
  'Authorization public keys are P-256 SPKI DER; authorization private keys are PKCS8 DER, not wallet private keys.',
  'Pinned Node SDK 0.35 supports policy and wallet creation idempotency for a 24-hour window; quorum creation has no pinned idempotency input.',
] as const;
export class PrivyServiceBootstrapError extends Error {
  constructor(code:string,readonly readCallsAttempted=0){super(code);}
}
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const invalid=():never=>{throw new PrivyServiceBootstrapError('PRIVY_SERVICE_OWNER_CONFIGURATION_INVALID');};
/** Accept a canonical public SPKI only. Private keys and alternate curves never enter a plan. */
export function canonicalP256PublicKey(value:string):string {
  try{
    if(value.length>256||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))return invalid();
    const bytes=Buffer.from(value,'base64');if(bytes.toString('base64')!==value)return invalid();
    const key=createPublicKey({key:bytes,format:'der',type:'spki'});
    if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1')return invalid();
    const exported=key.export({format:'der',type:'spki'});if(!exported.equals(bytes))return invalid();return value;
  }catch{return invalid();}
}
const publicKey=z.string().min(1).max(256).transform(canonicalP256PublicKey);
const keys=z.array(publicKey).min(1).max(16).refine(value=>new Set(value).size===value.length);
export const PrivyServiceOwnerConfigurationSchema=z.object({schemaVersion:z.literal(1),assetMode:z.literal('demo-erc20'),chainId:z.literal('10143'),
  operatorOwner:z.object({quorumId:ProviderIdSchema,expectedPublicKeys:keys,authorizationThreshold:z.number().int().min(1).max(16)}).strict(),
}).strict().superRefine((value,context)=>{if(value.operatorOwner.authorizationThreshold>value.operatorOwner.expectedPublicKeys.length)
  context.addIssue({code:'custom',message:'OWNER_THRESHOLD_INVALID'});});
export type PrivyServiceOwnerConfiguration=z.infer<typeof PrivyServiceOwnerConfigurationSchema>;
const app=z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export function parsePrivyServiceOwnerConfiguration(input:unknown):PrivyServiceOwnerConfiguration {
  try{return freeze(PrivyServiceOwnerConfigurationSchema.parse(structuredClone(input)));}catch{return invalid();}
}

/** A private, application-bound graph of future requests. This module has no mutation port. */
export function preparePrivyServiceBootstrap(input:unknown,appId:string,planId:string=randomUUID()){
  const config=parsePrivyServiceOwnerConfiguration(input);
  try{app.parse(appId);z.uuid().parse(planId);}catch{return invalid();}
  const roles=(['reviewer','executor'] as const).map(role=>{
    const policyStepId=`${role}-initial-policy`;
    return {role,policyCreate:{stepId:policyStepId,resource:'policies' as const,operation:'create' as const,
      request:({version:'1.0' as const,chain_type:'ethereum' as const,name:`IntentPass ${role} bootstrap deny all`,owner_id:config.operatorOwner.quorumId,
        rules:[{name:'Deny all requests',method:'*' as const,action:'DENY' as const,conditions:[] as never[]}],idempotency_key:randomUUID()}) satisfies Parameters<ReturnType<PrivyClient['policies']>['create']>[0]},
      walletCreate:{stepId:`${role}-initial-wallet`,resource:'wallets' as const,operation:'create' as const,
        request:({chain_type:'ethereum' as const,owner_id:config.operatorOwner.quorumId,additional_signers:[] as never[],
          display_name:`IntentPass ${role} bootstrap`,external_id:`ip-${planId}-${role}`,idempotency_key:randomUUID()}) satisfies Omit<Parameters<ReturnType<PrivyClient['wallets']>['create']>[0],'policy_ids'>,
        policyIdsFrom:{stepId:policyStepId,field:'id' as const,requiredResult:'VERIFIED_CREATED_POLICY' as const,cardinality:1 as const}}};
  });
  return freeze({schemaVersion:1 as const,scope:'OFFLINE_OPERATOR_OWNED_PRIVY_SERVICE_WALLET_BOOTSTRAP_NO_EXECUTOR' as const,
    planId,appId,configuration:config,roles,arbiter:null,runtimeSignerAssigned:false as const,operatorOwnershipRetained:true as const,
    policyInstallationVerified:false as const,authorizationKeyPossessionVerified:false as const,canExecute:false as const,
    financialAcceptanceStatus:'BLOCKED' as const,walletsCreated:0 as const,policiesCreated:0 as const,policiesChanged:0 as const,
    signaturesRequested:0 as const,transactionsSent:0 as const,
    requirements:['Explicit approval of this exact application-bound plan is required before any future creation.',
      'A future executor must resolve each policy reference only from its original verified create result, never a guessed identifier.',
      'Reserve original role operations durably before any API mutation; preserve idempotency keys and unknown results across restart.',
      'A missing response never authorizes a fresh create; the SDK documents a finite 24-hour creation idempotency window.',
      'This module cannot create, install, update, delegate, export, sign or send anything.',
      'Only a verified deployed arbiter can authorize a later separate narrow runtime-signer plan; operator ownership remains separate.']});
}
export interface PrivyServiceOwnerReadPort {quorum(id:string):Promise<unknown>;}
/** Capture only the existing quorum GET capability, never a create or update method. */
export function privyServiceOwnerReadPort(client:PrivyClient):PrivyServiceOwnerReadPort {
  let get:(id:string)=>Promise<unknown>;
  try{const quorums=client.keyQuorums();get=quorums.get.bind(quorums);}catch{throw new PrivyServiceBootstrapError('PRIVY_SERVICE_OWNER_PORT_INVALID');}
  return Object.freeze({quorum:async(id:string)=>{if(!ProviderIdSchema.safeParse(id).success)throw new PrivyServiceBootstrapError('PRIVY_SERVICE_OWNER_IDENTIFIER_INVALID');return get(id);}});
}
const observedQuorum=z.object({id:ProviderIdSchema,authorization_keys:z.array(z.object({public_key:publicKey}).strip()).min(1).max(16),
  authorization_threshold:z.number().int().min(1).max(16),user_ids:z.array(z.string()).max(0).nullable(),
  key_quorum_ids:z.array(z.string()).max(0).optional()}).strip();
/** Two stable metadata reads. This cannot establish private-key possession or runtime multisig support. */
export async function inspectPrivyServiceOwner(input:unknown,port:PrivyServiceOwnerReadPort){
  const config=parsePrivyServiceOwnerConfiguration(input),owner=config.operatorOwner;let readCallsAttempted=0;
  const fail=(code:string):never=>{throw new PrivyServiceBootstrapError(code,readCallsAttempted);};
  let read:(id:string)=>Promise<unknown>;try{read=port.quorum.bind(port);}catch{return fail('PRIVY_SERVICE_OWNER_PORT_INVALID');}
  const current=async()=>{
    readCallsAttempted++;let raw;try{raw=await read(owner.quorumId);}catch{return fail('PRIVY_SERVICE_OWNER_READ_UNAVAILABLE');}
    let quorum;try{quorum=observedQuorum.parse(raw);}catch{return fail('PRIVY_SERVICE_OWNER_METADATA_INVALID');}
    const actualKeys=quorum.authorization_keys.map(key=>key.public_key).sort(),expectedKeys=[...owner.expectedPublicKeys].sort();
    if(quorum.id!==owner.quorumId||quorum.authorization_threshold!==owner.authorizationThreshold||!isDeepStrictEqual(actualKeys,expectedKeys))
      return fail('PRIVY_SERVICE_OWNER_METADATA_MISMATCH');
    return {id:quorum.id,keys:actualKeys,threshold:quorum.authorization_threshold,userIds:quorum.user_ids??[],nested:quorum.key_quorum_ids??[]};
  };
  const before=await current(),after=await current();if(!isDeepStrictEqual(before,after))return fail('PRIVY_SERVICE_OWNER_METADATA_CHANGED');
  return freeze({status:'CURRENT_OPERATOR_OWNER_METADATA_VERIFIED' as const,readCallsAttempted,ownerMetadataVerified:true as const,
    authorizationThreshold:after.threshold,authorizationPublicKeyCount:after.keys.length,userMemberCount:0 as const,nestedQuorumCount:0 as const,
    authorizationKeyPossessionVerified:false as const,runtimeMultisigSupported:false as const,canExecute:false as const,
    walletsCreated:0 as const,policiesCreated:0 as const,policiesChanged:0 as const,signaturesRequested:0 as const,transactionsSent:0 as const});
}
