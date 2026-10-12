import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {constants,openSync,closeSync,lstatSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {digest} from '../../protocol/src/schemas.js';
import {Day4PolicyProbeAttemptSchema,Day4PolicyProbeCallSchema,day4PolicyProbeKey,
  type Day4PolicyProbeAttempt,type Day4PolicyProbeCall,type Day4PolicyProbeJournal} from '../../protocol/src/day4-policy-probe-types.js';

const applicationId=0x49505042,version=1,bodyLimit=65536,headerLimit=8192;
const tables=['policy_probe_attempts','policy_probe_hashes','policy_probe_responses'];
const repository=realpathSync(fileURLToPath(new URL('../../../',import.meta.url)));
const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const timestamp=(previous?:string)=>new Date(Math.max(Date.now(),previous?Date.parse(previous):0)).toISOString();
function enableWal(db:DatabaseSync){
  const deadline=performance.now()+5000,wait=new Int32Array(new SharedArrayBuffer(4));
  db.exec('PRAGMA busy_timeout=0;');
  try{
    for(;;){
      try{db.exec('PRAGMA journal_mode=WAL;');return;}
      catch(error){
        // Concurrent journal-mode conversion can fail immediately despite SQLite's
        // busy timeout. Retry only the observed local SQLITE_BUSY, never metadata,
        // permission, corruption or reservation errors.
        const sqlite=error as Error&{code?:string;errcode?:number},remaining=deadline-performance.now();
        if(!(error instanceof Error)||sqlite.code!=='ERR_SQLITE_ERROR'||sqlite.errcode!==5||remaining<=0)throw error;
        Atomics.wait(wait,0,0,Math.min(10,remaining));if(performance.now()>=deadline)throw error;
      }
    }
  }finally{db.exec('PRAGMA busy_timeout=5000;');}
}
function parse<T>(schema:z.ZodType<T>,input:unknown):T{try{return schema.parse(input);}catch{throw new Error('POLICY_PROBE_METADATA_INVALID');}}
function canonicalKey(input:string){return parse(digest,input).toLowerCase();}
function attemptId(input:string){return parse(z.uuid(),input).toLowerCase();}
function plain(input:unknown){return input!==null&&typeof input==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(input))&&Reflect.ownKeys(input).every(key=>typeof key==='string');}
function callInput(input:Day4PolicyProbeCall){
  if(!plain(input)||!plain(input.block))throw new Error('POLICY_PROBE_METADATA_INVALID');
  return parse(Day4PolicyProbeCallSchema,input);
}
function parents(path:string){
  if(typeof path!=='string'||path.length>4096||!isAbsolute(path)||resolve(path)!==path||!path.endsWith('.db')||path===repository||path.startsWith(repository+sep))throw new Error();
  for(let current=dirname(path);;current=dirname(current)){
    const stat=lstatSync(current);if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(current)!==current)throw new Error();
    try{lstatSync(resolve(current,'.git'));throw new Error('REPOSITORY_PATH');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(dirname(current)===current)break;
  }
}
function privateFile(path:string){
  const stat=lstatSync(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(stat.mode&0o777)!==0o600||realpathSync(path)!==path||typeof process.getuid==='function'&&stat.uid!==process.getuid())throw new Error();
  return stat;
}
function sidecars(path:string){for(const suffix of ['-wal','-shm'])try{privateFile(path+suffix);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
function responseInput(status:number,body:Uint8Array,headers:readonly (readonly [string,string])[]){
  if(!Number.isInteger(status)||status<100||status>599||!(body instanceof Uint8Array)||body.byteLength>bodyLimit||!Array.isArray(headers)||headers.length>128)throw new Error('POLICY_PROBE_RESPONSE_INVALID');
  const copiedHeaders=headers.map(pair=>{
    if(!Array.isArray(pair)||pair.length!==2||typeof pair[0]!=='string'||typeof pair[1]!=='string'||!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(pair[0])||/[\r\n\0]/.test(pair[1]))throw new Error('POLICY_PROBE_RESPONSE_INVALID');
    return [pair[0],pair[1]];
  });
  const encoded=JSON.stringify(copiedHeaders);if(Buffer.byteLength(encoded)>headerLimit)throw new Error('POLICY_PROBE_RESPONSE_INVALID');
  const bytes=Buffer.from(body);return {status,body:bytes,headers:encoded,bodySha256:sha(bytes),headersSha256:sha(encoded)};
}
type ResponseRecord=ReturnType<typeof responseInput>;

/** A separate private capture journal. Reservations never expire or release a
 * wallet/order slot; raw responses are never included in the public get result. */
export class PolicyProbeAttemptStore implements Day4PolicyProbeJournal{
  private readonly db:DatabaseSync;
  private readonly identity:{ino:number;dev:number};
  private closed=false;
  constructor(private readonly path:string){
    let db:DatabaseSync|undefined;
    try{
      parents(path);
      try{const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);closeSync(fd);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
      const before=privateFile(path);sidecars(path);
      db=new DatabaseSync(path);db.exec('PRAGMA busy_timeout=5000; BEGIN;');
      // Another fresh constructor may commit between metadata queries. Inspect
      // one snapshot before changing journal mode or accepting an existing DB.
      try{this.inspectDatabase(db,true);db.exec('COMMIT');}
      catch(error){try{db.exec('ROLLBACK');}catch{/* Preserve the original fail-closed error. */}throw error;}
      enableWal(db);db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
      try{
        this.inspectDatabase(db,true);
        db.exec(`CREATE TABLE IF NOT EXISTS policy_probe_attempts(
          key TEXT PRIMARY KEY,attempt_id TEXT NOT NULL UNIQUE,wallet_id TEXT NOT NULL,chain_id TEXT NOT NULL,
          arbiter TEXT NOT NULL,order_id TEXT NOT NULL,call_json TEXT NOT NULL,created_at TEXT NOT NULL,record_json TEXT NOT NULL,
          UNIQUE(wallet_id,chain_id,arbiter,order_id)) STRICT;
          CREATE TABLE IF NOT EXISTS policy_probe_responses(key TEXT PRIMARY KEY,attempt_id TEXT NOT NULL UNIQUE,http_status INTEGER NOT NULL,
            body BLOB NOT NULL CHECK(length(body)<=65536),headers TEXT NOT NULL CHECK(length(CAST(headers AS BLOB))<=8192),
            body_sha256 TEXT NOT NULL,headers_sha256 TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS policy_probe_hashes(key TEXT PRIMARY KEY,attempt_id TEXT NOT NULL UNIQUE,transaction_hash TEXT NOT NULL) STRICT;
          PRAGMA application_id=${applicationId}; PRAGMA user_version=${version}; COMMIT;`);
      }catch(error){db.exec('ROLLBACK');throw error;}
      const after=privateFile(path);sidecars(path);if(before.ino!==after.ino||before.dev!==after.dev)throw new Error();
      this.identity={ino:after.ino,dev:after.dev};this.db=db;
    }catch{db?.close();throw new Error('POLICY_PROBE_CONFIGURATION_INVALID');}
  }
  private inspectDatabase(db:DatabaseSync,allowEmpty=false){
    const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
    const id=db.prepare('PRAGMA application_id').get()?.application_id,v=db.prepare('PRAGMA user_version').get()?.user_version;
    if(allowEmpty&&names.length===0&&id===0&&v===0)return;
    if(id!==applicationId||v!==version||JSON.stringify(names)!==JSON.stringify(tables))throw new Error('POLICY_PROBE_RECORD_INVALID');
  }
  private active(){
    if(this.closed)throw new Error('POLICY_PROBE_JOURNAL_CLOSED');
    try{parents(this.path);const file=privateFile(this.path);sidecars(this.path);if(file.ino!==this.identity.ino||file.dev!==this.identity.dev)throw new Error();}
    catch{throw new Error('POLICY_PROBE_CONFIGURATION_INVALID');}
    try{this.inspectDatabase(this.db);}catch{throw new Error('POLICY_PROBE_RECORD_INVALID');}
  }
  private response(key:string,attempt:string):ResponseRecord|null{
    const row=this.db.prepare('SELECT attempt_id,http_status,length(body) AS body_bytes,length(CAST(headers AS BLOB)) AS header_bytes FROM policy_probe_responses WHERE key=?').get(key);
    if(!row)return null;
    if(row.attempt_id!==attempt||typeof row.body_bytes!=='number'||row.body_bytes>bodyLimit||typeof row.header_bytes!=='number'||row.header_bytes>headerLimit)throw new Error('POLICY_PROBE_RECORD_INVALID');
    try{
      const raw=this.db.prepare('SELECT body,headers,body_sha256,headers_sha256 FROM policy_probe_responses WHERE key=?').get(key)!;
      if(!(raw.body instanceof Uint8Array)||typeof raw.headers!=='string')throw new Error();
      const value=responseInput(Number(row.http_status),raw.body,JSON.parse(raw.headers));
      if(value.bodySha256!==raw.body_sha256||value.headersSha256!==raw.headers_sha256||value.headers!==raw.headers)throw new Error();return value;
    }catch{throw new Error('POLICY_PROBE_RECORD_INVALID');}
  }
  get(input:string):Day4PolicyProbeAttempt|null{
    const key=canonicalKey(input);this.active();
    try{
      const row=this.db.prepare('SELECT * FROM policy_probe_attempts WHERE key=?').get(key);
      if(!row){
        if(this.db.prepare('SELECT 1 FROM policy_probe_responses WHERE key=? UNION ALL SELECT 1 FROM policy_probe_hashes WHERE key=? LIMIT 1').get(key,key))throw new Error();
        return null;
      }
      if(typeof row.record_json!=='string'||Buffer.byteLength(row.record_json)>8192||typeof row.call_json!=='string'||Buffer.byteLength(row.call_json)>8192)throw new Error();
      const record=Day4PolicyProbeAttemptSchema.parse(JSON.parse(row.record_json));
      if(record.key!==key||record.attemptId!==row.attempt_id||record.call.walletId!==row.wallet_id||record.call.chainId!==row.chain_id||record.call.arbiter.toLowerCase()!==row.arbiter||record.call.orderId.toLowerCase()!==row.order_id||JSON.stringify(record.call)!==row.call_json||record.createdAt!==row.created_at)throw new Error();
      const response=this.response(key,record.attemptId),hash=this.db.prepare('SELECT attempt_id,transaction_hash FROM policy_probe_hashes WHERE key=?').get(key);
      if(record.rawResponseStored!==!!response||record.httpStatus!==(response?.status??null)||record.transactionHashStored!==!!hash
        ||record.transactionHash!==(hash?.transaction_hash??null)||hash&&(hash.attempt_id!==record.attemptId||record.status!=='UNEXPECTED_BROADCAST'))throw new Error();
      return record;
    }catch{throw new Error('POLICY_PROBE_RECORD_INVALID');}
  }
  reserve(input:Day4PolicyProbeCall):Day4PolicyProbeAttempt{
    const call=callInput(input),key=day4PolicyProbeKey(call).toLowerCase();
    return this.transaction(()=>{
      if(this.get(key))throw new Error('POLICY_PROBE_ATTEMPT_EXISTS');
      if(this.db.prepare('SELECT 1 FROM policy_probe_attempts WHERE wallet_id=? AND chain_id=? AND arbiter=? AND order_id=?').get(call.walletId,call.chainId,call.arbiter.toLowerCase(),call.orderId.toLowerCase()))throw new Error('POLICY_PROBE_ATTEMPT_EXISTS');
      const at=timestamp(),record=Day4PolicyProbeAttemptSchema.parse({key,attemptId:randomUUID(),call,createdAt:at,updatedAt:at,status:'RESERVED',httpStatus:null,rawResponseStored:false,transactionHash:null,transactionHashStored:false});
      this.db.prepare('INSERT INTO policy_probe_attempts VALUES(?,?,?,?,?,?,?,?,?)').run(key,record.attemptId,call.walletId,call.chainId,call.arbiter.toLowerCase(),call.orderId.toLowerCase(),JSON.stringify(call),at,JSON.stringify(record));return record;
    });
  }
  recordResponse(input:string,id:string,status:number,body:Uint8Array,headers:readonly (readonly [string,string])[]):Day4PolicyProbeAttempt{
    const response=responseInput(status,body,headers);
    return this.update(input,id,old=>{
      const original=this.response(old.key,old.attemptId);
      if(original){if(original.status!==response.status||!original.body.equals(response.body)||original.headers!==response.headers)throw new Error('POLICY_PROBE_RESPONSE_CONFLICT');return old;}
      this.db.prepare('INSERT INTO policy_probe_responses VALUES(?,?,?,?,?,?,?)').run(old.key,old.attemptId,response.status,response.body,response.headers,response.bodySha256,response.headersSha256);
      return {...old,status:old.status==='UNEXPECTED_BROADCAST'?'UNEXPECTED_BROADCAST':'HTTP_CAPTURED',httpStatus:response.status,rawResponseStored:true,updatedAt:timestamp(old.updatedAt)};
    });
  }
  markUnknown(input:string,id:string):Day4PolicyProbeAttempt{
    return this.update(input,id,old=>old.status==='UNEXPECTED_BROADCAST'||old.status==='OUTCOME_UNKNOWN'?old:{...old,status:'OUTCOME_UNKNOWN',updatedAt:timestamp(old.updatedAt)});
  }
  recordUnexpectedHash(input:string,id:string,inputHash:string):Day4PolicyProbeAttempt{
    const hash=canonicalKey(inputHash);
    return this.update(input,id,old=>{
      if(old.transactionHash!==null){if(old.transactionHash!==hash)throw new Error('POLICY_PROBE_HASH_CONFLICT');return old;}
      this.db.prepare('INSERT INTO policy_probe_hashes VALUES(?,?,?)').run(old.key,old.attemptId,hash);
      return {...old,status:'UNEXPECTED_BROADCAST',transactionHash:hash,transactionHashStored:true,updatedAt:timestamp(old.updatedAt)};
    });
  }
  private transaction<T>(action:()=>T):T{
    this.active();let began=false;
    try{this.db.exec('BEGIN IMMEDIATE');began=true;const value=action();this.db.exec('COMMIT');return value;}
    catch(error){if(began)try{this.db.exec('ROLLBACK');}catch{/* A failed write cannot create a new reservation opportunity. */}
      if(error instanceof Error&&/^POLICY_PROBE_[A-Z_]+$/.test(error.message))throw error;
      throw new Error('POLICY_PROBE_JOURNAL_WRITE_FAILED');}
  }
  private update(input:string,id:string,change:(old:Day4PolicyProbeAttempt)=>Day4PolicyProbeAttempt){
    const key=canonicalKey(input),attempt=attemptId(id);
    return this.transaction(()=>{const old=this.get(key);if(!old)throw new Error('POLICY_PROBE_ATTEMPT_REQUIRED');if(old.attemptId!==attempt)throw new Error('POLICY_PROBE_ATTEMPT_CONFLICT');
      const next=Day4PolicyProbeAttemptSchema.parse(change(old));this.db.prepare('UPDATE policy_probe_attempts SET record_json=? WHERE key=? AND attempt_id=?').run(JSON.stringify(next),key,attempt);return next;
    });
  }
  close(){if(!this.closed){this.db.close();this.closed=true;}}
}
