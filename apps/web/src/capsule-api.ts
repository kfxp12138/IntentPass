import type {IncomingMessage,ServerResponse} from 'node:http';
import {z} from 'zod';
import {AuthenticationRejected,type Authenticator} from '../../../packages/adapters/src/privy-auth.js';
import {CapsuleFileSchema} from '../../../packages/capsule/src/format.js';
import {CapsuleStore,CapsuleConflict} from '../../../packages/storage/src/capsule-store.js';
import {digest,uint} from '../../../packages/protocol/src/schemas.js';
export interface CapsuleApi {auth:Authenticator;store:CapsuleStore;}
const UploadSchema=z.object({expectedRevision:uint,file:CapsuleFileSchema}).strict();
export async function serveCapsule(req:IncomingMessage,res:ServerResponse,id:string,api:CapsuleApi) {
  const send=(status:number,body:unknown)=>{if(res.destroyed)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
  if(req.method!=='GET'&&req.method!=='PUT')return send(405,{code:'METHOD_NOT_ALLOWED'});
  const token=req.headers.authorization;
  if(!token?.startsWith('Bearer ')||token.length>16400)return send(401,{code:'AUTHENTICATION_REQUIRED'});
  try {
    const principal=await api.auth.authenticate(token.slice(7));
    if(!digest.safeParse(id).success)return send(400,{code:'CAPSULE_ID_INVALID'});
    if(req.method==='GET') {
      const file=api.store.get(principal.subject,id);
      return file?send(200,{file}):send(404,{code:'CAPSULE_NOT_FOUND'});
    }
    if(req.headers['content-type']?.split(';')[0].trim()!=='application/json')return send(415,{code:'JSON_REQUIRED'});
    req.setTimeout(10000,()=>req.destroy());
    const chunks:Buffer[]=[];let size=0;
    for await(const chunk of req){const value=Buffer.from(chunk);size+=value.length;if(size>1500000){req.resume();return send(413,{code:'INPUT_TOO_LARGE'});}chunks.push(value);}
    req.setTimeout(0);
    let input;try{input=UploadSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{return send(400,{code:'CAPSULE_INPUT_INVALID'});}
    if(input.file.capsule.objectId.toLowerCase()!==id.toLowerCase())return send(400,{code:'CAPSULE_ID_MISMATCH'});
    return send(200,{file:api.store.put(principal.subject,input.file,input.expectedRevision)});
  }catch(error) {
    if(error instanceof AuthenticationRejected)return send(401,{code:'AUTHENTICATION_REJECTED'});
    if(error instanceof CapsuleConflict)return send(409,{code:error.message});
    return send(503,{code:'CAPSULE_SERVICE_UNAVAILABLE'});
  }
}
