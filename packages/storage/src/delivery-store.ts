import {DatabaseSync} from 'node:sqlite';
import {DeliveryRecordSchema,type DeliveryRecord} from '../../protocol/src/delivery-api.js';
function subject(s:string){if(!s||s.length>512)throw new Error('SUBJECT_INVALID');return s;}
const canonical=(r:unknown)=>{const p=DeliveryRecordSchema.parse(r);return Object.fromEntries(Object.entries(p).map(([k,v])=>[k,typeof v==='string'&&v.startsWith('0x')?v.toLowerCase():v])) as DeliveryRecord;};
const key=(r:DeliveryRecord)=>[r.chainId,r.arbiter.toLowerCase(),r.orderId.toLowerCase()];
/** Global original-order slot. Never expires, unlocks or stores plaintext inputs. */
export class DeliveryStore {
  private db:DatabaseSync;
  constructor(path:string){this.db=new DatabaseSync(path);this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS delivery_attempts(chain_id TEXT NOT NULL,arbiter TEXT NOT NULL,order_id TEXT NOT NULL,subject TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(chain_id,arbiter,order_id)) STRICT;`);}
  get(owner:string,input:unknown){const r=canonical(input),row=this.db.prepare('SELECT subject,record_json FROM delivery_attempts WHERE chain_id=? AND arbiter=? AND order_id=?').get(...key(r));if(!row)return undefined;if(row.subject!==subject(owner))throw new Error('DELIVERY_RECORD_CONFLICT');const old=DeliveryRecordSchema.parse(JSON.parse(String(row.record_json)));const {status:_a,hash:_b,...a}=old,{status:_c,hash:_d,...b}=r;if(JSON.stringify(a)!==JSON.stringify(b))throw new Error('DELIVERY_RECORD_CONFLICT');return old;}
  reserve(owner:string,input:unknown){const r=canonical(input);subject(owner);if(r.status!=='RESERVED'||r.hash!==null)throw new Error('DELIVERY_RECORD_CONFLICT');this.db.exec('BEGIN IMMEDIATE');try{const old=this.get(owner,r);if(old){this.db.exec('COMMIT');return {created:false,record:old};}this.db.prepare('INSERT INTO delivery_attempts VALUES(?,?,?,?,?)').run(...key(r),owner,JSON.stringify(r));this.db.exec('COMMIT');return {created:true,record:r};}catch(e){this.db.exec('ROLLBACK');throw e;}}
  resolve(owner:string,input:unknown){const r=canonical(input);if(r.status==='RESERVED')throw new Error('DELIVERY_RECORD_CONFLICT');this.db.exec('BEGIN IMMEDIATE');try{const old=this.get(owner,r);if(!old)throw new Error('DELIVERY_ATTEMPT_REQUIRED');if(old.status!=='RESERVED'&&(old.status!==r.status||old.hash!==r.hash))throw new Error('DELIVERY_RECORD_CONFLICT');this.db.prepare('UPDATE delivery_attempts SET record_json=? WHERE chain_id=? AND arbiter=? AND order_id=?').run(JSON.stringify(r),...key(r));this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  close(){this.db.close();}
}
