import {DatabaseSync} from 'node:sqlite';
import {ApprovalRecordSchema,type ApprovalRecord} from '../../protocol/src/approval-api.js';
import {digest} from '../../protocol/src/schemas.js';
const identity=(owner:string)=>{if(!owner||owner.length>512)throw new Error('SUBJECT_INVALID');return owner;};
function canonical(input:unknown){const r=ApprovalRecordSchema.parse(input);return {...r,orderId:r.orderId.toLowerCase(),contextHash:r.contextHash.toLowerCase(),asset:r.asset.toLowerCase(),owner:r.owner.toLowerCase(),spender:r.spender.toLowerCase(),hash:r.hash?.toLowerCase()??null};}
/** Public chain metadata only. A reservation never expires or silently becomes retryable. */
export class ApprovalStore {
  private db:DatabaseSync;
  constructor(path:string){this.db=new DatabaseSync(path);this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS approval_attempts (subject TEXT NOT NULL,order_id TEXT NOT NULL,step TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(subject,order_id,step)) STRICT;`);}
  get(subject:string,id:string,step:'RESET'|'SET'):ApprovalRecord|undefined {
    const row=this.db.prepare('SELECT record_json FROM approval_attempts WHERE subject=? AND order_id=? AND step=?').get(identity(subject),digest.parse(id).toLowerCase(),step);
    return row?ApprovalRecordSchema.parse(JSON.parse(String(row.record_json))):undefined;
  }
  reserve(subject:string,input:unknown){
    const record=canonical(input);if(record.status!=='RESERVED'||record.hash!==null)throw new Error('APPROVAL_RECORD_CONFLICT');
    this.db.exec('BEGIN IMMEDIATE');
    try{const existing=this.get(subject,record.orderId,record.step);if(existing){
      const {status:_s,hash:_h,...a}=existing,{status:_s2,hash:_h2,...b}=record;
      if(JSON.stringify(a)!==JSON.stringify(b))throw new Error('APPROVAL_RECORD_CONFLICT');this.db.exec('COMMIT');return {created:false,record:existing};}
      const other=this.get(subject,record.orderId,record.step==='SET'?'RESET':'SET');if(other?.status==='RESERVED')throw new Error('APPROVAL_RECORD_CONFLICT');
      this.db.prepare('INSERT INTO approval_attempts VALUES (?,?,?,?)').run(identity(subject),record.orderId.toLowerCase(),record.step,JSON.stringify(record));this.db.exec('COMMIT');return {created:true,record};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  resolve(subject:string,input:unknown){
    const next=canonical(input);if(next.status==='RESERVED')throw new Error('APPROVAL_RECORD_CONFLICT');
    this.db.exec('BEGIN IMMEDIATE');try{
      const old=this.get(subject,next.orderId,next.step);if(!old)throw new Error('APPROVAL_ATTEMPT_REQUIRED');
      const {status:_a,hash:_b,...a}=old,{status:_c,hash:_d,...b}=next;
      if(JSON.stringify(a)!==JSON.stringify(b)||old.status!=='RESERVED'&&(old.status!==next.status||old.hash!==next.hash))throw new Error('APPROVAL_RECORD_CONFLICT');
      this.db.prepare('UPDATE approval_attempts SET record_json=? WHERE subject=? AND order_id=? AND step=?').run(JSON.stringify(next),identity(subject),next.orderId.toLowerCase(),next.step);this.db.exec('COMMIT');return next;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  close(){this.db.close();}
}
