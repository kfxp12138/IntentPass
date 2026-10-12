import {z} from 'zod';
import type {Address,Hex,PublicClient} from 'viem';
import {IntentEnvelopeSchema,CapabilityGrantSchema,address,digest,uint,positiveUint} from './schemas.js';
import {contextHash} from './index.js';
import {preparationHash,ALLOCATION_POLICY,RELEASE_POLICY,DELIVERY_SCHEMA,ZERO_HASH} from './escrow.js';
import {escrowAbi} from './escrow-abi.js';
import {orderStates,type EscrowDeployment} from './escrow-read.js';

export const PreflightRequestSchema=z.object({intent:IntentEnvelopeSchema,grant:CapabilityGrantSchema}).strict();
export const preflightBlockers=['ORDER_ALREADY_REGISTERED','NONCE_CONSUMED','NONCE_REVOKED','AUTHORIZATION_EXPIRED','BUYER_INELIGIBLE','INSUFFICIENT_BALANCE','EXACT_ALLOWANCE_REQUIRED'] as const;
export const PreflightSnapshotSchema=z.object({
  chainId:positiveUint,arbiter:address,asset:address,buyer:address,orderId:digest,contextHash:digest,nonce:uint,amount:positiveUint,deadline:positiveUint,
  state:z.enum(orderStates),consumed:z.boolean(),revoked:z.boolean(),transferEligible:z.boolean(),balance:uint,allowance:uint,
  blockers:z.array(z.enum(preflightBlockers)),
  block:z.object({number:uint,hash:digest,timestamp:uint,finality:z.enum(['finalized','latest'])}).strict(),
  canSubmitPayment:z.literal(false),
}).strict().superRefine((s,ctx)=>{
  const expected:string[]=[];
  if(s.state!=='UNREGISTERED')expected.push('ORDER_ALREADY_REGISTERED');
  if(s.consumed)expected.push('NONCE_CONSUMED');if(s.revoked)expected.push('NONCE_REVOKED');
  if(BigInt(s.block.timestamp)>=BigInt(s.deadline))expected.push('AUTHORIZATION_EXPIRED');
  if(!s.transferEligible)expected.push('BUYER_INELIGIBLE');if(BigInt(s.balance)<BigInt(s.amount))expected.push('INSUFFICIENT_BALANCE');
  if(s.allowance!==s.amount)expected.push('EXACT_ALLOWANCE_REQUIRED');
  if(JSON.stringify(s.blockers)!==JSON.stringify(expected))ctx.addIssue({code:'custom',message:'PREFLIGHT_BLOCKERS_INCONSISTENT'});
});
export type PreflightSnapshot=z.infer<typeof PreflightSnapshotSchema>;
export const PreflightResultSchema=z.union([PreflightSnapshotSchema,z.object({status:z.literal('REJECT'),code:z.enum(['INPUT_INVALID','OWNER_MISMATCH'])}).strict()]);
const tokenAbi=[
  {type:'function',name:'balanceOf',stateMutability:'view',inputs:[{name:'owner',type:'address'}],outputs:[{name:'',type:'uint256'}]},
  {type:'function',name:'allowance',stateMutability:'view',inputs:[{name:'owner',type:'address'},{name:'spender',type:'address'}],outputs:[{name:'',type:'uint256'}]},
] as const;
// Project adapter interface only. This is not an official Cleanverse ABI.
const gateAbi=[{type:'function',name:'canTransfer',stateMutability:'view',inputs:[{name:'asset',type:'address'},{name:'from',type:'address'},{name:'to',type:'address'},{name:'amount',type:'uint256'},{name:'contextHash',type:'bytes32'}],outputs:[{name:'',type:'bool'}]}] as const;
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();

/** Read-only snapshot, never a nonce reservation or a payment permission.
 * No signatures, model, allowance writes or transaction simulation/submission.
 */
export class PurchasePreflightReader {
  readonly deployment:EscrowDeployment;
  readonly executor:Address;
  constructor(readonly client:PublicClient,deployment:EscrowDeployment,executor:string,readonly blockTag:'finalized'|'latest'='finalized') {
    positiveUint.parse(deployment.chainId);digest.parse(deployment.committeeHash);
    for(const value of [deployment.arbiter,deployment.asset,deployment.gate,deployment.reviewer,executor])if(BigInt(address.parse(value))===0n)throw new Error('PREFLIGHT_DEPLOYMENT_INVALID');
    this.deployment=Object.freeze({...deployment});this.executor=address.parse(executor) as Address;
  }
  async read(input:unknown):Promise<PreflightSnapshot> {
    const {intent:e,grant:g}=PreflightRequestSchema.parse(input),d=this.deployment,c=contextHash(e),amount=BigInt(e.price)+BigInt(e.bond);
    if(e.chainId!==d.chainId||!eq(e.arbiter,d.arbiter)||!eq(e.asset,d.asset)||!eq(e.reviewer,d.reviewer)||!eq(e.committeeHash,d.committeeHash)
      ||!eq(e.allocationPolicyHash,ALLOCATION_POLICY)||!eq(e.intentReleasePolicyHash,RELEASE_POLICY)||!eq(e.deliverySchemaHash,DELIVERY_SCHEMA)||!eq(e.pactPaymentPublicKeyHash,ZERO_HASH)
      ||g.chainId!==e.chainId||!eq(g.arbiter,e.arbiter)||!eq(g.owner,e.buyer)||!eq(g.executor,this.executor)||!eq(g.orderId,e.orderId)||!eq(g.asset,e.asset)
      ||g.amount!==String(amount)||!eq(g.contextHash,c)||!eq(g.preparationHash,preparationHash(c,e.committeeHash))||BigInt(g.deadline)>BigInt(e.deliveryDeadline))throw new Error('PREFLIGHT_CONTEXT_MISMATCH');
    if(BigInt(e.orderId)===0n||[e.buyer,e.seller,e.payee].some(a=>BigInt(a)===0n||eq(a,d.arbiter)))throw new Error('PREFLIGHT_CONTEXT_MISMATCH');
    if(String(await this.client.getChainId())!==d.chainId)throw new Error('CHAIN_MISMATCH');
    const block=await this.client.getBlock({blockTag:this.blockTag});if(block.number===null||block.hash===null)throw new Error('BLOCK_UNAVAILABLE');
    const args={address:d.arbiter,abi:escrowAbi,blockNumber:block.number},buyer=e.buyer as Address,id=e.orderId as Hex;
    const [asset,gate,reviewer,members,o,consumed,revoked,balance,allowance,transferEligible,locked,outstanding,escrowBalance]=await Promise.all([
      this.client.readContract({...args,functionName:'asset'}),this.client.readContract({...args,functionName:'eligibility'}),
      this.client.readContract({...args,functionName:'reviewer'}),this.client.readContract({...args,functionName:'committeeHash'}),
      this.client.readContract({...args,functionName:'orders',args:[id]}),this.client.readContract({...args,functionName:'consumed',args:[buyer,BigInt(g.nonce)]}),
      this.client.readContract({...args,functionName:'revoked',args:[buyer,BigInt(g.nonce)]}),
      this.client.readContract({address:d.asset,abi:tokenAbi,functionName:'balanceOf',args:[buyer],blockNumber:block.number}),
      this.client.readContract({address:d.asset,abi:tokenAbi,functionName:'allowance',args:[buyer,d.arbiter],blockNumber:block.number}),
      this.client.readContract({address:d.gate,abi:gateAbi,functionName:'canTransfer',args:[d.asset,buyer,d.arbiter,amount,c],blockNumber:block.number}),
      this.client.readContract({...args,functionName:'locked'}),this.client.readContract({...args,functionName:'outstanding'}),
      this.client.readContract({address:d.asset,abi:tokenAbi,functionName:'balanceOf',args:[d.arbiter],blockNumber:block.number}),
    ]);
    if(!eq(asset,d.asset)||!eq(gate,d.gate)||!eq(reviewer,d.reviewer)||!eq(members,d.committeeHash))throw new Error('DEPLOYMENT_MISMATCH');
    if((await this.client.getBlock({blockNumber:block.number})).hash!==block.hash)throw new Error('CHAIN_SNAPSHOT_CHANGED');
    if(escrowBalance<locked+outstanding)throw new Error('ESCROW_INSOLVENT');
    const state=orderStates[o[12]];if(!state)throw new Error('STATE_INVALID');
    const blockers:PreflightSnapshot['blockers']=[];
    if(state!=='UNREGISTERED')blockers.push('ORDER_ALREADY_REGISTERED');
    if(consumed)blockers.push('NONCE_CONSUMED');if(revoked)blockers.push('NONCE_REVOKED');
    if(block.timestamp>=BigInt(g.deadline)||block.timestamp>=BigInt(e.deliveryDeadline))blockers.push('AUTHORIZATION_EXPIRED');
    if(!transferEligible)blockers.push('BUYER_INELIGIBLE');if(balance<amount)blockers.push('INSUFFICIENT_BALANCE');
    if(allowance!==amount)blockers.push('EXACT_ALLOWANCE_REQUIRED');
    return PreflightSnapshotSchema.parse({chainId:d.chainId,arbiter:d.arbiter,asset:d.asset,buyer,orderId:id,contextHash:c,nonce:g.nonce,amount:String(amount),deadline:g.deadline,state,consumed,revoked,transferEligible,balance:String(balance),allowance:String(allowance),blockers,
      block:{number:String(block.number),hash:block.hash,timestamp:String(block.timestamp),finality:this.blockTag},canSubmitPayment:false});
  }
}
