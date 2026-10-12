import {PrivyClient} from '@privy-io/node';
import {z} from 'zod';
import {isDeepStrictEqual} from 'node:util';
import {keccak256,type Hex} from 'viem';
import {address,digest,DecisionReceiptSchema} from '../../protocol/src/schemas.js';
import {UnsignedReceiptSchema,receiptTypedData,receiptTypes,receiptHash,verifyReceiptSignature} from '../../protocol/src/typed-data.js';
import type {ReceiptSigner} from '../../../apps/web/src/services/review.js';
import type {ReceiptStore} from '../../storage/src/receipt-store.js';
import {semanticPrivyPolicyRules} from './privy-policy.js';
const nonzero=address.refine(v=>BigInt(v)!==0n),domainSchema=z.object({chainId:z.enum(['143','10143']),arbiter:nonzero}).strict();
const boundsSchema=domainSchema.extend({address:nonzero,model:z.string().regex(/^jev-\d+\.\d+\.\d+$/),questionConfigHash:digest}).strict();
const configSchema=boundsSchema.extend({walletId:z.string().min(1).max(256),policyId:z.string().min(1).max(256),signerId:z.string().min(1).max(256),authorizationPrivateKey:z.string().min(1).max(8192)}).strict();
export type PrivyReceiptConfig=z.infer<typeof configSchema>;
const domainTypes=[{name:'name',type:'string'},{name:'version',type:'string'},{name:'chainId',type:'uint256'},{name:'verifyingContract',type:'address'}];
const wireTypes={EIP712Domain:domainTypes,...receiptTypes};
/** Existing-wallet blueprint; actual provider policy acceptance is separate. */
export function receiptPolicy(input:z.infer<typeof boundsSchema>){const c=boundsSchema.parse(input),typed_data={primary_type:'DecisionReceipt',types:wireTypes};return {name:'IntentPass fixed reviewer',version:'1.0' as const,chain_type:'ethereum' as const,rules:[{name:'Fixed PASS receipt',method:'eth_signTypedData_v4' as const,action:'ALLOW' as const,conditions:[
  {field_source:'ethereum_typed_data_domain' as const,field:'chainId' as const,operator:'eq' as const,value:c.chainId},
  {field_source:'ethereum_typed_data_domain' as const,field:'verifyingContract' as const,operator:'eq' as const,value:c.arbiter.toLowerCase()},
  ...Object.entries({schemaVersion:'1',reviewer:c.address.toLowerCase(),modelId:c.model,questionConfigHash:c.questionConfigHash.toLowerCase(),decision:'PASS'}).map(([field,value])=>({field_source:'ethereum_typed_data_message' as const,field,operator:'eq' as const,value,typed_data})),
]}]};}
export class PrivyReceiptSigner implements ReceiptSigner {
  readonly address:string;private readonly config:Readonly<PrivyReceiptConfig>;
  constructor(private readonly client:PrivyClient,input:PrivyReceiptConfig,private readonly store:ReceiptStore,private readonly clock:()=>bigint=()=>BigInt(Math.floor(Date.now()/1000))){const c=configSchema.parse(input);this.config=Object.freeze({...c,arbiter:c.arbiter.toLowerCase(),address:c.address.toLowerCase(),questionConfigHash:c.questionConfigHash.toLowerCase()});this.address=this.config.address;}
  async sign(input:Parameters<ReceiptSigner['sign']>[0],domainInput:Parameters<ReceiptSigner['sign']>[1]):Promise<Hex>{
    const r=UnsignedReceiptSchema.parse(input),domain=domainSchema.parse(domainInput),c=this.config,now=this.clock();
    const valid=(time:bigint)=>time>=now&&time<BigInt(r.expiresAt)&&BigInt(r.expiresAt)<=time+300n;
    if(domain.chainId!==c.chainId||domain.arbiter.toLowerCase()!==c.arbiter||r.reviewer.toLowerCase()!==c.address||r.decision!=='PASS'||r.modelId!==c.model||r.questionConfigHash.toLowerCase()!==c.questionConfigHash||now<0n||!valid(now))throw new Error('RECEIPT_SCOPE_REJECTED');
    if(this.store.get(domain,r.contextHash))throw new Error('RECEIPT_SIGNING_LOCKED');
    const wallet=await this.client.wallets().get(c.walletId),delegated=wallet.additional_signers.filter(s=>s.signer_id===c.signerId),policies=wallet.owner_id===c.signerId?wallet.policy_ids:delegated.length===1?delegated[0].override_policy_ids:undefined;
    if(wallet.id!==c.walletId||wallet.chain_type!=='ethereum'||wallet.address.toLowerCase()!==c.address||wallet.archived_at||!isDeepStrictEqual(policies,[c.policyId]))throw new Error('RECEIPT_SCOPE_REJECTED');
    const policy=await this.client.policies().get(c.policyId),expected=receiptPolicy({chainId:c.chainId,arbiter:c.arbiter,address:c.address,model:c.model,questionConfigHash:c.questionConfigHash});
    if(policy.id!==c.policyId||policy.version!==expected.version||policy.chain_type!==expected.chain_type||!isDeepStrictEqual(semanticPrivyPolicyRules(policy.rules),semanticPrivyPolicyRules(expected.rules)))throw new Error('RECEIPT_SCOPE_REJECTED');
    if(!valid(this.clock())||!this.store.reserve(r,domain))throw new Error('RECEIPT_SIGNING_LOCKED');
    try{
      const typed=receiptTypedData(r,domain),message=Object.fromEntries(Object.entries(typed.message).map(([key,value])=>[key,typeof value==='bigint'?String(value):typeof value==='string'&&value.startsWith('0x')?value.toLowerCase():value]));
      const response=await this.client.wallets().ethereum().signTypedData(c.walletId,{params:{typed_data:{domain:{...typed.domain,chainId:Number(c.chainId),verifyingContract:c.arbiter},types:wireTypes,primary_type:typed.primaryType,message}},authorization_context:{authorization_private_keys:[c.authorizationPrivateKey]},idempotency_key:receiptHash(r,domain)});
      const signature=response.signature as Hex;if(response.encoding!=='hex'||!await verifyReceiptSignature({...r,signature},domain)||!valid(this.clock()))throw new Error();
      this.store.finish(r,domain,keccak256(signature));return signature;
    }catch{try{this.store.finish(r,domain,null);}catch{}throw new Error('RECEIPT_SIGNING_OUTCOME_UNKNOWN');}
  }
  /** Explicit same-context successor; unknown predecessors never become a new slot. */
  async renew(input:Parameters<ReceiptSigner['sign']>[0],domainInput:Parameters<ReceiptSigner['sign']>[1],rootInput:unknown,previousInput:unknown):Promise<Hex>{
    const r=UnsignedReceiptSchema.parse(input),domain=domainSchema.parse(domainInput),root=DecisionReceiptSchema.parse(rootInput),previous=DecisionReceiptSchema.parse(previousInput),c=this.config,now=this.clock();
    const {expiresAt:_oldExpiry,signature:_oldSignature,...oldFields}=previous,{expiresAt:_newExpiry,...newFields}=r;
    const valid=(time:bigint)=>time>=now&&time>=BigInt(previous.expiresAt)&&time<BigInt(r.expiresAt)&&BigInt(r.expiresAt)<=time+300n;
    if(!isDeepStrictEqual(oldFields,newFields)||domain.chainId!==c.chainId||domain.arbiter.toLowerCase()!==c.arbiter||r.reviewer.toLowerCase()!==c.address||r.modelId!==c.model||r.questionConfigHash.toLowerCase()!==c.questionConfigHash||now<0n||!valid(now)||!await verifyReceiptSignature(root,domain)||!await verifyReceiptSignature(previous,domain))throw Error('RECEIPT_RENEWAL_SCOPE_REJECTED');
    const latest=this.store.latestRenewal(domain,root),{signature:_previousSignature,...unsignedPrevious}=previous;
    if(latest.status!=='SIGNED'||latest.receiptHash!==receiptHash(unsignedPrevious,domain))throw Error('RECEIPT_RENEWAL_SIGNING_LOCKED');
    const wallet=await this.client.wallets().get(c.walletId),delegated=wallet.additional_signers.filter(s=>s.signer_id===c.signerId),policies=wallet.owner_id===c.signerId?wallet.policy_ids:delegated.length===1?delegated[0].override_policy_ids:undefined;
    if(wallet.id!==c.walletId||wallet.chain_type!=='ethereum'||wallet.address.toLowerCase()!==c.address||wallet.archived_at||!isDeepStrictEqual(policies,[c.policyId]))throw Error('RECEIPT_RENEWAL_SCOPE_REJECTED');
    const policy=await this.client.policies().get(c.policyId),expected=receiptPolicy({chainId:c.chainId,arbiter:c.arbiter,address:c.address,model:c.model,questionConfigHash:c.questionConfigHash});
    if(policy.id!==c.policyId||policy.version!==expected.version||policy.chain_type!==expected.chain_type||!isDeepStrictEqual(semanticPrivyPolicyRules(policy.rules),semanticPrivyPolicyRules(expected.rules)))throw Error('RECEIPT_RENEWAL_SCOPE_REJECTED');
    if(!valid(this.clock())||!this.store.reserveRenewal(root,previous,r,domain))throw Error('RECEIPT_RENEWAL_SIGNING_LOCKED');
    try{
      const typed=receiptTypedData(r,domain),message=Object.fromEntries(Object.entries(typed.message).map(([key,value])=>[key,typeof value==='bigint'?String(value):typeof value==='string'&&value.startsWith('0x')?value.toLowerCase():value]));
      const response=await this.client.wallets().ethereum().signTypedData(c.walletId,{params:{typed_data:{domain:{...typed.domain,chainId:Number(c.chainId),verifyingContract:c.arbiter},types:wireTypes,primary_type:typed.primaryType,message}},authorization_context:{authorization_private_keys:[c.authorizationPrivateKey]},idempotency_key:receiptHash(r,domain)});
      const signature=response.signature as Hex;if(response.encoding!=='hex'||!await verifyReceiptSignature({...r,signature},domain)||!valid(this.clock()))throw Error();
      this.store.finishRenewal(r,domain,signature);return signature;
    }catch{try{this.store.finishRenewal(r,domain,null);}catch{}throw Error('RECEIPT_RENEWAL_SIGNING_OUTCOME_UNKNOWN');}
  }
}
