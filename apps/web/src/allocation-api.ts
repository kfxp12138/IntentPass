import type {IncomingMessage,ServerResponse} from 'node:http';
import {AllocationRequestSchema,verifyAllocationRequest} from '../../../packages/protocol/src/allocation.js';
import type {AllocationReader} from '../../../packages/capsule/src/allocation-read.js';
import type {RecoveryDeployment} from '../../../packages/capsule/src/recovery.js';
import type {Authenticator} from '../../../packages/adapters/src/privy-auth.js';
import type {SettlementStore} from '../../../packages/storage/src/settlement-store.js';
import {SettlementWorker,type SettlementPort} from '../../worker/src/settlement.js';
import {originalAllocationPort} from '../../worker/src/original-allocation-port.js';
import {serveAuthenticatedJson} from './auth-json-api.js';
import {AllocationTriggerRequestSchema as triggerSchema,AllocationAttemptReconcileRequestSchema as reconcileSchema,checkAllocationResponse} from '../../../packages/protocol/src/allocation-api.js';
export interface AllocationApi {auth:Authenticator;deployment:RecoveryDeployment;reader:AllocationReader;store:SettlementStore;port:SettlementPort;}
/** Query never registers an order, leases a send, signs, or broadcasts. There is
 * deliberately no retry/reset endpoint for failed or unknown original attempts.
 */
export function serveAllocation(req:IncomingMessage,res:ServerResponse,action:'prepare'|'trigger'|'query'|'reconcile',api:AllocationApi){return serveAuthenticatedJson(req,res,{auth:api.auth,failureCode:'ALLOCATION_SERVICE_UNAVAILABLE',invoke:async(input,principal)=>{
  const parsed=(action==='trigger'?triggerSchema:action==='reconcile'?reconcileSchema:AllocationRequestSchema).safeParse(input);if(!parsed.success)return {status:'REJECT',code:'INPUT_INVALID'};
  const request={payload:parsed.data.payload};await verifyAllocationRequest(request,principal.wallets,api.deployment);
  const prepared=await api.reader.prepare(request,principal.wallets);if(action==='prepare')return prepared;
  const e=request.payload.intent,g=request.payload.grant,key=`${e.chainId}:${e.arbiter.toLowerCase()}:${e.orderId.toLowerCase()}`;
  let record=api.store.get(key);
  if(action==='reconcile'){
    const hash=reconcileSchema.parse(parsed.data).hash;
    if(!record?.attempt||!record.action)return {status:'REJECT',code:'ALLOCATION_ATTEMPT_REQUIRED'};
    if(record.txHash&&record.txHash.toLowerCase()!==hash.toLowerCase())return {status:'REJECT',code:'ALLOCATION_RECORD_CONFLICT'};
    const proof=await api.reader.read({...request,action:record.action,hash},principal.wallets);
    if(!record.txHash){if(proof.status==='PENDING')return {record,preparation:prepared,receipt:proof,canExecute:false};api.store.provenBroadcast(key,record.attempt,record.action,hash);record=api.store.get(key)!;}
  }
  if(action==='query'&&!record)return checkAllocationResponse(request,{record:null,preparation:prepared,receipt:null,canExecute:false});
  const confirmedAction=action==='trigger'?triggerSchema.parse(parsed.data).action:undefined;
  if((!record||record.status==='IDLE')&&action==='trigger'&&(prepared.blockers.length||prepared.action!==confirmedAction))return {status:'REJECT',code:'ALLOCATION_BLOCKED'};
  if(!record){record=api.store.register({chainId:e.chainId,arbiter:e.arbiter,orderId:e.orderId,contextHash:g.contextHash,buyer:e.buyer,seller:e.seller,payee:e.payee});}
  const worker=new SettlementWorker(api.store,originalAllocationPort(api.reader,api.port,request.payload,principal.wallets,confirmedAction));
  const observation=await worker.runOnce(key,action==='trigger');record=api.store.get(key)!;
  const receipt=record.txHash&&record.action?await api.reader.read({...request,action:record.action,hash:record.txHash},principal.wallets):null;
  return checkAllocationResponse(request,{record,observation,preparation:prepared,receipt,canExecute:false});
}});}
