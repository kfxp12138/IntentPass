import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Authenticator} from '../../../packages/adapters/src/privy-auth.js';
import type {ProposalService} from './services/propose.js';
import {serveAuthenticatedJson} from './auth-json-api.js';
export interface ProposeApi {auth:Authenticator;service:ProposalService;}
export function serveProposal(req:IncomingMessage,res:ServerResponse,api:ProposeApi) {
  return serveAuthenticatedJson(req,res,{auth:api.auth,invoke:(input,principal)=>api.service.propose(input,principal),failureCode:'PROPOSAL_SERVICE_UNAVAILABLE'});
}
