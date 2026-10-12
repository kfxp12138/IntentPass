import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Authenticator} from '../../../packages/adapters/src/privy-auth.js';
import {prepareAuthorization,type AuthorizationContext} from '../../../packages/capsule/src/authorization.js';
import {OrderPrepareRequestSchema,OrderPreparedSchema} from '../../../packages/protocol/src/order-preparation.js';
import {serveAuthenticatedJson} from './auth-json-api.js';
export interface OrderPreparationApi {auth:Authenticator;deployment:AuthorizationContext['deployment'];rule:AuthorizationContext['rule'];clock?:()=>bigint;}
export function serveOrderPreparation(req:IncomingMessage,res:ServerResponse,api:OrderPreparationApi){return serveAuthenticatedJson(req,res,{auth:api.auth,failureCode:'ORDER_PREPARATION_UNAVAILABLE',invoke:async(input,principal)=>{
  const r=OrderPrepareRequestSchema.safeParse(input);if(!r.success)return {status:'REJECT',code:'INPUT_INVALID'};
  if(!principal.wallets.some(w=>w.toLowerCase()===r.data.request.intent.buyer.toLowerCase()))return {status:'REJECT',code:'OWNER_MISMATCH'};
  try{
    const now=api.clock?.()??BigInt(Math.floor(Date.now()/1000)),prepared=await prepareAuthorization(r.data,{authenticatedWallets:principal.wallets,deployment:api.deployment,rule:api.rule,now});
    const current=api.clock?.()??BigInt(Math.floor(Date.now()/1000));if(current<now||current>=BigInt(prepared.payload.grant.deadline))return {status:'REJECT',code:'PREPARATION_BLOCKED'};
    return OrderPreparedSchema.parse({payload:prepared.payload,chainStatusChecked:false,canSubmitPayment:false});
  }catch{return {status:'REJECT',code:'PREPARATION_BLOCKED'};}
}});}
