import {getAddress,type Address,type Hex,type PublicClient} from 'viem';
import {z} from 'zod';
import {address,digest,positiveUint,uint} from './schemas.js';
import {escrowAbi} from './escrow-abi.js';
export const orderStates=['UNREGISTERED','FUNDED','EVIDENCE_FROZEN','CERTIFIED','ALLOCATED_PAID','ALLOCATED_REFUND','ALLOCATED_COMPENSATION'] as const;
export type OrderState=typeof orderStates[number];
export const OrderSnapshotSchema=z.object({
  chainId:positiveUint,arbiter:address,asset:address,orderId:digest,contextHash:digest,
  buyer:address,seller:address,payee:address,price:uint,bond:uint,deliveryDeadline:uint,settlementDeadline:uint,
  datasetHash:digest,serviceTermsHash:digest,evidenceHash:digest,voteMask:z.number().int().min(0).max(7),state:z.enum(orderStates),
  credits:z.object({buyer:uint,payee:uint}).strict(),withdrawn:z.object({buyer:uint,payee:uint}).strict(),
  accounting:z.object({locked:uint,outstanding:uint,balance:uint}).strict(),
  block:z.object({number:uint,hash:digest,timestamp:uint}).strict(),
}).strict();
export interface EscrowDeployment {chainId:string;arbiter:Address;asset:Address;gate:Address;reviewer:Address;committeeHash:Hex;}
export interface OrderSnapshot {
  chainId:string;arbiter:Address;asset:Address;orderId:Hex;contextHash:Hex;
  buyer:Address;seller:Address;payee:Address;price:string;bond:string;
  deliveryDeadline:string;settlementDeadline:string;datasetHash:Hex;serviceTermsHash:Hex;evidenceHash:Hex;voteMask:number;state:OrderState;
  credits:{buyer:string;payee:string};withdrawn:{buyer:string;payee:string};
  accounting:{locked:string;outstanding:string;balance:string};
  block:{number:string;hash:Hex;timestamp:string};
}
const erc20Balance=[{type:'function',name:'balanceOf',stateMutability:'view',inputs:[{name:'owner',type:'address'}],outputs:[{name:'',type:'uint256'}]}] as const;
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const validUint=(value:unknown):value is bigint=>typeof value==='bigint'&&uint.safeParse(String(value)).success;
function historicalBlock(input:unknown){
  if(!input||typeof input!=='object')throw new Error('HISTORICAL_BLOCK_INVALID');
  const block=input as {number:unknown;hash:unknown;timestamp:unknown};
  if(block.number===null||block.hash===null)throw new Error('BLOCK_UNAVAILABLE');
  if(!validUint(block.number)||!validUint(block.timestamp)||!digest.safeParse(block.hash).success)throw new Error('HISTORICAL_BLOCK_INVALID');
  return Object.freeze({number:block.number,hash:block.hash as Hex,timestamp:block.timestamp});
}
const sameBlock=(a:ReturnType<typeof historicalBlock>,b:ReturnType<typeof historicalBlock>)=>a.number===b.number&&same(a.hash,b.hash)&&a.timestamp===b.timestamp;
/** Reads all balances/state at one block, checks fixed deployment, rejects a changed block hash.
 * Public production consumers use finalized; latest is explicit for local tests only.
 */
export class EscrowReader {
  constructor(readonly client:PublicClient,readonly deployment:EscrowDeployment,readonly blockTag:'finalized'|'latest'='finalized') {
    positiveUint.parse(deployment.chainId);for(const a of [deployment.arbiter,deployment.asset,deployment.gate,deployment.reviewer])address.parse(a);digest.parse(deployment.committeeHash);
  }
  async read(orderId:string):Promise<OrderSnapshot> {
    const id=digest.parse(orderId) as Hex;
    if(String(await this.client.getChainId())!==this.deployment.chainId)throw new Error('CHAIN_MISMATCH');
    const block=await this.client.getBlock({blockTag:this.blockTag});
    if(block.number===null||block.hash===null)throw new Error('BLOCK_UNAVAILABLE');
    const args={address:this.deployment.arbiter,abi:escrowAbi,blockNumber:block.number};
    const [asset,gate,reviewer,committeeHash,o,locked,outstanding]=await Promise.all([
      this.client.readContract({...args,functionName:'asset'}),this.client.readContract({...args,functionName:'eligibility'}),
      this.client.readContract({...args,functionName:'reviewer'}),this.client.readContract({...args,functionName:'committeeHash'}),
      this.client.readContract({...args,functionName:'orders',args:[id]}),this.client.readContract({...args,functionName:'locked'}),
      this.client.readContract({...args,functionName:'outstanding'}),
    ]);
    const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
    if(!eq(asset,this.deployment.asset)||!eq(gate,this.deployment.gate)||!eq(reviewer,this.deployment.reviewer)||!eq(committeeHash,this.deployment.committeeHash))throw new Error('DEPLOYMENT_MISMATCH');
    const state=orderStates[o[12]];if(!state)throw new Error('STATE_INVALID');
    const [buyerCredit,payeeCredit,buyerWithdrawn,payeeWithdrawn,balance]=await Promise.all([
      this.client.readContract({...args,functionName:'credits',args:[id,o[1]]}),this.client.readContract({...args,functionName:'credits',args:[id,o[3]]}),
      this.client.readContract({...args,functionName:'withdrawn',args:[id,o[1]]}),this.client.readContract({...args,functionName:'withdrawn',args:[id,o[3]]}),
      this.client.readContract({address:asset,abi:erc20Balance,functionName:'balanceOf',args:[this.deployment.arbiter],blockNumber:block.number}),
    ]);
    if((await this.client.getBlock({blockNumber:block.number})).hash!==block.hash)throw new Error('CHAIN_SNAPSHOT_CHANGED');
    if(balance<locked+outstanding)throw new Error('ESCROW_INSOLVENT');
    return {chainId:this.deployment.chainId,arbiter:getAddress(this.deployment.arbiter),asset:getAddress(asset),orderId:id,contextHash:o[0],
      buyer:getAddress(o[1]),seller:getAddress(o[2]),payee:getAddress(o[3]),price:String(o[4]),bond:String(o[5]),deliveryDeadline:String(o[6]),settlementDeadline:String(o[7]),
      datasetHash:o[8],serviceTermsHash:o[9],evidenceHash:o[10],voteMask:o[11],state,
      credits:{buyer:String(buyerCredit),payee:String(payeeCredit)},withdrawn:{buyer:String(buyerWithdrawn),payee:String(payeeWithdrawn)},
      accounting:{locked:String(locked),outstanding:String(outstanding),balance:String(balance)},block:{number:String(block.number),hash:block.hash,timestamp:String(block.timestamp)}};
  }
  /** Historical original-order state only. The requested height must already be
   * finalized; this never submits, signs, checks current authorization expiry or
   * enables another payment. Default read/latest behavior remains separate.
   */
  async readAt(orderId:string,blockNumber:bigint):Promise<OrderSnapshot>{
    // Freeze every original target and operation before the first await.
    const id=digest.parse(orderId) as Hex;
    if(!validUint(blockNumber))throw new Error('HISTORICAL_BLOCK_NUMBER_INVALID');
    if(this.blockTag!=='finalized')throw new Error('HISTORICAL_FINALIZED_REQUIRED');
    const original=this.deployment,d=Object.freeze({chainId:positiveUint.parse(original.chainId),arbiter:address.parse(original.arbiter) as Address,
      asset:address.parse(original.asset) as Address,gate:address.parse(original.gate) as Address,reviewer:address.parse(original.reviewer) as Address,
      committeeHash:digest.parse(original.committeeHash) as Hex});
    const client=this.client,reads=Object.freeze({chainId:client.getChainId.bind(client),block:client.getBlock.bind(client),contract:client.readContract.bind(client)});
    const checkChain=async()=>{const chain=await reads.chainId();if(typeof chain!=='number'||!Number.isSafeInteger(chain)||String(chain)!==d.chainId)throw new Error('CHAIN_MISMATCH');};
    await checkChain();
    const tip=historicalBlock(await reads.block({blockTag:'finalized'}));
    if(blockNumber>tip.number)throw new Error('HISTORICAL_BLOCK_NOT_FINALIZED');
    const block=historicalBlock(await reads.block({blockNumber}));
    if(block.number!==blockNumber||blockNumber===tip.number&&!sameBlock(block,tip))throw new Error('CHAIN_SNAPSHOT_CHANGED');
    const args={address:d.arbiter,abi:escrowAbi,blockNumber};
    const [asset,gate,reviewer,members,observedOrder,locked,outstanding]=await Promise.all([
      reads.contract({...args,functionName:'asset'}),reads.contract({...args,functionName:'eligibility'}),
      reads.contract({...args,functionName:'reviewer'}),reads.contract({...args,functionName:'committeeHash'}),
      reads.contract({...args,functionName:'orders',args:[id]}),reads.contract({...args,functionName:'locked'}),reads.contract({...args,functionName:'outstanding'}),
    ]);
    const o=Object.freeze([...observedOrder]) as typeof observedOrder;
    if(!same(asset,d.asset)||!same(gate,d.gate)||!same(reviewer,d.reviewer)||!same(members,d.committeeHash))throw new Error('DEPLOYMENT_MISMATCH');
    const state=orderStates[o[12]];if(!state)throw new Error('STATE_INVALID');
    const [buyerCredit,payeeCredit,buyerWithdrawn,payeeWithdrawn,balance]=await Promise.all([
      reads.contract({...args,functionName:'credits',args:[id,o[1]]}),reads.contract({...args,functionName:'credits',args:[id,o[3]]}),
      reads.contract({...args,functionName:'withdrawn',args:[id,o[1]]}),reads.contract({...args,functionName:'withdrawn',args:[id,o[3]]}),
      reads.contract({address:d.asset,abi:erc20Balance,functionName:'balanceOf',args:[d.arbiter],blockNumber}),
    ]);
    const [endBlock,endTip]=await Promise.all([reads.block({blockNumber}),reads.block({blockNumber:tip.number})]);
    if(!sameBlock(block,historicalBlock(endBlock))||!sameBlock(tip,historicalBlock(endTip))||this.blockTag!=='finalized')throw new Error('CHAIN_SNAPSHOT_CHANGED');
    await checkChain();
    if(balance<locked+outstanding)throw new Error('ESCROW_INSOLVENT');
    return OrderSnapshotSchema.parse({chainId:d.chainId,arbiter:getAddress(d.arbiter),asset:getAddress(asset),orderId:id,contextHash:o[0],
      buyer:getAddress(o[1]),seller:getAddress(o[2]),payee:getAddress(o[3]),price:String(o[4]),bond:String(o[5]),deliveryDeadline:String(o[6]),settlementDeadline:String(o[7]),
      datasetHash:o[8],serviceTermsHash:o[9],evidenceHash:o[10],voteMask:o[11],state,
      credits:{buyer:String(buyerCredit),payee:String(payeeCredit)},withdrawn:{buyer:String(buyerWithdrawn),payee:String(payeeWithdrawn)},
      accounting:{locked:String(locked),outstanding:String(outstanding),balance:String(balance)},block:{number:String(block.number),hash:block.hash,timestamp:String(block.timestamp)}}) as OrderSnapshot;
  }
}
