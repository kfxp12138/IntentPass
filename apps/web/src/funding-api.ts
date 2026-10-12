import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Authenticator} from '../../../packages/adapters/src/privy-auth.js';
import {FundingSubmitRequestSchema,FundingReconcileRequestSchema,checkFundingResponse} from '../../../packages/protocol/src/funding-api.js';
import type {FundingWorker} from '../../worker/src/funding.js';
import {serveAuthenticatedJson} from './auth-json-api.js';
export interface FundingApi {auth:Authenticator;worker:FundingWorker;}
export function serveFunding(req:IncomingMessage,res:ServerResponse,action:'submit'|'reconcile',api:FundingApi,canonical=false){return serveAuthenticatedJson(req,res,{auth:api.auth,failureCode:'FUNDING_SERVICE_UNAVAILABLE',invoke:async(input,principal)=>{
  const parsed=(action==='submit'?FundingSubmitRequestSchema:FundingReconcileRequestSchema).safeParse(input);if(!parsed.success)return {status:'REJECT',code:'INPUT_INVALID'};
  const {payload}=parsed.data;if(!principal.wallets.some(w=>w.toLowerCase()===payload.grant.owner.toLowerCase()))return {status:'REJECT',code:'OWNER_MISMATCH'};
  const result=action==='submit'?await api.worker.submit(payload,principal.wallets):await api.worker.reconcile(payload,principal.wallets,FundingReconcileRequestSchema.parse(parsed.data).hash);
  const checked=checkFundingResponse(payload,result);return canonical&&'record'in checked?{...checked,submissionId:checked.record.attempt,txHash:checked.record.hash}:checked;
}});}
