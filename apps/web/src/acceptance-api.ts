import type {IncomingMessage,ServerResponse} from 'node:http';
import {AcceptanceReserveRequestSchema,AcceptanceSignatureRequestSchema,acceptanceRecord,verifyAcceptanceSignature} from '../../../packages/protocol/src/acceptance-api.js';
import {prepareAcceptance} from '../../../packages/protocol/src/fulfillment.js';
import {verifyOriginalAuthorization,type RecoveryDeployment} from '../../../packages/capsule/src/recovery.js';
import type {AcceptanceStore} from '../../../packages/storage/src/acceptance-store.js';
import type {OrderSnapshot} from '../../../packages/protocol/src/escrow-read.js';
import type {Authenticator} from '../../../packages/adapters/src/privy-auth.js';
import {serveAuthenticatedJson} from './auth-json-api.js';
export interface AcceptanceApi {auth:Authenticator;deployment:RecoveryDeployment;store:AcceptanceStore;read:(id:string)=>Promise<OrderSnapshot>;clock?:()=>bigint;}
export function serveAcceptance(req:IncomingMessage,res:ServerResponse,action:'reserve'|'query'|'signature',api:AcceptanceApi){return serveAuthenticatedJson(req,res,{auth:api.auth,failureCode:'ACCEPTANCE_SERVICE_UNAVAILABLE',invoke:async(input,principal)=>{
  const parsed=(action==='signature'?AcceptanceSignatureRequestSchema:AcceptanceReserveRequestSchema).safeParse(input);if(!parsed.success)return {status:'REJECT',code:'INPUT_INVALID'};const request=parsed.data,p=request.payload,actor=api.deployment.committee[request.memberIndex];if(!principal.wallets.some(w=>w.toLowerCase()===actor.toLowerCase()))return {status:'REJECT',code:'ROLE_MISMATCH'};
  await verifyOriginalAuthorization(p,[p.intent.buyer],api.deployment);const expected=acceptanceRecord(request,api.deployment.committee);
  try{const old=api.store.get(principal.subject,expected);
    if(action==='query')return {record:old??null,canExecute:false};
    if(action==='signature'){
      if(!old)return {status:'REJECT',code:'ACCEPTANCE_ATTEMPT_REQUIRED'};let signed;
      try{signed=await verifyAcceptanceSignature(request,api.deployment.committee);}catch(e){if(e instanceof Error&&e.message==='ACCEPTANCE_SIGNATURE_INVALID')return {status:'REJECT',code:'ACCEPTANCE_SIGNATURE_INVALID'};throw e;}
      // Records a verified historical signature digest, even if expired/voted. Never sends.
      return {record:api.store.signed(principal.subject,signed),canExecute:false};
    }
    if(old)return {...api.store.reserve(principal.subject,expected),canExecute:false};
    try{await prepareAcceptance(request,principal.wallets,api.deployment,async id=>({snapshot:await api.read(id),finality:'finalized'}),api.clock);}
    catch(e){if(e instanceof Error&&/^(FULFILLMENT_STATE_INVALID|FULFILLMENT_EXPIRED|FULFILLMENT_ORDER_MISMATCH|FULFILLMENT_EVIDENCE_MISMATCH|FULFILLMENT_MEMBER_ALREADY_VOTED)$/.test(e.message))return {status:'REJECT',code:'ACCEPTANCE_BLOCKED'};throw e;}
    return {...api.store.reserve(principal.subject,expected),canExecute:false};
  }catch(e){if(e instanceof Error&&e.message==='ACCEPTANCE_RECORD_CONFLICT')return {status:'REJECT',code:'ACCEPTANCE_RECORD_CONFLICT'};throw e;}
}});}
