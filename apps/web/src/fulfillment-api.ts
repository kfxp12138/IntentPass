import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Authenticator} from '../../../packages/adapters/src/privy-auth.js';
import type {RecoveryDeployment} from '../../../packages/capsule/src/recovery.js';
import {DeliveryPrepareRequestSchema,AcceptancePrepareRequestSchema,prepareDelivery,prepareAcceptance,DeliveryPrepareResponseSchema,AcceptancePrepareResponseSchema} from '../../../packages/protocol/src/fulfillment.js';
import type {OrderSnapshot} from '../../../packages/protocol/src/escrow-read.js';
import {serveAuthenticatedJson} from './auth-json-api.js';
export interface FulfillmentApi {auth:Authenticator;deployment:RecoveryDeployment;read:(id:string)=>Promise<OrderSnapshot>;clock?:()=>bigint;}
export function serveFulfillment(req:IncomingMessage,res:ServerResponse,action:'delivery'|'acceptance',api:FulfillmentApi){return serveAuthenticatedJson(req,res,{auth:api.auth,failureCode:'FULFILLMENT_SERVICE_UNAVAILABLE',invoke:async(input,principal)=>{
  const parsed=(action==='delivery'?DeliveryPrepareRequestSchema:AcceptancePrepareRequestSchema).safeParse(input);if(!parsed.success)return {status:'REJECT',code:'INPUT_INVALID'};
  const actor=action==='delivery'?parsed.data.payload.intent.seller:api.deployment.committee[AcceptancePrepareRequestSchema.parse(parsed.data).memberIndex];if(!principal.wallets.some(w=>w.toLowerCase()===actor.toLowerCase()))return {status:'REJECT',code:'ROLE_MISMATCH'};
  const read=async(id:string)=>({snapshot:await api.read(id),finality:'finalized'});
  return action==='delivery'?DeliveryPrepareResponseSchema.parse(await prepareDelivery(parsed.data,principal.wallets,api.deployment,read,api.clock)):AcceptancePrepareResponseSchema.parse(await prepareAcceptance(parsed.data,principal.wallets,api.deployment,read,api.clock));
}});}
