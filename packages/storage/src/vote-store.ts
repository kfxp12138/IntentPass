import {DatabaseSync} from 'node:sqlite';
import {VoteRecordSchema,type VoteRecord} from '../../protocol/src/vote-api.js';
function subject(s:string){if(!s||s.length>512)throw new Error('SUBJECT_INVALID');return s;}
function canonical(input:unknown){const r=VoteRecordSchema.parse(input);return Object.fromEntries(Object.entries(r).map(([k,v])=>[k,Array.isArray(v)?v.map(a=>a.toLowerCase()):typeof v==='string'&&v.startsWith('0x')?v.toLowerCase():v])) as VoteRecord;}
const key=(r:VoteRecord)=>[r.chainId,r.arbiter.toLowerCase(),r.orderId.toLowerCase(),r.memberIndex];
/** One original member send slot; immutable signature/data digest, no expiry release. */
export class VoteStore {
  private db:DatabaseSync;
  constructor(path:string){this.db=new DatabaseSync(path);this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS vote_attempts(chain_id TEXT NOT NULL,arbiter TEXT NOT NULL,order_id TEXT NOT NULL,member_index INTEGER NOT NULL,subject TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(chain_id,arbiter,order_id,member_index)) STRICT;`);}
  get(owner:string,input:unknown){subject(owner);const r=canonical(input),row=this.db.prepare('SELECT subject,record_json FROM vote_attempts WHERE chain_id=? AND arbiter=? AND order_id=? AND member_index=?').get(...key(r));if(!row)return undefined;if(row.subject!==owner)throw new Error('VOTE_RECORD_CONFLICT');const old=VoteRecordSchema.parse(JSON.parse(String(row.record_json)));const {status:_a,hash:_b,...a}=old,{status:_c,hash:_d,...b}=r;if(JSON.stringify(a)!==JSON.stringify(b))throw new Error('VOTE_RECORD_CONFLICT');return old;}
  reserve(owner:string,input:unknown){const r=canonical(input);if(r.status!=='RESERVED'||r.hash!==null)throw new Error('VOTE_RECORD_CONFLICT');this.db.exec('BEGIN IMMEDIATE');try{const old=this.get(owner,r);if(old){this.db.exec('COMMIT');return {created:false,record:old};}this.db.prepare('INSERT INTO vote_attempts VALUES(?,?,?,?,?,?)').run(...key(r),subject(owner),JSON.stringify(r));this.db.exec('COMMIT');return {created:true,record:r};}catch(e){this.db.exec('ROLLBACK');throw e;}}
  resolve(owner:string,input:unknown){const r=canonical(input);if(r.status==='RESERVED')throw new Error('VOTE_RECORD_CONFLICT');this.db.exec('BEGIN IMMEDIATE');try{const old=this.get(owner,r);if(!old)throw new Error('VOTE_ATTEMPT_REQUIRED');if(old.status!=='RESERVED'&&(old.status!==r.status||old.hash!==r.hash))throw new Error('VOTE_RECORD_CONFLICT');this.db.prepare('UPDATE vote_attempts SET record_json=? WHERE chain_id=? AND arbiter=? AND order_id=? AND member_index=?').run(JSON.stringify(r),...key(r));this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  close(){this.db.close();}
}
