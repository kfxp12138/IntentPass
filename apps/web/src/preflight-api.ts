import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Authenticator} from '../../../packages/adapters/src/privy-auth.js';
import {PreflightRequestSchema,type PreflightSnapshot} from '../../../packages/protocol/src/purchase-preflight.js';
import {serveAuthenticatedJson} from './auth-json-api.js';
export interface PreflightApi {auth:Authenticator;read:(input:unknown)=>Promise<PreflightSnapshot>;}
export function servePreflight(req:IncomingMessage,res:ServerResponse,api:PreflightApi) {
  return serveAuthenticatedJson(req,res,{auth:api.auth,failureCode:'PREFLIGHT_SERVICE_UNAVAILABLE',invoke:async(input,principal)=>{
    const parsed=PreflightRequestSchema.safeParse(input);if(!parsed.success)return {status:'REJECT',code:'INPUT_INVALID'};
    if(!principal.wallets.some(w=>w.toLowerCase()===parsed.data.intent.buyer.toLowerCase()))return {status:'REJECT',code:'OWNER_MISMATCH'};
    return api.read(parsed.data);
  }});
}
