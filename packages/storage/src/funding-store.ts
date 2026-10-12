import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {digest} from '../../protocol/src/schemas.js';
import {FundingAnchorSchema,type FundingAnchor} from '../../protocol/src/funding.js';
import {checkProviderSubmission,type ProviderSubmission} from '../../protocol/src/provider-submission.js';
export {FundingAnchorSchema,type FundingAnchor} from '../../protocol/src/funding.js';
export type FundingStatus='IDLE'|'IN_FLIGHT'|'SUBMITTED'|'UNKNOWN'|'CONFIRMED'|'RECONCILED'|'REVERTED'|'BLOCKED';
export interface FundingRecord {key:string;anchor:FundingAnchor;status:FundingStatus;attempt:string|null;hash:string|null;leaseUntil:number|null;providerSubmission?:ProviderSubmission;}
export interface FundingSubmission {attempt:string;hash:string;providerSubmission?:ProviderSubmission;}
/** Public immutable anchors only. UNKNOWN is never eligible for another send. */
export class FundingStore {
  private db:DatabaseSync;
  constructor(path:string){this.db=new DatabaseSync(path);this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS funding_attempts (key TEXT PRIMARY KEY,anchor_json TEXT NOT NULL,status TEXT NOT NULL,attempt TEXT,hash TEXT,lease_until INTEGER,
    CHECK(status IN ('IDLE','IN_FLIGHT','SUBMITTED','UNKNOWN','CONFIRMED','RECONCILED','REVERTED','BLOCKED'))) STRICT;`);
    this.transaction(()=>{
      this.db.exec(`CREATE TABLE IF NOT EXISTS funding_send_reservations(attempt TEXT PRIMARY KEY,key TEXT NOT NULL,anchor_json TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS funding_broadcast_history(attempt TEXT PRIMARY KEY,hash TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS funding_provider_history(attempt TEXT PRIMARY KEY,transaction_id TEXT NOT NULL UNIQUE,provider_json TEXT NOT NULL) STRICT;`);
      for(const row of this.db.prepare('SELECT key,anchor_json,attempt,hash FROM funding_attempts WHERE attempt IS NOT NULL').all()){
        this.reserveHistory(String(row.key),String(row.attempt),FundingAnchorSchema.parse(JSON.parse(String(row.anchor_json))));
        if(row.hash!==null)this.bindHash(String(row.attempt),digest.parse(row.hash).toLowerCase());
      }
    });}
  register(input:unknown){const a=FundingAnchorSchema.parse(input),anchor=Object.fromEntries(Object.entries(a).map(([k,v])=>[k,['chainId','nonce','amount'].includes(k)?v:v.toLowerCase()])) as FundingAnchor;
    const key=`${anchor.chainId}:${anchor.arbiter}:${anchor.orderId}`;this.db.prepare("INSERT INTO funding_attempts(key,anchor_json,status) VALUES (?,?,'IDLE') ON CONFLICT(key) DO NOTHING").run(key,JSON.stringify(anchor));
    const record=this.get(key)!;if(JSON.stringify(record.anchor)!==JSON.stringify(anchor))throw new Error('FUNDING_ANCHOR_CONFLICT');return record;}
  get(key:string):FundingRecord|undefined {const row=this.db.prepare('SELECT * FROM funding_attempts WHERE key=?').get(key);if(!row)return undefined;
    const record:FundingRecord={key:String(row.key),anchor:FundingAnchorSchema.parse(JSON.parse(String(row.anchor_json))),status:row.status as FundingStatus,attempt:row.attempt===null?null:String(row.attempt),hash:row.hash===null?null:String(row.hash),leaseUntil:row.lease_until===null?null:Number(row.lease_until)};
    if(record.attempt&&record.hash){const submission=this.submission(record.key,record.attempt);if(submission){if(submission.hash!==record.hash.toLowerCase())throw Error('PROVIDER_SUBMISSION_CONFLICT');if(submission.providerSubmission)record.providerSubmission=submission.providerSubmission;}}
    return record;}
  acquire(key:string,now:number){if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(now+30000))throw new Error('LEASE_INVALID');return this.transaction(()=>{const attempt=randomUUID();
    if(this.db.prepare("UPDATE funding_attempts SET status='IN_FLIGHT',attempt=?,lease_until=? WHERE key=? AND status='IDLE'").run(attempt,now+30000,key).changes!==1)return undefined;
    this.reserveHistory(key,attempt,this.get(key)!.anchor);return attempt;});}
  expire(key:string,now:number){this.db.prepare("UPDATE funding_attempts SET status='UNKNOWN',lease_until=NULL WHERE key=? AND status='IN_FLIGHT' AND lease_until<=?").run(key,now);}
  broadcast(key:string,attempt:string,hash:string,providerSubmission?:ProviderSubmission){const canonicalHash=digest.parse(hash).toLowerCase();this.transaction(()=>{
    const reserved=this.reservation(key,attempt),record=this.get(key);if(!record||JSON.stringify(record.anchor)!==JSON.stringify(reserved))throw Error('STALE_ATTEMPT');
    const metadata=providerSubmission===undefined?undefined:this.metadata(providerSubmission,reserved);
    if(record.attempt===attempt){
      if(record.hash&&record.hash.toLowerCase()!==canonicalHash)throw Error('PROVIDER_SUBMISSION_CONFLICT');
      if(['IN_FLIGHT','UNKNOWN'].includes(record.status))this.db.prepare("UPDATE funding_attempts SET status='SUBMITTED',hash=?,lease_until=NULL WHERE key=? AND attempt=?").run(canonicalHash,key,attempt);
      else if(!['SUBMITTED','CONFIRMED','REVERTED','RECONCILED'].includes(record.status))throw Error('STALE_ATTEMPT');
    }
    this.bindHash(attempt,canonicalHash);if(metadata)this.bindProvider(attempt,metadata);
  });}
  stop(key:string,attempt:string,status:'BLOCKED'|'UNKNOWN'){if(this.db.prepare("UPDATE funding_attempts SET status=?,lease_until=NULL WHERE key=? AND attempt=? AND status='IN_FLIGHT'").run(status,key,attempt).changes!==1)throw new Error('STALE_ATTEMPT');}
  finish(key:string,hash:string,status:'CONFIRMED'|'REVERTED'){const canonicalHash=digest.parse(hash).toLowerCase();this.transaction(()=>{
    if(this.db.prepare("UPDATE funding_attempts SET status=?,hash=?,lease_until=NULL WHERE key=? AND status IN ('IDLE','BLOCKED','SUBMITTED','UNKNOWN','RECONCILED') AND (hash IS NULL OR hash=?)").run(status,canonicalHash,key,canonicalHash).changes!==1){const r=this.get(key);if(r?.status!==status||r.hash!==canonicalHash)throw new Error('STALE_ATTEMPT');}
    const record=this.get(key)!;if(record.attempt){this.reservation(key,record.attempt);this.bindHash(record.attempt,canonicalHash);}
  });}
  reconcileOrder(key:string){this.db.prepare("UPDATE funding_attempts SET status='RECONCILED',lease_until=NULL WHERE key=? AND status IN ('IDLE','UNKNOWN','BLOCKED','REVERTED')").run(key);}
  /** Immutable original hash/SDK associations, including late acknowledgements. */
  listSubmissions(key:string):FundingSubmission[]{return this.db.prepare('SELECT r.attempt FROM funding_send_reservations r JOIN funding_broadcast_history h ON h.attempt=r.attempt WHERE r.key=? ORDER BY h.rowid').all(key).map(row=>this.submission(key,String(row.attempt))!);}
  private transaction<T>(operation:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const result=operation();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  private reserveHistory(key:string,attempt:string,anchor:FundingAnchor){const json=JSON.stringify(anchor),old=this.db.prepare('SELECT key,anchor_json FROM funding_send_reservations WHERE attempt=?').get(attempt);
    if(old){if(old.key!==key||old.anchor_json!==json)throw Error('PROVIDER_SUBMISSION_CONFLICT');return;}
    this.db.prepare('INSERT INTO funding_send_reservations VALUES(?,?,?)').run(attempt,key,json);}
  private reservation(key:string,attempt:string):FundingAnchor{const row=this.db.prepare('SELECT key,anchor_json FROM funding_send_reservations WHERE attempt=?').get(attempt);if(!row||row.key!==key)throw Error('STALE_ATTEMPT');return FundingAnchorSchema.parse(JSON.parse(String(row.anchor_json)));}
  private metadata(input:unknown,anchor:FundingAnchor){const value=checkProviderSubmission(input,{chainId:anchor.chainId,to:anchor.arbiter,from:anchor.executor,calldataHash:anchor.calldataHash});return {...value,from:value.from.toLowerCase(),to:value.to.toLowerCase(),calldataHash:value.calldataHash.toLowerCase()};}
  private bindHash(attempt:string,hash:string){const old=this.db.prepare('SELECT hash FROM funding_broadcast_history WHERE attempt=?').get(attempt);if(old){if(old.hash!==hash)throw Error('PROVIDER_SUBMISSION_CONFLICT');return;}this.db.prepare('INSERT INTO funding_broadcast_history VALUES(?,?)').run(attempt,hash);}
  private bindProvider(attempt:string,metadata:ProviderSubmission){const json=JSON.stringify(metadata),old=this.db.prepare('SELECT provider_json FROM funding_provider_history WHERE attempt=?').get(attempt);
    if(old){if(old.provider_json!==json)throw Error('PROVIDER_SUBMISSION_CONFLICT');return;}
    const duplicate=this.db.prepare('SELECT 1 FROM funding_provider_history WHERE transaction_id=?').get(metadata.transactionId);if(duplicate)throw Error('PROVIDER_SUBMISSION_CONFLICT');
    this.db.prepare('INSERT INTO funding_provider_history VALUES(?,?,?)').run(attempt,metadata.transactionId,json);}
  private submission(key:string,attempt:string):FundingSubmission|undefined{const anchor=this.reservation(key,attempt),row=this.db.prepare('SELECT hash FROM funding_broadcast_history WHERE attempt=?').get(attempt);if(!row)return undefined;
    const hash=digest.parse(row.hash).toLowerCase(),provider=this.db.prepare('SELECT transaction_id,provider_json FROM funding_provider_history WHERE attempt=?').get(attempt);
    if(!provider)return {attempt,hash};const metadata=this.metadata(JSON.parse(String(provider.provider_json)),anchor);if(metadata.transactionId!==provider.transaction_id)throw Error('PROVIDER_SUBMISSION_CONFLICT');return {attempt,hash,providerSubmission:metadata};}
  close(){this.db.close();}
}
