import {decodeEventLog,encodeFunctionData,TransactionNotFoundError,TransactionReceiptNotFoundError,type Hex,type PublicClient} from 'viem';
import {verifyOriginalAuthorization,type RecoveryDeployment} from './recovery.js';
import {DeliveryReconcileRequestSchema,deliveryRecord,checkDeliveryReceipt} from '../../protocol/src/delivery-api.js';
import {escrowAbi} from '../../protocol/src/escrow-abi.js';
import {reportDelivery} from '../../protocol/src/fulfillment.js';
import {committeeHash} from '../../protocol/src/escrow.js';
import type {EscrowReader} from '../../protocol/src/escrow-read.js';
const eventAbi=[{type:'event',name:'EvidenceFrozen',inputs:[{name:'orderId',type:'bytes32',indexed:true},{name:'evidenceHash',type:'bytes32',indexed:false}]}] as const;
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export class DeliveryReader {
  constructor(private client:PublicClient,private deployment:RecoveryDeployment,private orderReader:EscrowReader){if(orderReader.client!==client||orderReader.blockTag!=='finalized'||orderReader.deployment.chainId!==deployment.chainId||!eq(orderReader.deployment.arbiter,deployment.arbiter)||!eq(orderReader.deployment.asset,deployment.asset)||!eq(orderReader.deployment.reviewer,deployment.reviewer)||!eq(orderReader.deployment.committeeHash,committeeHash(deployment.committee)))throw new Error('DELIVERY_READER_CONFIGURATION_INVALID');}
  async read(input:unknown,wallets:readonly string[]){const request=DeliveryReconcileRequestSchema.parse(input),p=await verifyOriginalAuthorization(request.payload,[request.payload.intent.buyer],this.deployment);if(!wallets.some(w=>eq(w,p.intent.seller)))throw new Error('FULFILLMENT_ROLE_MISMATCH');const r=deliveryRecord(request),hash=request.hash as Hex;
    if(String(await this.client.getChainId())!==r.chainId)throw new Error('CHAIN_MISMATCH');
    let tx,receipt;try{[tx,receipt]=await Promise.all([this.client.getTransaction({hash}),this.client.getTransactionReceipt({hash})]);}catch(e){if(e instanceof TransactionNotFoundError||e instanceof TransactionReceiptNotFoundError)return {status:'PENDING' as const,hash,canSubmitPayment:false as const};throw e;}
    const {delivery}=reportDelivery(p,request.dataset),data=encodeFunctionData({abi:escrowAbi,functionName:'deliver',args:[{...delivery,schemaVersion:1n}] as never});
    if(!eq(tx.hash,hash)||!eq(receipt.transactionHash,hash)||!tx.to||!eq(tx.to,r.arbiter)||!eq(tx.from,r.seller)||tx.input.toLowerCase()!==data.toLowerCase()||tx.value!==0n||String(tx.chainId)!==r.chainId||tx.blockNumber!==receipt.blockNumber||tx.blockHash!==receipt.blockHash)throw new Error('DELIVERY_TRANSACTION_MISMATCH');
    const final=await this.client.getBlock({blockTag:'finalized'});if(final.number===null||!final.hash)throw new Error('BLOCK_UNAVAILABLE');if(receipt.blockNumber>final.number)return {status:'PENDING' as const,hash,canSubmitPayment:false as const};
    if((await this.client.getBlock({blockNumber:receipt.blockNumber})).hash!==receipt.blockHash)throw new Error('CHAIN_SNAPSHOT_CHANGED');
    if(receipt.status==='success'){
      const matching=receipt.logs.filter(log=>{if(log.removed||!eq(log.address,r.arbiter))return false;try{const event=decodeEventLog({abi:eventAbi,data:log.data,topics:log.topics,strict:true});return eq(event.args.orderId,r.orderId)&&eq(event.args.evidenceHash,r.evidenceHash);}catch{return false;}});if(matching.length!==1)throw new Error('DELIVERY_EFFECT_UNPROVEN');
    }
    const order=await this.orderReader.read(r.orderId);if(BigInt(order.block.number)<final.number||BigInt(order.block.number)<receipt.blockNumber)throw new Error('CHAIN_SNAPSHOT_CHANGED');
    if((await this.client.getBlock({blockNumber:final.number})).hash!==final.hash||(await this.client.getBlock({blockNumber:receipt.blockNumber})).hash!==receipt.blockHash)throw new Error('CHAIN_SNAPSHOT_CHANGED');
    return checkDeliveryReceipt(request,{status:receipt.status==='success'?'CONFIRMED':'REVERTED',hash,order,receiptBlock:{number:String(receipt.blockNumber),hash:receipt.blockHash},finality:'finalized',canSubmitPayment:false});
  }
}
