import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Authenticator} from '../../../packages/adapters/src/privy-auth.js';
import type {ReviewService} from './services/review.js';
import {serveAuthenticatedJson} from './auth-json-api.js';
export interface ReviewApi {auth:Authenticator;service:ReviewService;}
export function serveReview(req:IncomingMessage,res:ServerResponse,api:ReviewApi) {
  return serveAuthenticatedJson(req,res,{auth:api.auth,invoke:(input,principal)=>api.service.review(input,principal),failureCode:'REVIEW_SERVICE_UNAVAILABLE'});
}
