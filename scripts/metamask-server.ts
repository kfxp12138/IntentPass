import http from 'node:http';
import type {MetaMaskStatus,MetaMaskGateStatus,MetaMaskAttempt,MetaMaskPreflight} from './metamask-types.js';
import {MetaMaskPreflightRejected,MetaMaskNoReservationResponseSchema} from './metamask-preflight-rejection.js';
export type MetaMaskStaticFile={body:Buffer;contentType:string};
export interface MetaMaskOperatorService{
  status():MetaMaskStatus|MetaMaskGateStatus;
  preflight():Promise<MetaMaskPreflight>;
  reserve(input:unknown):Promise<{attempt:MetaMaskAttempt;preflight:MetaMaskPreflight}>;
  recordHash(input:unknown):MetaMaskAttempt;
  reconcile():Promise<unknown>;
}
export function createMetaMaskServer(options:{service?:MetaMaskOperatorService;scope?:MetaMaskStatus['scope']|MetaMaskGateStatus['scope'];blockers?:string[];staticFiles:Map<string,MetaMaskStaticFile>}){
  let closing=false;
  const server=http.createServer((req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const send=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    const address=server.address(),host=typeof address==='object'&&address?`127.0.0.1:${address.port}`:'';
    if(closing)return send(503,{code:'SERVICE_UNAVAILABLE'});
    if(req.headers.host!==host)return send(403,{code:'LOCAL_HOST_REQUIRED'});
    if(req.headers.origin&&req.headers.origin!==`http://${host}`||req.headers['sec-fetch-site']==='cross-site')return send(403,{code:'LOCAL_ORIGIN_REQUIRED'});
    if(!req.url||req.url.includes('?')||req.url.includes('%')||req.url.includes('\\')||req.url.includes('..'))return send(400,{code:'PATH_REJECTED'});
    if(req.method==='GET'){
      if(req.url==='/api/status'){try{return send(200,options.service?.status()??{scope:options.scope??'LOCAL_OPERATOR_METAMASK_DEPLOYMENT_HANDOFF',ready:false,blockers:options.blockers??['DEPLOYMENT_CONFIGURATION_REQUIRED'],plan:null,attempt:null,officialIntegrationVerified:false,transactionsSentByServer:0} satisfies MetaMaskStatus|MetaMaskGateStatus);}catch{return send(503,{code:'DEPLOYMENT_STATE_UNAVAILABLE'});}}
      const file=options.staticFiles.get(req.url);if(!file)return send(404,{code:'NOT_FOUND'});
      res.writeHead(200,{'Content-Type':file.contentType});res.end(file.body);return;
    }
    if(req.method!=='POST')return send(405,{code:'METHOD_NOT_ALLOWED'});
    if(req.headers.origin!==`http://${host}`)return send(403,{code:'LOCAL_ORIGIN_REQUIRED'});
    if(req.headers['content-type']!=='application/json')return send(415,{code:'JSON_REQUIRED'});
    if(!['/api/preflight','/api/reserve','/api/record-hash','/api/reconcile'].includes(req.url))return send(404,{code:'NOT_FOUND'});
    if(!options.service)return send(503,{code:'DEPLOYMENT_CONFIGURATION_REQUIRED'});
    if(Number(req.headers['content-length']??0)>4096)return send(413,{code:'BODY_TOO_LARGE'});
    const chunks:Buffer[]=[];let bytes=0,ended=false;
    req.on('data',chunk=>{if(ended)return;bytes+=chunk.length;if(bytes>4096){ended=true;send(413,{code:'BODY_TOO_LARGE'});req.resume();}else chunks.push(chunk);});
    req.on('error',()=>{if(!ended){ended=true;send(400,{code:'BODY_INVALID'});}});
    req.on('end',()=>{if(ended)return;ended=true;void(async()=>{
      try{
        const raw=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)),keys=[...raw.matchAll(/("(?:[^"\\]|\\.)*")\s*:/g)].map(m=>JSON.parse(m[1]) as string);
        if(new Set(keys).size!==keys.length)return send(400,{code:'DUPLICATE_FIELD_REJECTED'});
        const body=JSON.parse(raw),service=options.service!;
        if((req.url==='/api/preflight'||req.url==='/api/reconcile')&&(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length))return send(400,{code:'EMPTY_BODY_REQUIRED'});
        const result=req.url==='/api/preflight'?await service.preflight():req.url==='/api/reserve'?await service.reserve(body):req.url==='/api/record-hash'?service.recordHash(body):await service.reconcile();
        send(200,result);
      }catch(error){
        if(req.url==='/api/reserve'&&error instanceof MetaMaskPreflightRejected){
          const known=MetaMaskNoReservationResponseSchema.safeParse({code:error.message,reservationOutcome:'NOT_CREATED_BY_THIS_REQUEST',signaturesRequested:0,transactionsSent:0});
          if(known.success)return send(409,known.data);
        }
        const message=error instanceof Error?error.message:'';const code=/^(?:DEPLOYMENT|METAMASK|SOURCE|BOOTSTRAP)_[A-Z_]+$/.test(message)?message:'DEPLOYMENT_CHECK_UNAVAILABLE_OR_INVALID_INPUT';send(409,{code});
      }
    })();});
  });
  return {server,close:async()=>{closing=true;server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error&&(error as NodeJS.ErrnoException).code!=='ERR_SERVER_NOT_RUNNING'?reject(error):resolve()));}};
}
