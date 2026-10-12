import {z} from 'zod';
import {encodeFunctionData,hashTypedData} from 'viem';
import {AuthorizationPayloadSchema} from '../../capsule/src/format.js';
import {verifyOriginalAuthorization,RecoveryDeploymentSchema,type RecoveryDeployment} from '../../capsule/src/recovery.js';
import {OrderSnapshotSchema} from './escrow-read.js';
import {DeliveryRecordSchema,address,digest,positiveUint} from './schemas.js';
import {datasetSchema,createReport,reportSchema,reportHash,verifyReport} from './report.js';
import {deliveryHash,acceptanceTypedData,committeeHash,ZERO_HASH} from './escrow.js';
import {escrowAbi} from './escrow-abi.js';
export const DeliveryPrepareRequestSchema=z.object({payload:AuthorizationPayloadSchema,dataset:datasetSchema}).strict();
export const AcceptancePrepareRequestSchema=DeliveryPrepareRequestSchema.extend({report:reportSchema,memberIndex:z.number().int().min(0).max(2),expiresAt:positiveUint}).strict();
const observationSchema=z.object({snapshot:OrderSnapshotSchema,finality:z.enum(['finalized','latest'])}).strict();
const base={order:OrderSnapshotSchema,finality:z.literal('finalized'),delivery:DeliveryRecordSchema,report:reportSchema,evidenceHash:digest,chainId:positiveUint,target:address,canExecute:z.literal(false)};
export const DeliveryPreparationSchema=z.object({...base,kind:z.literal('DELIVERY_PREPARED'),actor:address,data:z.string().regex(/^0x[0-9a-fA-F]+$/),value:z.literal('0')}).strict();
export const AcceptancePreparationSchema=z.object({...base,kind:z.literal('ACCEPTANCE_PREPARED'),memberIndex:z.number().int().min(0).max(2),signer:address,committee:z.tuple([address,address,address]),expiresAt:positiveUint,voteDigest:digest}).strict();
const rejectSchema=z.object({status:z.literal('REJECT'),code:z.enum(['INPUT_INVALID','ROLE_MISMATCH'])}).strict();
export const DeliveryPrepareResponseSchema=z.union([DeliveryPreparationSchema,rejectSchema]);
export const AcceptancePrepareResponseSchema=z.union([AcceptancePreparationSchema,rejectSchema]);
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
async function original(input:unknown,d:RecoveryDeployment){const p=AuthorizationPayloadSchema.parse(input);return verifyOriginalAuthorization(p,[p.intent.buyer],d);}
function anchors(p:ReturnType<typeof AuthorizationPayloadSchema.parse>,o:ReturnType<typeof observationSchema.parse>,allowLocalLatest:boolean){const s=o.snapshot,e=p.intent;
  if(!allowLocalLatest&&o.finality!=='finalized'||s.chainId!==e.chainId||!eq(s.arbiter,e.arbiter)||!eq(s.asset,e.asset)||!eq(s.orderId,e.orderId)||!eq(s.contextHash,p.grant.contextHash)||(['buyer','seller','payee','datasetHash','serviceTermsHash'] as const).some(k=>!eq(s[k],e[k]))||(['price','bond','deliveryDeadline','settlementDeadline'] as const).some(k=>s[k]!==e[k]))throw new Error('FULFILLMENT_ORDER_MISMATCH');
}
export function reportDelivery(p:ReturnType<typeof AuthorizationPayloadSchema.parse>,dataset:unknown,candidate?:unknown){const expected=createReport(dataset);
  if(!eq(expected.datasetHash,p.intent.datasetHash))throw new Error('FULFILLMENT_DATASET_MISMATCH');
  const report=candidate===undefined?expected:reportSchema.parse(candidate);if(!verifyReport(dataset,report))throw new Error('FULFILLMENT_REPORT_MISMATCH');
  const delivery=DeliveryRecordSchema.parse({schemaVersion:1,orderId:p.intent.orderId,datasetHash:p.intent.datasetHash,reportHash:reportHash(report),serviceTermsHash:p.intent.serviceTermsHash});return {report,delivery,evidenceHash:deliveryHash(delivery)};
}
export function assertFulfillmentOrder(payload:unknown,order:unknown){anchors(AuthorizationPayloadSchema.parse(payload),{snapshot:OrderSnapshotSchema.parse(order),finality:'finalized'},false);}
export async function prepareDelivery(input:unknown,wallets:readonly string[],deployment:RecoveryDeployment,read:(id:string)=>Promise<unknown>,clock=()=>BigInt(Math.floor(Date.now()/1000)),allowLocalLatest=false){
  const request=DeliveryPrepareRequestSchema.parse(input),d=RecoveryDeploymentSchema.parse(deployment),p=await original(request.payload,d);
  if(!wallets.some(w=>eq(w,p.intent.seller)))throw new Error('FULFILLMENT_ROLE_MISMATCH');const result=reportDelivery(p,request.dataset);
  const observation=observationSchema.parse(await read(p.intent.orderId));anchors(p,observation,allowLocalLatest);const o=observation.snapshot;
  if(o.state!=='FUNDED'||o.voteMask!==0||!eq(o.evidenceHash,ZERO_HASH))throw new Error('FULFILLMENT_STATE_INVALID');
  if(clock()>BigInt(o.deliveryDeadline)||BigInt(o.block.timestamp)>BigInt(o.deliveryDeadline))throw new Error('FULFILLMENT_EXPIRED');
  const data=encodeFunctionData({abi:escrowAbi,functionName:'deliver',args:[{...result.delivery,schemaVersion:1n}] as never});
  return {kind:'DELIVERY_PREPARED' as const,order:o,finality:observation.finality,...result,actor:p.intent.seller,chainId:p.intent.chainId,target:p.intent.arbiter,data,value:'0' as const,canExecute:false as const};
}
export async function prepareAcceptance(input:unknown,wallets:readonly string[],deployment:RecoveryDeployment,read:(id:string)=>Promise<unknown>,clock=()=>BigInt(Math.floor(Date.now()/1000)),allowLocalLatest=false){
  const request=AcceptancePrepareRequestSchema.parse(input),d=RecoveryDeploymentSchema.parse(deployment),p=await original(request.payload,d),signer=d.committee[request.memberIndex];
  if(!wallets.some(w=>eq(w,signer)))throw new Error('FULFILLMENT_ROLE_MISMATCH');const result=reportDelivery(p,request.dataset,request.report);
  const observation=observationSchema.parse(await read(p.intent.orderId));anchors(p,observation,allowLocalLatest);const o=observation.snapshot;
  if(o.state!=='EVIDENCE_FROZEN'||![0,1,2,4].includes(o.voteMask))throw new Error('FULFILLMENT_STATE_INVALID');
  if(!eq(o.evidenceHash,result.evidenceHash))throw new Error('FULFILLMENT_EVIDENCE_MISMATCH');
  if(o.voteMask&(1<<request.memberIndex))throw new Error('FULFILLMENT_MEMBER_ALREADY_VOTED');
  const expiry=BigInt(request.expiresAt),now=clock();if(expiry<=now||expiry<BigInt(o.block.timestamp)||expiry>BigInt(o.settlementDeadline)||now>BigInt(o.settlementDeadline)||BigInt(o.block.timestamp)>BigInt(o.settlementDeadline))throw new Error('FULFILLMENT_EXPIRED');
  const voteDigest=hashTypedData(acceptanceTypedData({orderId:p.intent.orderId,contextHash:p.grant.contextHash,evidenceHash:result.evidenceHash,committeeHash:p.intent.committeeHash,expiresAt:request.expiresAt},d));
  return {kind:'ACCEPTANCE_PREPARED' as const,order:o,finality:observation.finality,...result,signer,committee:d.committee,memberIndex:request.memberIndex,expiresAt:request.expiresAt,voteDigest,chainId:d.chainId,target:d.arbiter,canExecute:false as const};
}
/** Validate original role/data/message anchors again on the SDK side. No execution grant. */
export function checkDeliveryPreparation(input:unknown,response:unknown){const request=DeliveryPrepareRequestSchema.parse(input),r=DeliveryPrepareResponseSchema.parse(response);if('status'in r)return r;const p=request.payload;
  anchors(p,{snapshot:r.order,finality:r.finality},false);const expected=reportDelivery(p,request.dataset);
  if(r.chainId!==p.intent.chainId||!eq(r.target,p.intent.arbiter)||!eq(r.actor,p.intent.seller)||JSON.stringify(r.delivery)!==JSON.stringify(expected.delivery)||reportHash(r.report)!==reportHash(expected.report)||!eq(r.evidenceHash,expected.evidenceHash)||r.order.state!=='FUNDED'||r.order.voteMask!==0||!eq(r.order.evidenceHash,ZERO_HASH)||r.data.toLowerCase()!==encodeFunctionData({abi:escrowAbi,functionName:'deliver',args:[{...expected.delivery,schemaVersion:1n}] as never}).toLowerCase())throw new Error('FULFILLMENT_RESPONSE_MISMATCH');return r;
}
export function checkAcceptancePreparation(input:unknown,response:unknown){const request=AcceptancePrepareRequestSchema.parse(input),r=AcceptancePrepareResponseSchema.parse(response);if('status'in r)return r;const p=request.payload;
  anchors(p,{snapshot:r.order,finality:r.finality},false);const expected=reportDelivery(p,request.dataset,request.report);
  const digest=hashTypedData(acceptanceTypedData({orderId:p.intent.orderId,contextHash:p.grant.contextHash,evidenceHash:expected.evidenceHash,committeeHash:p.intent.committeeHash,expiresAt:request.expiresAt},{chainId:p.intent.chainId,arbiter:p.intent.arbiter}));
  if(r.chainId!==p.intent.chainId||!eq(r.target,p.intent.arbiter)||!eq(committeeHash(r.committee),p.intent.committeeHash)||!eq(r.signer,r.committee[request.memberIndex])||r.memberIndex!==request.memberIndex||r.expiresAt!==request.expiresAt||JSON.stringify(r.delivery)!==JSON.stringify(expected.delivery)||reportHash(r.report)!==reportHash(expected.report)||!eq(r.evidenceHash,expected.evidenceHash)||!eq(r.voteDigest,digest)||r.order.state!=='EVIDENCE_FROZEN'||![0,1,2,4].includes(r.order.voteMask)||!!(r.order.voteMask&(1<<request.memberIndex))||!eq(r.order.evidenceHash,expected.evidenceHash))throw new Error('FULFILLMENT_RESPONSE_MISMATCH');return r;
}
