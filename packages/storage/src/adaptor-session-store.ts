import {DatabaseSync} from 'node:sqlite';
import {openSync,closeSync,lstatSync,constants} from 'node:fs';
import {isAbsolute} from 'node:path';
import {z} from 'zod';
import {AdaptorCandidateSchema,AdaptorCertificateSchema,PreSignatureSchema,adaptorCandidateHash} from '../../protocol/src/adaptor-review.js';
import {digest} from '../../protocol/src/schemas.js';
import {ReviewResultSchema} from '../../protocol/src/purchase-api.js';
export const AdaptorSessionSchema=z.object({candidate:AdaptorCandidateSchema,preSignature:PreSignatureSchema,
  state:z.enum(['PREPARED','RUNNING','STOPPED','COMPLETE']),review:ReviewResultSchema.optional(),certificate:AdaptorCertificateSchema.optional(),
}).strict().superRefine((s,ctx)=>{
  const invalid=()=>ctx.addIssue({code:'custom',message:'ADAPTOR_SESSION_STATE_INVALID'});
  if(['PREPARED','RUNNING'].includes(s.state)&&(s.review||s.certificate))invalid();
  if(s.state==='STOPPED'&&(!s.review||s.certificate||s.review.source==='JEV'&&(s.review.executable||s.review.decision==='PASS')))invalid();
  if(s.state==='COMPLETE'&&(!s.certificate||!s.review||s.review.source!=='JEV'||s.review.executable||s.review.decision!=='PASS'))invalid();
  if(s.certificate&&(adaptorCandidateHash(s.certificate.candidate)!==adaptorCandidateHash(s.candidate)||s.certificate.preSignature!==s.preSignature||JSON.stringify(s.certificate.evaluation)!==JSON.stringify(s.review)))invalid();
});
export type AdaptorSession=z.infer<typeof AdaptorSessionSchema>;
/** Experimental private journal. No signing key or unreleased witness is stored.
 * A lost pending witness blocks the original session; it is never regenerated.
 */
export class AdaptorSessionStore {
  private db:DatabaseSync;
  constructor(path:string){
    if(!isAbsolute(path)||!path.endsWith('.db'))throw Error('ADAPTOR_STORE_PATH_INVALID');
    try{closeSync(openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600));}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw Error('ADAPTOR_STORE_UNAVAILABLE');}
    const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||typeof process.getuid==='function'&&stat.uid!==process.getuid())throw Error('ADAPTOR_STORE_PERMISSIONS');
    this.db=new DatabaseSync(path);this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS adaptor_sessions(id TEXT PRIMARY KEY, context TEXT UNIQUE NOT NULL, state TEXT NOT NULL, value TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS adaptor_consumed(id TEXT PRIMARY KEY) STRICT;');
  }
  get(id:unknown):AdaptorSession|undefined{const key=digest.parse(id).toLowerCase(),r=this.db.prepare('SELECT value,state,context FROM adaptor_sessions WHERE id=?').get(key);if(!r)return;const session=AdaptorSessionSchema.parse(JSON.parse(String(r.value)));if(session.candidate.sessionId.toLowerCase()!==key||session.state!==r.state||session.candidate.contextHash.toLowerCase()!==r.context)throw Error('ADAPTOR_STORE_CONFLICT');return session;}
  reserve(input:AdaptorSession){const s=AdaptorSessionSchema.parse(input);if(s.state!=='PREPARED'||s.review||s.certificate)throw Error('ADAPTOR_STORE_CONFLICT');try{this.db.prepare('INSERT INTO adaptor_sessions VALUES(?,?,?,?)').run(s.candidate.sessionId.toLowerCase(),s.candidate.contextHash.toLowerCase(),s.state,JSON.stringify(s));}catch{throw Error('ADAPTOR_ORIGINAL_SESSION_ALREADY_EXISTS');}}
  claim(id:string){const s=this.get(id);if(!s||s.state!=='PREPARED')throw Error('ADAPTOR_ORIGINAL_SESSION_RECONCILIATION_REQUIRED');const next={...s,state:'RUNNING' as const};if(this.db.prepare("UPDATE adaptor_sessions SET state='RUNNING',value=? WHERE id=? AND state='PREPARED'").run(JSON.stringify(next),id.toLowerCase()).changes!==1)throw Error('ADAPTOR_ORIGINAL_SESSION_RECONCILIATION_REQUIRED');}
  finish(id:string,value:AdaptorSession){const next=AdaptorSessionSchema.parse(value),old=this.get(id);if(!old||old.state!=='RUNNING'||!['STOPPED','COMPLETE'].includes(next.state)||next.candidate.sessionId.toLowerCase()!==id.toLowerCase()||JSON.stringify(next.candidate)!==JSON.stringify(old.candidate)||next.preSignature!==old.preSignature||next.state==='COMPLETE'&&!next.certificate||next.state==='STOPPED'&&(!next.review||next.certificate))throw Error('ADAPTOR_STORE_CONFLICT');if(this.db.prepare("UPDATE adaptor_sessions SET state=?,value=? WHERE id=? AND state='RUNNING'").run(next.state,JSON.stringify(next),id.toLowerCase()).changes!==1)throw Error('ADAPTOR_STORE_CONFLICT');}
  /** Local acceptance only; this cannot consume an escrow grant nonce. */
  consume(id:string){if(this.get(id)?.state!=='COMPLETE')throw Error('ADAPTOR_CERTIFICATE_REQUIRED');try{this.db.prepare('INSERT INTO adaptor_consumed VALUES(?)').run(digest.parse(id).toLowerCase());}catch{throw Error('ADAPTOR_CERTIFICATE_ALREADY_CONSUMED');}}
  close(){this.db.close();}
}
