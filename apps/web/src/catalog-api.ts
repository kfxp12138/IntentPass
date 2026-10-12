import type {IncomingMessage,ServerResponse} from 'node:http';
import {readFileSync,statSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {CatalogResponseSchema} from '../../../packages/protocol/src/purchase-api.js';
import {EvidenceBundleSchema} from '../../../packages/protocol/src/review-evidence.js';
import {AuthenticationRejected,type Authenticator} from '../../../packages/adapters/src/privy-auth.js';
import type {QuoteCatalog} from './services/propose.js';
export class FileQuoteCatalog implements QuoteCatalog {
  constructor(private readonly path:string) {
    if(!isAbsolute(path)||!path.endsWith('.json'))throw new Error('CATALOG_PATH_INVALID');
    this.read();
  }
  private read(){const stat=statSync(this.path);if(!stat.isFile()||stat.size>1500000)throw new Error('CATALOG_INVALID');const entries=CatalogResponseSchema.parse(JSON.parse(readFileSync(this.path,'utf8'))).entries;for(const e of entries)EvidenceBundleSchema.parse({schemaVersion:1,taskText:'Catalog validation',documents:e.documents});return entries;}
  async get(id:string){return this.read().find(e=>e.quote.quoteId.toLowerCase()===id.toLowerCase());}
  async list(){return {entries:this.read()};}
}
export interface CatalogApi {auth:Authenticator;list:()=>Promise<unknown>;}
export async function serveCatalog(req:IncomingMessage,res:ServerResponse,api:CatalogApi) {
  const send=(status:number,body:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
  if(req.method!=='GET')return send(405,{code:'METHOD_NOT_ALLOWED'});
  const token=req.headers.authorization;if(!token?.startsWith('Bearer ')||token.length>16400)return send(401,{code:'AUTHENTICATION_REQUIRED'});
  try{await api.auth.authenticate(token.slice(7));return send(200,CatalogResponseSchema.parse(await api.list()));}
  catch(error){return send(error instanceof AuthenticationRejected?401:503,{code:error instanceof AuthenticationRejected?'AUTHENTICATION_REJECTED':'CATALOG_UNAVAILABLE'});}
}
