import type {IncomingMessage,ServerResponse} from 'node:http';
import {existsSync,renameSync} from 'node:fs';
import {resolve,isAbsolute} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {DemoQuotePlanSchema,DemoQuoteStatusSchema,type DemoQuotePlan} from '../../../packages/protocol/src/demo-quotes.js';
import {SignedQuoteSchema,digest} from '../../../packages/protocol/src/schemas.js';
import {verifyQuoteSignature} from '../../../packages/protocol/src/typed-data.js';
import {AuthenticationRejected,type Authenticator,type Principal} from '../../../packages/adapters/src/privy-auth.js';
import {privateServiceDirectory,readPrivateServiceJson,writePrivateServiceJsonOnce} from '../../../scripts/create-privy-service-wallets.js';
import type {BrowserApi} from './browser-api.js';
import {strictJsonParse} from '../../../scripts/strict-json.js';
const fail=(code:string):never=>{throw Error('DEMO_QUOTE_'+code);};
/** Fixed two-quote issuer book. Reservations and signed originals survive logout,
 * restart and unknown wallet results; this server cannot invoke a wallet. */
export class DemoQuoteBook {
  readonly plan:DemoQuotePlan;
  constructor(private readonly directory:string,private readonly catalogue:string,private readonly clock:()=>bigint=()=>BigInt(Math.floor(Date.now()/1000))){
    if(catalogue!==resolve(directory,'catalogue.json'))fail('CATALOGUE_PATH_INVALID');
    privateServiceDirectory(directory);this.plan=DemoQuotePlanSchema.parse(readPrivateServiceJson(resolve(directory,'plan.json')));
  }
  private selected(id:string){const quoteId=digest.parse(id).toLowerCase(),entry=this.plan.quotes.find(e=>e.quote.quoteId.toLowerCase()===quoteId);if(!entry)return fail('NOT_FOUND');return entry;}
  private path(id:string,kind:'reserved'|'signed'){return resolve(this.directory,digest.parse(id).slice(2).toLowerCase()+'.'+kind+'.json');}
  private active(){if(!isDeepStrictEqual(this.plan,DemoQuotePlanSchema.parse(readPrivateServiceJson(resolve(this.directory,'plan.json')))))fail('PLAN_CHANGED');}
  private owned(p:Principal){if(!p.wallets.some(a=>a.toLowerCase()===this.plan.seller.toLowerCase()))fail('SELLER_LOGIN_REQUIRED');}
  private signed(id:string){const path=this.path(id,'signed');if(!existsSync(path))return undefined;const q=SignedQuoteSchema.parse(readPrivateServiceJson(path)),{signature,...unsigned}=q;if(!isDeepStrictEqual(unsigned,this.selected(id).quote))fail('RECORD_INVALID');return q;}
  private async publish(){
    const signed=this.plan.quotes.map(e=>this.signed(e.quote.quoteId));if(signed.some(q=>!q))return;
    for(const q of signed)if(!await verifyQuoteSignature(q!,{chainId:this.plan.chainId,arbiter:this.plan.arbiter}))fail('RECORD_SIGNATURE_INVALID');this.active();
    const entries=signed.map(q=>({quote:q!,documents:[{id:'current-quote-terms',subjectQuoteId:q!.quoteId,text:q!.serviceTerms}]}));
    const current=readPrivateServiceJson(this.catalogue) as {entries:unknown[]};if(isDeepStrictEqual(current,{entries}))return;
    if(current.entries.length)fail('EXISTING_CATALOGUE_MISMATCH');
    const temporary=resolve(this.directory,'catalogue-'+randomUUID()+'.json');writePrivateServiceJsonOnce(temporary,{entries});renameSync(temporary,this.catalogue);
  }
  async status(principal:Principal){this.active();for(const e of this.plan.quotes){const q=this.signed(e.quote.quoteId);if(q&&!await verifyQuoteSignature(q,{chainId:this.plan.chainId,arbiter:this.plan.arbiter}))fail('RECORD_SIGNATURE_INVALID');}await this.publish();const quotes=this.plan.quotes.map(e=>({quoteId:e.quote.quoteId,status:this.signed(e.quote.quoteId)?'SIGNED' as const:existsSync(this.path(e.quote.quoteId,'reserved'))?'RESERVED' as const:'UNSIGNED' as const,expired:BigInt(e.quote.expiresAt)<=this.clock()}));return DemoQuoteStatusSchema.parse({plan:this.plan,canSign:principal.wallets.some(a=>a.toLowerCase()===this.plan.seller.toLowerCase()),quotes,catalogReady:quotes.every(q=>q.status==='SIGNED'&&!q.expired)});}
  reserve(id:string,principal:Principal){
    this.active();this.owned(principal);const entry=this.selected(id);if(this.signed(id))return {created:false,status:'SIGNED' as const};if(BigInt(entry.quote.expiresAt)<=this.clock())fail('EXPIRED');
    const path=this.path(id,'reserved');if(existsSync(path))return {created:false,status:'RESERVED' as const};
    const record={schemaVersion:1,planId:this.plan.planId,subject:principal.subject,quote:entry.quote,createdAt:new Date().toISOString()};
    try{writePrivateServiceJsonOnce(path,record);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')return {created:false,status:'RESERVED' as const};throw error;}return {created:true,status:'RESERVED' as const};
  }
  async record(input:unknown,principal:Principal){
    this.active();this.owned(principal);const q=SignedQuoteSchema.parse(input),entry=this.selected(q.quoteId),{signature,...unsigned}=q;
    if(!isDeepStrictEqual(unsigned,entry.quote))fail('SCOPE_MISMATCH');const previous=this.signed(q.quoteId);
    if(previous){if(!isDeepStrictEqual(previous,q)||!await verifyQuoteSignature(previous,{chainId:this.plan.chainId,arbiter:this.plan.arbiter}))fail('SIGNATURE_CHANGED');await this.publish();return {status:'SIGNED' as const};}
    const reservation=readPrivateServiceJson(this.path(q.quoteId,'reserved')) as {subject?:string;planId?:string;quote?:unknown};
    if(reservation.subject!==principal.subject||reservation.planId!==this.plan.planId||!isDeepStrictEqual(reservation.quote,unsigned))fail('RESERVATION_MISMATCH');
    if(BigInt(q.expiresAt)<=this.clock()||!await verifyQuoteSignature(q,{chainId:this.plan.chainId,arbiter:this.plan.arbiter}))fail('SIGNATURE_INVALID');
    this.active();if(BigInt(q.expiresAt)<=this.clock())fail('EXPIRED');
    const path=this.path(q.quoteId,'signed');try{writePrivateServiceJsonOnce(path,q);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||!isDeepStrictEqual(this.signed(q.quoteId),q))throw error;}
    await this.publish();return {status:'SIGNED' as const};
  }
}
export interface DemoQuoteApi {auth:Authenticator;book:DemoQuoteBook;}
export function configuredDemoQuoteApi(env:NodeJS.ProcessEnv,browser?:BrowserApi):DemoQuoteApi|undefined {
  if(!env.DEMO_QUOTE_DIRECTORY)return undefined;const d=browser?.configuration.recoveryDeployment;
  if(!browser||!d||!isAbsolute(env.DEMO_QUOTE_DIRECTORY)||!env.QUOTE_CATALOG_PATH||!isAbsolute(env.QUOTE_CATALOG_PATH))return fail('CONFIGURATION_INVALID');
  const book=new DemoQuoteBook(env.DEMO_QUOTE_DIRECTORY,env.QUOTE_CATALOG_PATH);
  if(book.plan.chainId!==d.chainId||book.plan.arbiter.toLowerCase()!==d.arbiter.toLowerCase()||book.plan.asset.toLowerCase()!==d.asset.toLowerCase()||!d.committee.some(a=>a.toLowerCase()===book.plan.seller.toLowerCase()))fail('DEPLOYMENT_MISMATCH');return {auth:browser.auth,book};
}
export async function serveDemoQuote(req:IncomingMessage,res:ServerResponse,action:'list'|'reserve'|'record',api:DemoQuoteApi){
  const send=(status:number,body:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
  if(req.method!==(action==='list'?'GET':'POST'))return send(405,{code:'METHOD_NOT_ALLOWED'});
  const header=req.headers.authorization;if(!header?.startsWith('Bearer ')||header.length>16400)return send(401,{code:'AUTHENTICATION_REQUIRED'});
  try{
    const principal=await api.auth.authenticate(header.slice(7));if(action==='list')return send(200,await api.book.status(principal));
    if(req.headers['content-type']!=='application/json')return send(415,{code:'JSON_REQUIRED'});
    let size=0;const chunks:Buffer[]=[];for await(const chunk of req){size+=chunk.length;if(size>65536)return send(413,{code:'BODY_TOO_LARGE'});chunks.push(Buffer.from(chunk));}
    const body=strictJsonParse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks)));
    if(action==='reserve'){const input=z.object({quoteId:digest}).strict().parse(body);return send(200,api.book.reserve(input.quoteId,principal));}
    return send(200,await api.book.record(z.object({quote:SignedQuoteSchema}).strict().parse(body).quote,principal));
  }catch(error){if(error instanceof AuthenticationRejected)return send(401,{code:'AUTHENTICATION_REJECTED'});const code=error instanceof Error&&/^DEMO_QUOTE_[A-Z_]+$/.test(error.message)?error.message:'DEMO_QUOTE_UNAVAILABLE';return send(code==='DEMO_QUOTE_SELLER_LOGIN_REQUIRED'?403:409,{code});}
}
