import type {IncomingMessage,ServerResponse} from 'node:http';
import {AuthenticationRejected,type Authenticator} from '../../../packages/adapters/src/privy-auth.js';
import type {Principal} from '../../../packages/adapters/src/privy-auth.js';
export interface JsonApi {auth:Authenticator;invoke:(input:unknown,principal:Principal)=>Promise<unknown>;failureCode:string;maxInputBytes?:number;}
export async function serveAuthenticatedJson(req:IncomingMessage,res:ServerResponse,api:JsonApi) {
  const send=(status:number,body:unknown)=>{if(res.destroyed)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
  if(req.method!=='POST')return send(405,{code:'METHOD_NOT_ALLOWED'});
  const token=req.headers.authorization;
  if(!token?.startsWith('Bearer ')||token.length>16400)return send(401,{code:'AUTHENTICATION_REQUIRED'});
  try {
    const principal=await api.auth.authenticate(token.slice(7));
    if(req.headers['content-type']?.split(';')[0].trim()!=='application/json')return send(415,{code:'JSON_REQUIRED'});
    req.setTimeout(10000,()=>req.destroy());
    const chunks:Buffer[]=[];let size=0;
    for await(const chunk of req){const value=Buffer.from(chunk);size+=value.length;if(size>(api.maxInputBytes??1048576)){req.resume();return send(413,{code:'INPUT_TOO_LARGE'});}chunks.push(value);}
    req.setTimeout(0);
    let input:unknown;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return send(400,{code:'JSON_INVALID'});}
    return send(200,await api.invoke(input,principal));
  }catch(error){return send(error instanceof AuthenticationRejected?401:503,{code:error instanceof AuthenticationRejected?'AUTHENTICATION_REJECTED':api.failureCode});}
}
