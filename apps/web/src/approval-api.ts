import type {IncomingMessage,ServerResponse} from 'node:http';
import {ApprovalReserveRequestSchema,ApprovalReconcileRequestSchema,ApprovalReceiptSchema,type ApprovalRecord} from '../../../packages/protocol/src/approval-api.js';
import {prepareExactApproval} from '../../../packages/capsule/src/asset-approval.js';
import {verifyOriginalAuthorization,type RecoveryDeployment} from '../../../packages/capsule/src/recovery.js';
import type {ApprovalStore} from '../../../packages/storage/src/approval-store.js';
import type {Authenticator,Principal} from '../../../packages/adapters/src/privy-auth.js';
import {serveAuthenticatedJson} from './auth-json-api.js';
export interface ApprovalApi {auth:Authenticator;deployment:RecoveryDeployment;store:ApprovalStore;preflight:(request:unknown)=>Promise<unknown>;receipt:(input:unknown,wallets:string[],step:'RESET'|'SET',hash:string)=>Promise<unknown>;clock?:()=>bigint;}
export function serveApproval(req:IncomingMessage,res:ServerResponse,action:'reserve'|'reconcile',api:ApprovalApi){
  return serveAuthenticatedJson(req,res,{auth:api.auth,failureCode:'APPROVAL_SERVICE_UNAVAILABLE',invoke:async(input,principal)=>{
    const parsed=(action==='reserve'?ApprovalReserveRequestSchema:ApprovalReconcileRequestSchema).safeParse(input);
    if(!parsed.success)return {status:'REJECT',code:'INPUT_INVALID'};
    const {payload,step}=parsed.data;
    if(!principal.wallets.some(w=>w.toLowerCase()===payload.grant.owner.toLowerCase()))return {status:'REJECT',code:'OWNER_MISMATCH'};
    // Historical verification allows reconciliation after expiry, not a fresh reservation.
    await verifyOriginalAuthorization(payload,principal.wallets,api.deployment);
    const g=payload.grant,expected:ApprovalRecord={orderId:g.orderId,contextHash:g.contextHash,nonce:g.nonce,chainId:g.chainId,asset:g.asset,owner:g.owner,spender:g.arbiter,amount:step==='RESET'?'0':g.amount,step,status:'RESERVED',hash:null};
    if(action==='reserve'){
      const old=api.store.get(principal.subject,g.orderId,step);
      if(old){return api.store.reserve(principal.subject,expected);}
      try{await prepareExactApproval(payload,api.deployment,principal.wallets,await api.preflight({intent:payload.intent,grant:g}),step,api.clock?.()??BigInt(Math.floor(Date.now()/1000)));}
      catch(error){if(error instanceof Error&&/^(AUTHORIZATION_EXPIRED|APPROVAL_CHAIN_BLOCKED|APPROVAL_PREFLIGHT_MISMATCH|EXACT_ALLOWANCE_ALREADY_SET|ALLOWANCE_RESET_NOT_REQUIRED|ALLOWANCE_RESET_REQUIRED)$/.test(error.message))return {status:'REJECT',code:'APPROVAL_BLOCKED'};throw error;}
      return api.store.reserve(principal.subject,expected);
    }
    return reconcile(api,principal,ApprovalReconcileRequestSchema.parse(parsed.data),expected);
  }});
}
async function reconcile(api:ApprovalApi,principal:Principal,input:ReturnType<typeof ApprovalReconcileRequestSchema.parse>,expected:ApprovalRecord){
  const old=api.store.get(principal.subject,expected.orderId,expected.step);if(!old)return {status:'REJECT',code:'APPROVAL_ATTEMPT_REQUIRED'};
  const reserved=api.store.reserve(principal.subject,expected).record;
  if(reserved.hash&&reserved.hash.toLowerCase()!==input.hash.toLowerCase())return {status:'REJECT',code:'APPROVAL_RECORD_CONFLICT'};
  const receipt=ApprovalReceiptSchema.parse(await api.receipt(input.payload,principal.wallets,input.step,input.hash));
  if(receipt.hash.toLowerCase()!==input.hash.toLowerCase())throw new Error('APPROVAL_RECEIPT_MISMATCH');
  if(receipt.status==='PENDING'){
    // A temporarily lagging/unavailable node cannot undo a recorded final receipt.
    if(reserved.status!=='RESERVED')throw new Error('APPROVAL_TERMINAL_OBSERVATION_UNAVAILABLE');
    return {record:reserved,receipt};
  }
  if(receipt.orderId.toLowerCase()!==expected.orderId.toLowerCase()||receipt.step!==expected.step||receipt.approvedAmount!==expected.amount||receipt.exactAllowance!==(receipt.currentAllowance===input.payload.grant.amount))throw new Error('APPROVAL_RECEIPT_MISMATCH');
  return {record:api.store.resolve(principal.subject,{...expected,status:receipt.status,hash:receipt.hash}),receipt};
}
