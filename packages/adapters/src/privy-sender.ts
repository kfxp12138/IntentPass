import {PrivyClient} from '@privy-io/node';
import {decodeFunctionData,encodeFunctionData,isAddress,keccak256,type Address,type Hex} from 'viem';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {escrowAbi} from '../../protocol/src/escrow-abi.js';
import {digest} from '../../protocol/src/schemas.js';
import {ProviderIdSchema} from '../../protocol/src/day4-origin-types.js';
import {recordedBroadcast,type RecordedBroadcast} from '../../protocol/src/provider-submission.js';
import type {RestrictedSender} from '../../../apps/worker/src/viem-port.js';
import {semanticPrivyPolicyRules} from './privy-policy.js';
export class SubmissionRejected extends Error {constructor(){super('TRANSACTION_SCOPE_REJECTED');}}
export interface PrivySenderConfig {chainId:string;arbiter:Address;address:Address;walletId:string;policyId:string;signerId:string;authorizationPrivateKey:string;gasLimit:string;sensitiveValues?:readonly string[];}
const methods=['submit','settle','timeout'] as const;
type SendInput=Parameters<RestrictedSender['send']>[0];
type Wallets=ReturnType<PrivyClient['wallets']>;
type Policies=ReturnType<PrivyClient['policies']>;
type Ethereum=ReturnType<Wallets['ethereum']>;
function freeze<T>(value:T):T{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
const responseSchema=z.object({caip2:z.string(),hash:digest,transaction_id:ProviderIdSchema.optional()}).strip();
const unknown=()=>Error('SUBMISSION_OUTCOME_UNKNOWN');
/** Uploadable blueprint, not a claim that a live Privy policy has passed acceptance. */
export function escrowPolicy(chainId:string,arbiter:Address) {
  return {name:'IntentPass fixed escrow',version:'1.0' as const,chain_type:'ethereum' as const,rules:methods.map(method=>({name:`IntentPass ${method}`,method:'eth_sendTransaction' as const,action:'ALLOW' as const,conditions:[
    {field_source:'ethereum_transaction' as const,field:'chain_id' as const,operator:'eq' as const,value:chainId},
    {field_source:'ethereum_transaction' as const,field:'to' as const,operator:'eq' as const,value:arbiter.toLowerCase()},
    {field_source:'ethereum_transaction' as const,field:'value' as const,operator:'eq' as const,value:'0'},
    {field_source:'ethereum_calldata' as const,field:'function_name' as const,operator:'eq' as const,value:method,abi:escrowAbi.filter((item):item is Extract<typeof escrowAbi[number],{type:'function'}>=>item.type==='function'&&item.name===method)},
  ]}))};
}
export class PrivyRestrictedSender implements RestrictedSender {
  readonly address:Address;
  readonly #config:PrivySenderConfig;
  readonly #sensitive:readonly string[];
  readonly #calls:{wallet:Wallets['get'];policy:Policies['get'];send:Ethereum['sendTransaction']};
  constructor(client:PrivyClient,config:PrivySenderConfig) {
    try{config=freeze(structuredClone(config));}catch{throw new SubmissionRejected();}
    if(!/^[1-9][0-9]*$/.test(config.chainId)||!isAddress(config.address)||!isAddress(config.arbiter)||![config.walletId,config.policyId,config.signerId,config.authorizationPrivateKey].every(Boolean)
      ||!/^\d+$/.test(config.gasLimit)||BigInt(config.gasLimit)<21000n||BigInt(config.gasLimit)>5000000n
      ||config.sensitiveValues!==undefined&&(!Array.isArray(config.sensitiveValues)||!config.sensitiveValues.every(value=>typeof value==='string')))throw new SubmissionRejected();
    this.#config=config;
    this.#sensitive=Object.freeze([...new Set([config.authorizationPrivateKey,...config.sensitiveValues??[]].filter(Boolean))]);
    try{
      const wallets=client.wallets(),policies=client.policies(),ethereum=wallets.ethereum();
      this.#calls=Object.freeze({wallet:wallets.get.bind(wallets),policy:policies.get.bind(policies),send:ethereum.sendTransaction.bind(ethereum)});
    }catch{throw new SubmissionRejected();}
    this.address=config.address;
  }
  #containsSensitive(value:unknown):boolean{
    if(typeof value==='string')return this.#sensitive.some(secret=>value.includes(secret)||/^0x[0-9a-f]+$/i.test(secret)&&value.toLowerCase().includes(secret.toLowerCase()));
    return !!value&&typeof value==='object'&&Object.values(value).some(item=>this.#containsSensitive(item));
  }
  async send(input:SendInput):Promise<Hex>{return (await this.sendRecorded(input)).hash as Hex;}
  async sendRecorded(input:SendInput):Promise<RecordedBroadcast> {
    const c=this.#config;
    try {
      input=freeze(structuredClone(input));
      if(input.chainId!==c.chainId||input.from.toLowerCase()!==c.address.toLowerCase()||input.to.toLowerCase()!==c.arbiter.toLowerCase()||input.value!=='0'
        ||typeof input.idempotencyKey!=='string'||!input.idempotencyKey||input.idempotencyKey.length>128)throw new Error();
      const decoded=decodeFunctionData({abi:escrowAbi,data:input.data});
      if(!methods.includes(decoded.functionName as typeof methods[number])||encodeFunctionData({abi:escrowAbi,...decoded} as Parameters<typeof encodeFunctionData>[0]).toLowerCase()!==input.data.toLowerCase())throw new Error();
    }catch{throw new SubmissionRejected();}
    // IDs are URL components; known credentials must never become provider IDs.
    if(![c.walletId,c.policyId,c.signerId].every(value=>ProviderIdSchema.safeParse(value).success)||this.#containsSensitive([c.walletId,c.policyId,c.signerId]))throw unknown();
    const request=freeze({
      caip2:`eip155:${c.chainId}`,params:{transaction:{chain_id:`0x${BigInt(c.chainId).toString(16)}`,from:c.address,to:c.arbiter,value:'0x0',data:input.data,gas_limit:`0x${BigInt(c.gasLimit).toString(16)}`}},
      authorization_context:{authorization_private_keys:[c.authorizationPrivateKey]},idempotency_key:input.idempotencyKey,
    });
    const association=freeze({provider:'PRIVY' as const,scope:'SDK_SEND_RESPONSE_ASSOCIATION_NOT_FINALIZED_OR_POLICY_PROVENANCE' as const,
      walletId:c.walletId,chainId:c.chainId,from:c.address,to:c.arbiter,calldataHash:keccak256(input.data)});
    // Remote state is checked before EVERY send, including delegated override policies.
    let wallet:Awaited<ReturnType<Wallets['get']>>,policy:Awaited<ReturnType<Policies['get']>>;
    try{wallet=freeze(structuredClone(await this.#calls.wallet(c.walletId)));}catch{throw unknown();}
    try{
      const delegated=wallet.additional_signers.filter(s=>s.signer_id===c.signerId);
      const policyIds=wallet.owner_id===c.signerId?wallet.policy_ids:delegated.length===1?delegated[0].override_policy_ids:undefined;
      if(wallet.id!==c.walletId||wallet.chain_type!=='ethereum'||wallet.address.toLowerCase()!==c.address.toLowerCase()||wallet.archived_at!=null
        ||!isDeepStrictEqual(policyIds,[c.policyId]))throw new Error();
    }catch{throw new SubmissionRejected();}
    try{policy=freeze(structuredClone(await this.#calls.policy(c.policyId)));}catch{throw unknown();}
    try{
      const expected=escrowPolicy(c.chainId,c.arbiter),rules=semanticPrivyPolicyRules(policy.rules);
      if(policy.id!==c.policyId||policy.version!==expected.version||policy.chain_type!==expected.chain_type
        ||!isDeepStrictEqual(rules,semanticPrivyPolicyRules(expected.rules)))throw new Error();
    }catch{throw new SubmissionRejected();}
    // No automatic RPC retry. Errors after calling the provider are conservatively UNKNOWN.
    try{
      const raw=await this.#calls.send(c.walletId,request);
      // Read each allowlisted SDK response field once; do not retain provider extras.
      const response=responseSchema.parse({caip2:raw.caip2,hash:raw.hash,transaction_id:raw.transaction_id});
      if(response.caip2!==request.caip2)throw new Error();
      const result=recordedBroadcast({hash:response.hash,providerSubmission:response.transaction_id===undefined?null:{...association,transactionId:response.transaction_id}});
      if(this.#containsSensitive(result))throw new Error();
      return result;
    }catch{throw unknown();}
  }
}
