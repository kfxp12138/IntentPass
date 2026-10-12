import type {PrivyClient} from '@privy-io/node';
import {isDeepStrictEqual} from 'node:util';
import {keccak256,toHex} from 'viem';
import {z} from 'zod';
import {ProviderIdSchema} from '../packages/protocol/src/day4-origin-types.js';
import {escrowPolicy} from '../packages/adapters/src/privy-sender.js';
import {receiptPolicy} from '../packages/adapters/src/privy-receipt-signer.js';
import {semanticPrivyPolicyRules} from '../packages/adapters/src/privy-policy.js';

const nonzero=z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(value=>BigInt(value)!==0n).transform(value=>value.toLowerCase());
const roleSchema=z.object({address:nonzero,walletId:ProviderIdSchema,policyId:ProviderIdSchema,signerId:ProviderIdSchema}).strict();
export const PrivyRoleConfigurationSchema=z.object({assetMode:z.literal('demo-erc20'),chainId:z.literal('10143'),arbiter:nonzero,
  executor:roleSchema,reviewer:roleSchema,model:z.string().regex(/^jev-\d+\.\d+\.\d+$/),
  questionConfigHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(value=>value.toLowerCase())}).strict().superRefine((config,context)=>{
  for(const field of ['address','walletId','policyId'] as const)if(config.executor[field]===config.reviewer[field])
    context.addIssue({code:'custom',message:'DISTINCT_PRIVY_ROLES_REQUIRED'});
});
export type PrivyRoleConfiguration=z.infer<typeof PrivyRoleConfigurationSchema>;
export interface PrivyRoleReadPort {wallet(id:string):Promise<unknown>;policy(id:string):Promise<unknown>;}
export class PrivyRolePreparationError extends Error {
  constructor(code:string,readonly readCallsAttempted=0){super(code);}
}
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const hash=(value:unknown)=>keccak256(toHex(JSON.stringify(value)));
const semanticRules=semanticPrivyPolicyRules;
export function parsePrivyRoleConfiguration(input:unknown):PrivyRoleConfiguration {
  try{return freeze(PrivyRoleConfigurationSchema.parse(structuredClone(input)));}
  catch{throw new PrivyRolePreparationError('PRIVY_ROLES_CONFIGURATION_INVALID');}
}

/** Offline blueprints only. Provider identifiers are hashed, never published in the bundle.
 * An operator-supplied model/hash does not by itself attest an activated review policy;
 * the CLI checks it through the application's loadActivatedReviewPolicy loader. */
export function preparePrivyRoles(input:unknown){
  const config=parsePrivyRoleConfiguration(input),executor=escrowPolicy(config.chainId,config.arbiter as `0x${string}`),
    reviewer=receiptPolicy({chainId:config.chainId,arbiter:config.arbiter,address:config.reviewer.address,model:config.model,questionConfigHash:config.questionConfigHash});
  return freeze({scope:'OFFLINE_PRIVY_TWO_ROLE_BLUEPRINTS_NOT_INSTALLED_OR_EXECUTION_PROOF' as const,status:'PREPARED' as const,
    assetMode:config.assetMode,chainId:config.chainId,arbiter:config.arbiter,model:config.model,questionConfigHash:config.questionConfigHash,
    configurationHash:hash(config),roles:{executor:{address:config.executor.address,policyBlueprint:executor,rulesHash:hash(semanticRules(executor.rules))},
      reviewer:{address:config.reviewer.address,policyBlueprint:reviewer,rulesHash:hash(semanticRules(reviewer.rules))}},
    providerIdentifiersRecorded:false as const,policyInstallationVerified:false as const,currentWalletPolicyVerified:false as const,
    authorizationKeyPossessionVerified:false as const,deploymentVerified:false as const,financialAcceptanceStatus:'BLOCKED' as const,
    canExecute:false as const,walletsCreated:0 as const,policiesChanged:0 as const,signaturesRequested:0 as const,transactionsSent:0 as const});
}

/** Capture only the two GET capabilities. Resource/SDK mutation cannot replace them later. */
export function privyRoleReadPort(client:PrivyClient):PrivyRoleReadPort {
  let wallet:(id:string)=>Promise<unknown>,policy:(id:string)=>Promise<unknown>;
  try{const wallets=client.wallets(),policies=client.policies();wallet=wallets.get.bind(wallets);policy=policies.get.bind(policies);}
  catch{throw new PrivyRolePreparationError('PRIVY_ROLES_PORT_INVALID');}
  const id=(value:string)=>{if(!ProviderIdSchema.safeParse(value).success)throw new PrivyRolePreparationError('PRIVY_ROLES_PROVIDER_IDENTIFIER_INVALID');return value;};
  return Object.freeze({wallet:async(value:string)=>wallet(id(value)),policy:async(value:string)=>policy(id(value))});
}

const walletSchema=z.object({id:ProviderIdSchema,address:nonzero,chain_type:z.literal('ethereum'),owner_id:z.string().nullable(),
  policy_ids:z.array(ProviderIdSchema).max(64),additional_signers:z.array(z.object({signer_id:ProviderIdSchema,
    override_policy_ids:z.array(ProviderIdSchema).max(64).optional()}).strip()).max(64),
  archived_at:z.number().int().nonnegative().nullable().optional()}).strip();
const policySchema=z.object({id:ProviderIdSchema,version:z.literal('1.0'),chain_type:z.literal('ethereum'),
  rules:z.array(z.object({method:z.string().max(128),action:z.string().max(128),conditions:z.array(z.unknown()).max(64)}).strip()).max(64)}).strip();

/** Current chosen-signer policy association only. Exactly eight GET method calls on
 * success; no transaction records, auth keys, quorum mutation, signing, or sending. */
export async function inspectPrivyRoles(input:unknown,port:PrivyRoleReadPort){
  const config=parsePrivyRoleConfiguration(input),prepared=preparePrivyRoles(config);let readCallsAttempted=0;
  const fail=(code:string):never=>{throw new PrivyRolePreparationError(code,readCallsAttempted);};
  let reads:PrivyRoleReadPort;
  try{reads=Object.freeze({wallet:port.wallet.bind(port),policy:port.policy.bind(port)});}catch{return fail('PRIVY_ROLES_PORT_INVALID');}
  const read=async(operation:()=>Promise<unknown>)=>{readCallsAttempted++;try{return await operation();}catch{return fail('PRIVY_ROLES_READ_UNAVAILABLE');}};
  const current=async()=>{
    const result=await Promise.allSettled([read(()=>reads.wallet(config.executor.walletId)),read(()=>reads.policy(config.executor.policyId)),
      read(()=>reads.wallet(config.reviewer.walletId)),read(()=>reads.policy(config.reviewer.policyId))]);
    if(result.some(item=>item.status==='rejected'))return fail('PRIVY_ROLES_READ_UNAVAILABLE');
    const values=result.map(item=>(item as PromiseFulfilledResult<unknown>).value),snapshots=[];
    for(const [index,role] of (['executor','reviewer'] as const).entries()){
      const expected=config[role];let wallet,policy;
      try{wallet=walletSchema.parse(values[index*2]);policy=policySchema.parse(values[index*2+1]);}
      catch{return fail('PRIVY_ROLES_CURRENT_CONFIGURATION_INVALID');}
      if(wallet.id!==expected.walletId||wallet.address!==expected.address||wallet.archived_at!=null||policy.id!==expected.policyId)
        return fail('PRIVY_ROLES_CURRENT_CONFIGURATION_MISMATCH');
      const delegated=wallet.additional_signers.filter(signer=>signer.signer_id===expected.signerId),owner=wallet.owner_id===expected.signerId,
        policyIds=owner?wallet.policy_ids:delegated.length===1?delegated[0].override_policy_ids:undefined;
      if(!isDeepStrictEqual(policyIds,[expected.policyId]))return fail('PRIVY_ROLES_SIGNER_POLICY_MISMATCH');
      const rules=semanticRules(prepared.roles[role].policyBlueprint.rules);
      if(!isDeepStrictEqual(semanticRules(policy.rules),rules))return fail('PRIVY_ROLES_POLICY_SCOPE_MISMATCH');
      snapshots.push(freeze({role,address:wallet.address,ownerId:wallet.owner_id,signerRole:owner?'OWNER' as const:'DELEGATED' as const,
        policyIds:[...policyIds!],delegated:delegated.map(signer=>({signerId:signer.signer_id,policyIds:signer.override_policy_ids})),rulesHash:hash(rules)}));
    }
    return snapshots;
  };
  const before=await current(),after=await current();if(!isDeepStrictEqual(before,after))return fail('PRIVY_ROLES_CURRENT_CONFIGURATION_CHANGED');
  return freeze({scope:'LIVE_CURRENT_PRIVY_TWO_ROLE_POLICIES_NOT_KEY_POSSESSION_OR_EXECUTION_PROOF' as const,status:'CURRENT_ROLES_VERIFIED' as const,
    assetMode:config.assetMode,chainId:config.chainId,arbiter:config.arbiter,configurationHash:prepared.configurationHash,readCallsAttempted,
    roles:Object.fromEntries(before.map(snapshot=>[snapshot.role,{address:snapshot.address,signerRole:snapshot.signerRole,rulesHash:snapshot.rulesHash}])),
    currentWalletPolicyVerified:true as const,providerIdentifiersRecorded:false as const,providerBodiesRecorded:false as const,
    authorizationKeyPossessionVerified:false as const,historicalPolicyAtSendVerified:false as const,providerTransactionsVerified:false as const,
    deploymentVerified:false as const,financialAcceptanceStatus:'BLOCKED' as const,canExecute:false as const,
    walletsCreated:0 as const,policiesChanged:0 as const,signaturesRequested:0 as const,transactionsSent:0 as const});
}
