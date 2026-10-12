import type {IncomingMessage,ServerResponse} from 'node:http';
import {DeliveryReserveRequestSchema,DeliveryReconcileRequestSchema,OrderDeliveryRequestSchema,deliveryRecord,checkDeliveryReceipt} from '../../../packages/protocol/src/delivery-api.js';
import {prepareDelivery,reportDelivery} from '../../../packages/protocol/src/fulfillment.js';
import {verifyOriginalAuthorization,type RecoveryDeployment} from '../../../packages/capsule/src/recovery.js';
import type {DeliveryStore} from '../../../packages/storage/src/delivery-store.js';
import type {OrderSnapshot} from '../../../packages/protocol/src/escrow-read.js';
import {digest} from '../../../packages/protocol/src/schemas.js';
import type {Authenticator,Principal} from '../../../packages/adapters/src/privy-auth.js';
import {serveAuthenticatedJson} from './auth-json-api.js';
export interface DeliveryApi {auth:Authenticator;deployment:RecoveryDeployment;store:DeliveryStore;read:(id:string)=>Promise<OrderSnapshot>;receipt:(request:unknown,wallets:readonly string[])=>Promise<unknown>;clock?:()=>bigint;}
async function deliveryAction(input:unknown,principal:Principal,action:'reserve'|'reconcile',api:DeliveryApi){
  const parsed=(action==='reserve'?DeliveryReserveRequestSchema:DeliveryReconcileRequestSchema).safeParse(input);if(!parsed.success)return {status:'REJECT',code:'INPUT_INVALID'};
  const request=parsed.data,p=request.payload;if(!principal.wallets.some(w=>w.toLowerCase()===p.intent.seller.toLowerCase()))return {status:'REJECT',code:'ROLE_MISMATCH'};
  await verifyOriginalAuthorization(p,[p.intent.buyer],api.deployment);const expected=deliveryRecord(request);
  try{
    const old=api.store.get(principal.subject,expected);
    if(action==='reserve'){
      if(old)return api.store.reserve(principal.subject,expected);
      try{await prepareDelivery(request,principal.wallets,api.deployment,async id=>({snapshot:await api.read(id),finality:'finalized'}),api.clock);}
      catch(e){if(e instanceof Error&&/^(FULFILLMENT_STATE_INVALID|FULFILLMENT_EXPIRED|FULFILLMENT_ORDER_MISMATCH)$/.test(e.message))return {status:'REJECT',code:'DELIVERY_BLOCKED'};throw e;}
      return api.store.reserve(principal.subject,expected);
    }
    if(!old)return {status:'REJECT',code:'DELIVERY_ATTEMPT_REQUIRED'};const query=DeliveryReconcileRequestSchema.parse(request);
    if(old.hash&&old.hash.toLowerCase()!==query.hash.toLowerCase())return {status:'REJECT',code:'DELIVERY_RECORD_CONFLICT'};
    const receipt=checkDeliveryReceipt(query,await api.receipt(query,principal.wallets));if(receipt.status==='PENDING'){if(old.status!=='RESERVED')throw new Error('DELIVERY_RECEIPT_UNAVAILABLE');return {record:old,receipt};}
    return {record:api.store.resolve(principal.subject,{...expected,status:receipt.status,hash:receipt.hash}),receipt};
  }catch(e){if(e instanceof Error&&e.message==='DELIVERY_RECORD_CONFLICT')return {status:'REJECT',code:'DELIVERY_RECORD_CONFLICT'};throw e;}
}
export function serveDelivery(req:IncomingMessage,res:ServerResponse,action:'reserve'|'reconcile',api:DeliveryApi){return serveAuthenticatedJson(req,res,{auth:api.auth,failureCode:'DELIVERY_SERVICE_UNAVAILABLE',invoke:(input,principal)=>deliveryAction(input,principal,action,api)});}
export function serveOrderDelivery(req:IncomingMessage,res:ServerResponse,orderId:string,api:DeliveryApi){return serveAuthenticatedJson(req,res,{auth:api.auth,failureCode:'DELIVERY_SERVICE_UNAVAILABLE',invoke:async(input,principal)=>{
  const parsed=OrderDeliveryRequestSchema.safeParse(input);if(!parsed.success||!digest.safeParse(orderId).success)return {status:'REJECT',code:'INPUT_INVALID'};const r=parsed.data;
  if(r.payload.intent.orderId.toLowerCase()!==orderId.toLowerCase())return {status:'REJECT',code:'ORDER_ID_MISMATCH'};
  if(!principal.wallets.some(w=>w.toLowerCase()===r.payload.intent.seller.toLowerCase()))return {status:'REJECT',code:'ROLE_MISMATCH'};
  try{reportDelivery(r.payload,r.dataset,r.report);}catch{return {status:'REJECT',code:'INPUT_INVALID'};}
  return deliveryAction({payload:r.payload,dataset:r.dataset,...(r.hash?{hash:r.hash}:{})},principal,r.hash?'reconcile':'reserve',api);
}});}
