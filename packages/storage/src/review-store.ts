import {DatabaseSync} from 'node:sqlite';
import {randomBytes} from 'node:crypto';
import {openSync,closeSync,constants,lstatSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {digest} from '../../protocol/src/schemas.js';
import {ReviewRecordSchema,reviewJournalKey,evaluatedRecord,completedRecord,type ReviewRecord,type ReviewResult,type ReviewJournal} from './review-journal.js';
/** One persistent private SQLite file shared by review workers. No task/documents/token stored. */
export class ReviewStore implements ReviewJournal {
  private readonly db:DatabaseSync;
  private readonly secret:Buffer;
  constructor(path:string){
    if(!isAbsolute(path)||!path.endsWith('.db'))throw new Error('REVIEW_JOURNAL_CONFIGURATION_INVALID');
    try{const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);closeSync(fd);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw new Error('REVIEW_JOURNAL_CONFIGURATION_INVALID');}
    const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||typeof process.getuid==='function'&&stat.uid!==process.getuid())throw new Error('REVIEW_JOURNAL_CONFIGURATION_INVALID');
    this.db=new DatabaseSync(path);
    try{
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS review_journal_secret(id INTEGER PRIMARY KEY CHECK(id=1),secret BLOB NOT NULL CHECK(length(secret)=32)) STRICT;
        CREATE TABLE IF NOT EXISTS review_requests(semantic_key TEXT PRIMARY KEY,record_json TEXT NOT NULL) STRICT;`);
      const candidate=randomBytes(32);try{this.db.prepare('INSERT OR IGNORE INTO review_journal_secret VALUES(1,?)').run(candidate);}finally{candidate.fill(0);}
      const secret=this.db.prepare('SELECT secret FROM review_journal_secret WHERE id=1').get()?.secret;if(!(secret instanceof Uint8Array)||secret.length!==32)throw new Error('REVIEW_JOURNAL_CONFIGURATION_INVALID');this.secret=Buffer.from(secret);
    }catch{this.db.close();throw new Error('REVIEW_JOURNAL_CONFIGURATION_INVALID');}
  }
  key(input:unknown){return reviewJournalKey(this.secret,input);}
  get(key:string){key=digest.parse(key).toLowerCase();const row=this.db.prepare('SELECT record_json FROM review_requests WHERE semantic_key=?').get(key);if(!row)return undefined;
    if(typeof row.record_json!=='string'||row.record_json.length>65536)throw new Error('REVIEW_RECORD_INVALID');const record=ReviewRecordSchema.parse(JSON.parse(row.record_json));if(record.key!==key)throw new Error('REVIEW_RECORD_INVALID');return record;
  }
  reserve(key:string,contextHash:string,startedAt:string){key=digest.parse(key).toLowerCase();const record=ReviewRecordSchema.parse({key,contextHash:contextHash.toLowerCase(),status:'PENDING',startedAt,evaluatedAt:null,finishedAt:null,evaluation:null,result:null});
    this.db.exec('BEGIN IMMEDIATE');try{if(this.get(key)){this.db.exec('COMMIT');return false;}this.db.prepare('INSERT INTO review_requests VALUES(?,?)').run(key,JSON.stringify(record));this.db.exec('COMMIT');return true;}catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  private update(key:string,change:(old:ReviewRecord)=>ReviewRecord){key=digest.parse(key).toLowerCase();this.db.exec('BEGIN IMMEDIATE');try{const old=this.get(key);if(!old)throw new Error('REVIEW_RECORD_CONFLICT');const next=change(old);this.db.prepare('UPDATE review_requests SET record_json=? WHERE semantic_key=?').run(JSON.stringify(next),key);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}}
  evaluated(key:string,evaluation:ReviewResult,at:string){this.update(key,old=>evaluatedRecord(old,evaluation,at));}
  finish(key:string,result:ReviewResult,at:string){this.update(key,old=>completedRecord(old,result,at));}
  close(){try{this.db.close();}finally{this.secret.fill(0);}}
}
