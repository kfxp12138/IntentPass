import {PrivyClient} from '@privy-io/node';
import {isDeepStrictEqual} from 'node:util';
import {PrivyOriginConfigSchema,ProviderIdSchema,type PrivyOriginConfig} from '../../protocol/src/day4-origin-types.js';
import {digest} from '../../protocol/src/schemas.js';
import {Day4PolicyProbeCallSchema,Day4PolicyProbeAttemptSchema,day4PolicyProbeKey,
  type Day4PolicyProbeCall,type Day4PolicyProbeAttempt,type Day4PolicyProbeJournal,type Day4PolicyProbeProvider} from '../../protocol/src/day4-policy-probe-types.js';
import {strictJsonParse} from '../../../scripts/strict-json.js';

export interface Day4PolicyProbeProviderConfig extends PrivyOriginConfig {
  appId:string;appSecret:string;authorizationPrivateKey:string;sensitiveValues?:readonly string[];
}
const origin='https://api.privy.io';
const bodyLimit=64*1024,headerLimit=8*1024;
const fail=(code:string):never=>{throw Error('DAY4_POLICY_PROBE_'+code);};
function freeze<T>(value:T):T{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const sameAddress=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const headerPairs=(headers:Headers):[string,string][]=>{const pairs:[string,string][]=[];headers.forEach((value,name)=>pairs.push([name,value]));return pairs;};

/** The injected fetch is for explicit local tests. Production callers omit it.
 * Only this adapter's fixed SDK requests can reach the captured transport. */
export function day4PolicyProbeProvider(configInput:Day4PolicyProbeProviderConfig,
  transactionIdsInput:{funding:string;allocation:string},journalInput:Day4PolicyProbeJournal,
  options:{fetch?:typeof globalThis.fetch}={}):Day4PolicyProbeProvider{
  let config:Day4PolicyProbeProviderConfig,ids:{funding:string;allocation:string};
  let journal:Day4PolicyProbeJournal,network:typeof globalThis.fetch;
  try{
    config=freeze(structuredClone(configInput));ids=freeze(structuredClone(transactionIdsInput));
    const {appId,appSecret,authorizationPrivateKey,sensitiveValues,...publicConfig}=config;
    PrivyOriginConfigSchema.parse(publicConfig);
    if(![appId,appSecret].every(value=>typeof value==='string'&&value.length>0)||typeof authorizationPrivateKey!=='string'
      ||sensitiveValues!==undefined&&(!Array.isArray(sensitiveValues)||!sensitiveValues.every(value=>typeof value==='string'))
      ||Object.keys(ids).sort().join(',')!=='allocation,funding'||!ProviderIdSchema.safeParse(ids.funding).success
      ||!ProviderIdSchema.safeParse(ids.allocation).success||ids.funding===ids.allocation)return fail('CONFIGURATION_INVALID');
    network=options.fetch??globalThis.fetch;if(typeof network!=='function')return fail('CONFIGURATION_INVALID');
    journal=Object.freeze({get:journalInput.get.bind(journalInput),reserve:journalInput.reserve.bind(journalInput),
      recordResponse:journalInput.recordResponse.bind(journalInput),markUnknown:journalInput.markUnknown.bind(journalInput),
      recordUnexpectedHash:journalInput.recordUnexpectedHash.bind(journalInput)});
  }catch{return fail('CONFIGURATION_INVALID');}
  const sensitive=Object.freeze([...new Set([config.appSecret,config.authorizationPrivateKey,...config.sensitiveValues??[]].filter(Boolean))]);
  const containsSensitive=(value:unknown,extra:readonly string[]=[]):boolean=>{
    if(typeof value==='string')return [...sensitive,...extra].some(secret=>value.includes(secret)
      ||/^0x[0-9a-f]+$/i.test(secret)&&value.toLowerCase().includes(secret.toLowerCase()));
    return !!value&&typeof value==='object'&&Object.values(value).some(item=>containsSensitive(item,extra));
  };
  if(containsSensitive([config.walletId,config.policyId,config.signerId,config.address,config.arbiter,ids.funding,ids.allocation]))return fail('CONFIGURATION_INVALID');
  const rpcUrl=`${origin}/v1/wallets/${config.walletId}/rpc`;
  const getUrls=new Set([`${origin}/v1/wallets/${config.walletId}`,`${origin}/v1/policies/${config.policyId}`,
    `${origin}/v1/transactions/${ids.funding}`,`${origin}/v1/transactions/${ids.allocation}`]);
  let attempt:Day4PolicyProbeAttempt|null=null,walletRpcAttempts:0|1=0,captureStarted=false,priorAttempt=false;
  let expectedBody:unknown=null,hashWriteAttempted=false;
  const snapshot=()=>freeze({attempt:attempt===null?null:structuredClone(attempt),walletRpcAttempts,priorAttempt});
  const update=(fields:Partial<Day4PolicyProbeAttempt>)=>{
    if(!attempt)return fail('JOURNAL_INVALID');
    attempt=freeze(Day4PolicyProbeAttemptSchema.parse({...attempt,...fields,
      updatedAt:new Date(Math.max(Date.now(),Date.parse(attempt.updatedAt))).toISOString()}));
  };
  const checkedRecord=(input:unknown):Day4PolicyProbeAttempt=>{
    let next:Day4PolicyProbeAttempt;
    try{next=freeze(Day4PolicyProbeAttemptSchema.parse(structuredClone(input)));}catch{return fail('JOURNAL_INVALID');}
    if(containsSensitive(next)||attempt&&(next.key!==attempt.key||next.attemptId!==attempt.attemptId||next.createdAt!==attempt.createdAt
      ||!isDeepStrictEqual(next.call,attempt.call)||Date.parse(next.updatedAt)<Date.parse(attempt.createdAt)))return fail('JOURNAL_INVALID');
    return next;
  };
  const unknown=()=>{
    if(!attempt)return fail('JOURNAL_INVALID');
    if(attempt.transactionHash!==null)return;
    update({status:'OUTCOME_UNKNOWN'});
    try{
      const next=checkedRecord(journal.markUnknown(attempt.key,attempt.attemptId));
      if(next.status!=='OUTCOME_UNKNOWN'||next.transactionHash!==null||next.rawResponseStored!==attempt.rawResponseStored
        ||next.rawResponseStored&&next.httpStatus!==attempt.httpStatus)return fail('JOURNAL_INVALID');
    }catch{/* The reservation remains consumed; only the public in-memory outcome is retained. */}
  };
  const observeHash=(hash:string)=>{
    if(!attempt)return fail('JOURNAL_INVALID');
    const canonical=digest.parse(hash).toLowerCase();
    if(attempt.transactionHash!==null&&attempt.transactionHash!==canonical)return fail('HASH_CONFLICT');
    // Save locally before any callback can fail, then request durable hash storage.
    update({status:'UNEXPECTED_BROADCAST',transactionHash:canonical,transactionHashStored:attempt.transactionHashStored});
    if(attempt.transactionHashStored||hashWriteAttempted)return;hashWriteAttempted=true;
    try{
      const next=checkedRecord(journal.recordUnexpectedHash(attempt.key,attempt.attemptId,canonical));
      if(next.status!=='UNEXPECTED_BROADCAST'||next.transactionHash!==canonical||!next.transactionHashStored)return fail('JOURNAL_INVALID');
      update({transactionHashStored:true});
    }catch{/* snapshot() still exposes the original observed hash, without claiming storage. */}
  };
  const readBody=async(response:Response):Promise<Uint8Array>=>{
    const reader=response.body?.getReader();if(!reader)return new Uint8Array();
    const chunks:Uint8Array[]=[];let size=0;const read=reader.read.bind(reader),cancel=reader.cancel.bind(reader),release=reader.releaseLock.bind(reader);
    try{for(;;){const part=await read();if(part.done)break;size+=part.value.byteLength;
      if(size>bodyLimit)return fail('RESPONSE_INVALID');chunks.push(Uint8Array.from(part.value));}}
    catch{try{await cancel();}catch{}return fail('RESPONSE_INVALID');}
    finally{release();}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
  };
  const transport:typeof globalThis.fetch=async(input,init)=>{
    let url:string,method:string,headers:Headers,body:string|undefined,forward:RequestInit;
    try{
      if(typeof input!=='string'||!init)return fail('REQUEST_INVALID');
      url=input;method=init.method??'GET';headers=new Headers(init.headers);
      if(headers.get('privy-app-id')!==config.appId||headers.get('authorization')!==`Basic ${Buffer.from(`${config.appId}:${config.appSecret}`).toString('base64')}`
        ||headers.get('x-stainless-retry-count')!=='0')return fail('REQUEST_INVALID');
      if(method==='GET'){
        if(!getUrls.has(url)||init.body!==undefined)return fail('REQUEST_INVALID');
      }else{
        if(method!=='POST'||url!==rpcUrl||!attempt||expectedBody===null||walletRpcAttempts!==0
          ||typeof init.body!=='string'||Buffer.byteLength(init.body)>bodyLimit
          ||headers.get('privy-idempotency-key')!==attempt.attemptId||!headers.get('privy-authorization-signature')
          ||!isDeepStrictEqual(strictJsonParse(init.body),expectedBody))return fail('REQUEST_INVALID');
        body=init.body;
      }
      forward=Object.freeze({method,headers:Object.freeze(Object.fromEntries(headerPairs(headers))),...(body===undefined?{}:{body}),
        signal:init.signal,redirect:'error'});
    }catch{return fail('REQUEST_INVALID');}
    if(method==='POST')walletRpcAttempts=1; // Set before awaiting the only possible forwarded send.
    const response=await network.call(undefined,url,forward);
    let pairs:readonly (readonly [string,string])[],bytes:Uint8Array,decoded:unknown,status:number,validJson=false,text='',jsonContentType=false;
    try{
      status=response.status;const responseHeaders=new Headers(response.headers);
      if(response.redirected||response.url!==url||!Number.isInteger(status)||status<100||status>599)return fail('RESPONSE_INVALID');
      jsonContentType=/^application\/json(?:\s*;|\s*$)/i.test(responseHeaders.get('content-type')??'');
      pairs=Object.freeze(headerPairs(responseHeaders).map(pair=>Object.freeze(pair)));
      if(pairs.reduce((size,[name,value])=>size+Buffer.byteLength(name)+Buffer.byteLength(value)+4,0)>headerLimit)return fail('RESPONSE_INVALID');
      const length=responseHeaders.get('content-length');
      if(length!==null&&(!/^(?:0|[1-9][0-9]*)$/.test(length)||BigInt(length)>BigInt(bodyLimit)))return fail('RESPONSE_INVALID');
      bytes=await readBody(response);text=new TextDecoder().decode(bytes);
      try{decoded=strictJsonParse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));validJson=true;}catch{/* Preserve bounded unknown bytes privately, never classify them. */}
    }catch{return fail('RESPONSE_INVALID');}
    if(method==='GET'&&(!jsonContentType||!validJson))return fail('RESPONSE_INVALID');
    if(method==='POST'){
      update({httpStatus:status,status:'OUTCOME_UNKNOWN'});
      // Only the documented successful RPC envelope can establish an unexpected hash.
      if(jsonContentType&&validJson&&status>=200&&status<300&&object(decoded)&&decoded.method==='eth_sendTransaction'&&object(decoded.data)
        &&decoded.data.caip2==='eip155:10143'&&digest.safeParse(decoded.data.hash).success&&!containsSensitive(decoded.data.hash))observeHash(decoded.data.hash as string);
      const requestSecrets=[headers.get('authorization')!,headers.get('privy-authorization-signature')!];
      // Audit every JSON string token as well: duplicate or malformed JSON must
      // not hide an escaped credential in a member JSON.parse would discard.
      const tokens=[...text.matchAll(/"(?:[^"\\]|\\.)*"/g)].map(match=>{try{return JSON.parse(match[0]) as unknown;}catch{return match[0];}});
      if(containsSensitive(text,requestSecrets)||containsSensitive(tokens,requestSecrets)||containsSensitive(decoded,requestSecrets)||pairs.some(([name,value])=>/^(?:authorization|privy-authorization-signature)$/i.test(name)
        ||containsSensitive(value,requestSecrets)))return fail('RESPONSE_INVALID');
      try{
        const next=checkedRecord(journal.recordResponse(attempt!.key,attempt!.attemptId,status,Uint8Array.from(bytes),pairs));
        if(!next.rawResponseStored||next.httpStatus!==status||next.status!==(next.transactionHash===null?'HTTP_CAPTURED':'UNEXPECTED_BROADCAST')
          ||next.transactionHash!==null&&next.transactionHash!==attempt!.transactionHash
          ||next.transactionHashStored&&!attempt!.transactionHash)return fail('JOURNAL_INVALID');
        update({rawResponseStored:true,transactionHashStored:attempt!.transactionHashStored||next.transactionHashStored,
          status:attempt!.transactionHash===null?'HTTP_CAPTURED':'UNEXPECTED_BROADCAST'});
      }catch{
        if(attempt!.transactionHash!==null)observeHash(attempt!.transactionHash);else unknown();
        return fail('JOURNAL_INVALID');
      }
    }
    return new Response(new Uint8Array(bytes).buffer,{status,headers:Object.fromEntries(pairs)});
  };
  let calls:{transaction:(id:string)=>Promise<unknown>;wallet:(id:string)=>Promise<unknown>;policy:(id:string)=>Promise<unknown>;
    send:ReturnType<ReturnType<PrivyClient['wallets']>['ethereum']>['sendTransaction']};
  try{
    const client=new PrivyClient({appId:config.appId,appSecret:config.appSecret,apiUrl:origin,fetch:transport,maxRetries:0,timeout:10000,
      logLevel:'off',logger:{debug(){},info(){},warn(){},error(){}},fetchOptions:{redirect:'error'}});
    const transactions=client.transactions(),wallets=client.wallets(),policies=client.policies(),ethereum=wallets.ethereum();
    calls=Object.freeze({transaction:transactions.get.bind(transactions),wallet:wallets.get.bind(wallets),policy:policies.get.bind(policies),send:ethereum.sendTransaction.bind(ethereum)});
  }catch{return fail('CONFIGURATION_INVALID');}
  const read=async(kind:'transaction'|'wallet'|'policy',id:string)=>{
    if(!ProviderIdSchema.safeParse(id).success||kind==='transaction'&&id!==ids.funding&&id!==ids.allocation
      ||kind==='wallet'&&id!==config.walletId||kind==='policy'&&id!==config.policyId)return fail('READ_SCOPE_INVALID');
    try{return freeze(structuredClone(await calls[kind](id)));}catch{return fail('READ_UNAVAILABLE');}
  };
  return Object.freeze({origins:Object.freeze({transaction:(id:string)=>read('transaction',id),wallet:(id:string)=>read('wallet',id),policy:(id:string)=>read('policy',id)}),snapshot,
    capture:async(callInput:Day4PolicyProbeCall)=>{
      if(!config.authorizationPrivateKey)return fail('CAPTURE_CONFIGURATION_INVALID');
      let call:Day4PolicyProbeCall;
      try{call=freeze(Day4PolicyProbeCallSchema.parse(structuredClone(callInput)));}catch{return fail('CALL_INVALID');}
      if(call.walletId!==config.walletId||call.policyId!==config.policyId||call.signerId!==config.signerId
        ||!sameAddress(call.executor,config.address)||!sameAddress(call.arbiter,config.arbiter)||containsSensitive(call))return fail('CALL_INVALID');
      if(captureStarted)return fail('ALREADY_ATTEMPTED');captureStarted=true;
      const key=day4PolicyProbeKey(call);
      try{
        const old=journal.get(key);
        if(old!==null){const existing=checkedRecord(old);if(existing.key!==key)return fail('JOURNAL_INVALID');attempt=existing;priorAttempt=true;return fail('ALREADY_ATTEMPTED');}
        const reserved=checkedRecord(journal.reserve(call));
        if(reserved.key!==key||reserved.status!=='RESERVED'||!isDeepStrictEqual(reserved.call,call))return fail('JOURNAL_INVALID');attempt=reserved;
      }catch(error){
        if(error instanceof Error&&error.message==='DAY4_POLICY_PROBE_ALREADY_ATTEMPTED')throw error;
        // A prior attempt was detected or unavailable history could not rule
        // one out. The local zero POST count cannot prove zero original sends.
        priorAttempt=true;
        // Another process can reserve after our initial null read. Recover the
        // original attempt read-only; never reserve or send again after a conflict.
        try{const old=journal.get(key);if(old!==null){const existing=checkedRecord(old);if(existing.key!==key)return fail('JOURNAL_INVALID');
          attempt=existing;priorAttempt=true;return fail('ALREADY_ATTEMPTED');}}
        catch(recoveryError){if(recoveryError instanceof Error&&recoveryError.message==='DAY4_POLICY_PROBE_ALREADY_ATTEMPTED')throw recoveryError;}
        return fail('JOURNAL_UNAVAILABLE');
      }
      const transaction=freeze({chain_id:'0x279f',from:call.executor,to:call.arbiter,value:'0x0',data:call.data,gas_limit:'0x4c4b40'});
      expectedBody=freeze({caip2:'eip155:10143',params:{transaction},method:'eth_sendTransaction',chain_type:'ethereum'});
      const request=freeze({caip2:'eip155:10143' as const,params:{transaction},authorization_context:{authorization_private_keys:[config.authorizationPrivateKey]},idempotency_key:attempt.attemptId});
      try{
        await calls.send(config.walletId,request);
        // SDK JSON.parse can accept duplicate members. A hash is retained only
        // from the independently strict successful transport envelope above.
        if(attempt.transactionHash===null)unknown();
      }catch{if(attempt.transactionHash===null&&(!attempt.rawResponseStored||attempt.httpStatus!==null&&attempt.httpStatus>=200&&attempt.httpStatus<300))unknown();}
      return snapshot() as {attempt:Day4PolicyProbeAttempt;walletRpcAttempts:0|1};
    }});
}
