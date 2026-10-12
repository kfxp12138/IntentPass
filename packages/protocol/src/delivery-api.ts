import {z} from 'zod';
import {encodeFunctionData,keccak256} from 'viem';
import {address,digest,positiveUint,uint} from './schemas.js';
import {DeliveryPrepareRequestSchema,reportDelivery,assertFulfillmentOrder} from './fulfillment.js';
import {escrowAbi} from './escrow-abi.js';
import {OrderSnapshotSchema} from './escrow-read.js';
import {reportSchema} from './report.js';
export const DeliveryReserveRequestSchema=DeliveryPrepareRequestSchema;
export const DeliveryReconcileRequestSchema=DeliveryPrepareRequestSchema.extend({hash:digest}).strict();
export const OrderDeliveryRequestSchema=DeliveryPrepareRequestSchema.extend({report:reportSchema,hash:digest.optional()}).strict();
export const DeliveryRecordSchema=z.object({chainId:positiveUint,arbiter:address,asset:address,orderId:digest,contextHash:digest,seller:address,datasetHash:digest,reportHash:digest,serviceTermsHash:digest,evidenceHash:digest,dataHash:digest,status:z.enum(['RESERVED','CONFIRMED','REVERTED']),hash:digest.nullable()}).strict().superRefine((r,c)=>{if((r.status==='RESERVED')!==(r.hash===null))c.addIssue({code:'custom',message:'DELIVERY_RECORD_INCONSISTENT'});});
export type DeliveryRecord=z.infer<typeof DeliveryRecordSchema>;
export function deliveryRecord(input:unknown):DeliveryRecord{
  const {payload:p,dataset}=z.union([DeliveryReserveRequestSchema,DeliveryReconcileRequestSchema]).parse(input),result=reportDelivery(p,dataset),data=encodeFunctionData({abi:escrowAbi,functionName:'deliver',args:[{...result.delivery,schemaVersion:1n}] as never});
  return DeliveryRecordSchema.parse({chainId:p.intent.chainId,arbiter:p.intent.arbiter,asset:p.intent.asset,orderId:p.intent.orderId,contextHash:p.grant.contextHash,seller:p.intent.seller,datasetHash:p.intent.datasetHash,reportHash:result.delivery.reportHash,serviceTermsHash:p.intent.serviceTermsHash,evidenceHash:result.evidenceHash,dataHash:keccak256(data),status:'RESERVED',hash:null});
}
export const DeliveryReceiptSchema=z.union([
  z.object({status:z.literal('PENDING'),hash:digest,canSubmitPayment:z.literal(false)}).strict(),
  z.object({status:z.enum(['CONFIRMED','REVERTED']),hash:digest,order:OrderSnapshotSchema,receiptBlock:z.object({number:uint,hash:digest}).strict(),finality:z.literal('finalized'),canSubmitPayment:z.literal(false)}).strict(),
]);
const reject=z.object({status:z.literal('REJECT'),code:z.enum(['INPUT_INVALID','ROLE_MISMATCH','ORDER_ID_MISMATCH','DELIVERY_BLOCKED','DELIVERY_ATTEMPT_REQUIRED','DELIVERY_RECORD_CONFLICT'])}).strict();
export const DeliveryReserveResponseSchema=z.union([z.object({created:z.boolean(),record:DeliveryRecordSchema}).strict().superRefine((r,c)=>{if(r.created&&r.record.status!=='RESERVED')c.addIssue({code:'custom',message:'DELIVERY_RESERVATION_INCONSISTENT'});}),reject]);
export const DeliveryReconcileResponseSchema=z.union([z.object({record:DeliveryRecordSchema,receipt:DeliveryReceiptSchema}).strict(),reject]);
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export function checkDeliveryRecord(input:unknown,record:unknown){const expected=deliveryRecord(input),r=DeliveryRecordSchema.parse(record);for(const k of Object.keys(expected) as (keyof DeliveryRecord)[])if(k!=='status'&&k!=='hash'&&!eq(String(expected[k]),String(r[k])))throw new Error('DELIVERY_RESPONSE_MISMATCH');return r;}
export function checkDeliveryReceipt(input:unknown,receipt:unknown){const request=DeliveryReconcileRequestSchema.parse(input),r=DeliveryReceiptSchema.parse(receipt);if(!eq(r.hash,request.hash))throw new Error('DELIVERY_RESPONSE_MISMATCH');if(r.status==='PENDING')return r;
  assertFulfillmentOrder(request.payload,r.order);if(BigInt(r.receiptBlock.number)>BigInt(r.order.block.number)||r.receiptBlock.number===r.order.block.number&&!eq(r.receiptBlock.hash,r.order.block.hash))throw new Error('DELIVERY_RESPONSE_MISMATCH');
  if(r.status==='CONFIRMED'&&(!eq(r.order.evidenceHash,deliveryRecord(request).evidenceHash)||['UNREGISTERED','FUNDED'].includes(r.order.state)))throw new Error('DELIVERY_EFFECT_UNPROVEN');return r;
}
