import {z} from 'zod';
import {isDeepStrictEqual} from 'node:util';
import {keccak256,toHex} from 'viem';
import {address,digest} from '../../protocol/src/schemas.js';
import {PrivyOriginConfigSchema,PrivyOriginRequestSchema,PrivyOriginProofSchema,ProviderIdSchema,
  type PrivyOriginPort,type PrivyOriginProof} from '../../protocol/src/day4-origin-types.js';
import {escrowPolicy} from './privy-sender.js';

const walletSchema=z.object({id:ProviderIdSchema,address,chain_type:z.literal('ethereum'),owner_id:z.string().nullable(),
  policy_ids:z.array(ProviderIdSchema).max(64),additional_signers:z.array(z.object({signer_id:ProviderIdSchema,
    override_policy_ids:z.array(ProviderIdSchema).max(64).optional()}).strip()).max(64),archived_at:z.number().int().nonnegative().nullable().optional()}).strip();
const policySchema=z.object({id:ProviderIdSchema,version:z.literal('1.0'),chain_type:z.literal('ethereum'),
  rules:z.array(z.object({method:z.string(),action:z.string(),conditions:z.array(z.unknown()).max(64)}).strip()).max(64)}).strip();
// Exactly the eight states of the installed 0.35.0 Transaction resource.
const recordSchema=z.object({id:ProviderIdSchema,caip2:z.string(),created_at:z.number().int().positive().safe(),
  status:z.enum(['broadcasted','confirmed','execution_reverted','failed','replaced','finalized','provider_error','pending']),
  transaction_hash:digest.nullable(),wallet_id:ProviderIdSchema}).strip();
function freeze<T>(value:T):T{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
const fail=(code:string):never=>{throw Error('PRIVY_ORIGIN_'+code);};

/** Live GET associations and the chosen signer's current effective policy only.
 * Never a sender, signer, historical policy attestation or withdrawal origin. */
export async function inspectPrivyOrigin(input:unknown,configInput:unknown,port:PrivyOriginPort,options:{now?:number}={}):Promise<PrivyOriginProof>{
  let request,config,reads;
  const now=options.now??Date.now();
  try{request=freeze(PrivyOriginRequestSchema.parse(structuredClone(input)));config=freeze(PrivyOriginConfigSchema.parse(structuredClone(configInput)));}
  catch{return fail('INPUT_INVALID');}
  if(!Number.isSafeInteger(now)||now<=0)return fail('CLOCK_INVALID');
  try{reads=Object.freeze({transaction:port.transaction.bind(port),wallet:port.wallet.bind(port),policy:port.policy.bind(port)});}
  catch{return fail('PORT_INVALID');}
  const read=async(operation:()=>Promise<unknown>)=>{try{return freeze(structuredClone(await operation()));}catch{return fail('READ_UNAVAILABLE');}};
  const current=async()=>{
    const [rawWallet,rawPolicy]=await Promise.all([read(()=>reads.wallet(config.walletId)),read(()=>reads.policy(config.policyId))]);
    let wallet,policy;
    try{wallet=walletSchema.parse(rawWallet);policy=policySchema.parse(rawPolicy);}catch{return fail('CURRENT_CONFIGURATION_INVALID');}
    if(wallet.id!==config.walletId||wallet.address.toLowerCase()!==config.address.toLowerCase()
      ||wallet.archived_at!==null&&wallet.archived_at!==undefined||policy.id!==config.policyId)return fail('CURRENT_CONFIGURATION_MISMATCH');
    const delegated=wallet.additional_signers.filter(value=>value.signer_id===config.signerId),owner=wallet.owner_id===config.signerId;
    const policyIds=owner?wallet.policy_ids:delegated.length===1?delegated[0].override_policy_ids:undefined;
    if(!isDeepStrictEqual(policyIds,[config.policyId]))return fail('SIGNER_POLICY_MISMATCH');
    const expected=escrowPolicy(config.chainId,config.arbiter as `0x${string}`),rules=expected.rules.map(({method,action,conditions})=>({method,action,conditions}));
    if(!isDeepStrictEqual(policy.rules,rules))return fail('POLICY_SCOPE_MISMATCH');
    // Bind only the relevant effective signer fields; no raw metadata/secrets.
    return freeze({walletId:wallet.id,address:wallet.address.toLowerCase(),ownerId:wallet.owner_id,policyIds,
      delegated:delegated.map(value=>({signerId:value.signer_id,policyIds:value.override_policy_ids})),rules,
      role:owner?'OWNER' as const:'DELEGATED' as const});
  };
  const before=await current();
  const records={} as PrivyOriginProof['records'];
  for(const step of ['funding','allocation'] as const){
    const expected=request.transactions[step],raw=await read(()=>reads.transaction(expected.recordId));
    let record;try{record=recordSchema.parse(raw);}catch{return fail('RECORD_INVALID');}
    if(record.id!==expected.recordId||record.caip2!==`eip155:${config.chainId}`||record.wallet_id!==config.walletId
      ||record.transaction_hash!==null&&record.transaction_hash.toLowerCase()!==expected.hash.toLowerCase())return fail('RECORD_MISMATCH');
    if(record.status!=='finalized'||record.transaction_hash===null)return fail('NOT_FINALIZED');
    records[step]={id:record.id,caip2:'eip155:10143',createdAt:record.created_at,status:'finalized',hash:record.transaction_hash,walletId:record.wallet_id};
  }
  const after=await current();if(!isDeepStrictEqual(before,after))return fail('CURRENT_CONFIGURATION_CHANGED');
  return freeze(PrivyOriginProofSchema.parse({schemaVersion:1,scope:'LIVE_PRIVY_ORIGINAL_RECORD_ASSOCIATIONS_AND_CURRENT_POLICY_NOT_HISTORICAL_POLICY_AT_SEND',
    status:'PROVIDER_RECORDS_VERIFIED',chainId:config.chainId,executor:config.address,arbiter:config.arbiter,walletId:config.walletId,policyId:config.policyId,
    signerId:config.signerId,signerRole:before.role,policyRulesHash:keccak256(toHex(JSON.stringify(before.rules))),records,observedAtUnixMs:now,providerTimestampUnitVerified:false,
    providerTransactionRecordsVerified:true,currentWalletPolicyVerified:true,historicalPolicyAtSendVerified:false,withdrawalProviderOriginVerified:false,
    canExecute:false,signaturesRequested:0,transactionsSent:0,financialAcceptanceStatus:'BLOCKED',limits:[
      'The live Privy GET resource associates the two original transaction IDs and hashes with the configured wallet and chain; original calldata and effects require independent chain verification.',
      'Only the chosen signer\'s current effective policy and relevant wallet fields are compared at both ends. This is not the policy or authorization signer at the historical send time.',
      'Provider created_at is preserved as the original numeric field; its unit is not independently specified here and no ordering against block time or local wall time is inferred.',
      'No Privy origin is claimed for the beneficiary withdrawal. Provider body extras, secrets and authorization headers are never published.',
      'This reader has no signing, sending, policy update, retry or key-export capability and cannot make D4 acceptance PASS.'
    ]}));
}
