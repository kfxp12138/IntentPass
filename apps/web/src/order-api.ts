import type {IncomingMessage,ServerResponse} from 'node:http';
import {AuthenticationRejected,type Authenticator} from '../../../packages/adapters/src/privy-auth.js';
import type {OrderSnapshot} from '../../../packages/protocol/src/escrow-read.js';
import {digest} from '../../../packages/protocol/src/schemas.js';
import {OriginalOrderReadProofSchema,verifyOriginalOrderReadProof,checkOriginalOrderReadSnapshot,type OriginalOrderReadDeployment} from '../../../packages/protocol/src/original-order-read.js';
import {serveAuthenticatedJson} from './auth-json-api.js';
export interface OrderApi {auth:Authenticator;read:(id:string)=>Promise<OrderSnapshot>;deployment?:OriginalOrderReadDeployment;}
export function serveOriginalOrder(req:IncomingMessage,res:ServerResponse,id:string,api:OrderApi&{deployment:OriginalOrderReadDeployment}) {
  return serveAuthenticatedJson(req,res,{auth:api.auth,maxInputBytes:16384,failureCode:'ORDER_SERVICE_UNAVAILABLE',invoke:async(input,principal)=>{
    if(!digest.safeParse(id).success)return {status:'REJECT',code:'ORDER_ID_INVALID'};
    const parsed=OriginalOrderReadProofSchema.safeParse(input);if(!parsed.success)return {status:'REJECT',code:'ORDER_READ_PROOF_INVALID'};
    const p=parsed.data;if(p.intent.orderId.toLowerCase()!==id.toLowerCase())return {status:'REJECT',code:'ORDER_ID_MISMATCH'};
    if(!principal.wallets.some(wallet=>wallet.toLowerCase()===p.intent.buyer.toLowerCase()))return {status:'REJECT',code:'ORDER_ACCESS_DENIED'};
    try{await verifyOriginalOrderReadProof(p,api.deployment);}catch{return {status:'REJECT',code:'ORDER_READ_PROOF_INVALID'};}
    return checkOriginalOrderReadSnapshot(p,await api.read(id));
  }});
}
export async function serveOrder(req:IncomingMessage,res:ServerResponse,id:string,api:OrderApi) {
  const send=(status:number,code:string,body?:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body??{code}));};
  if(req.method!=='GET')return send(405,'METHOD_NOT_ALLOWED');
  const authorization=req.headers.authorization;
  if(!authorization?.startsWith('Bearer ')||authorization.length>16400)return send(401,'AUTHENTICATION_REQUIRED');
  try {
    const principal=await api.auth.authenticate(authorization.slice(7));
    if(!digest.safeParse(id).success)return send(400,'ORDER_ID_INVALID');
    const order=await api.read(id);
    if(order.state==='UNREGISTERED')return send(404,'ORDER_NOT_FOUND');
    if(!principal.wallets.some(wallet=>[order.buyer,order.seller,order.payee].some(a=>a.toLowerCase()===wallet.toLowerCase())))return send(403,'ORDER_ACCESS_DENIED');
    return send(200,'OK',order);
  }catch(error){return send(error instanceof AuthenticationRejected?401:503,error instanceof AuthenticationRejected?'AUTHENTICATION_REJECTED':'ORDER_SERVICE_UNAVAILABLE');}
}
