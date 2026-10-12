import {DatabaseSync} from 'node:sqlite';
import {CapsuleFileSchema,type CapsuleFile} from '../../capsule/src/format.js';
import {digest,uint} from '../../protocol/src/schemas.js';

export class CapsuleConflict extends Error {constructor(){super('CAPSULE_REVISION_CONFLICT');}}
function subject(value:string){if(!value||value.length>512)throw new Error('SUBJECT_INVALID');return value;}
/** Authenticated subject is supplied by the server, never by uploaded JSON. */
export class CapsuleStore {
  private db:DatabaseSync;
  constructor(path:string) {
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS capsules (
        owner TEXT NOT NULL, object_id TEXT NOT NULL, revision TEXT NOT NULL,
        namespace TEXT NOT NULL, iv TEXT NOT NULL, file_json TEXT NOT NULL,
        PRIMARY KEY(owner,object_id,revision), UNIQUE(owner,namespace,iv)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS capsule_heads (
        owner TEXT NOT NULL, object_id TEXT NOT NULL, revision TEXT NOT NULL,
        PRIMARY KEY(owner,object_id)
      ) STRICT;`);
  }
  get(owner:string,objectId:string):CapsuleFile|undefined {
    const row=this.db.prepare(`SELECT c.file_json FROM capsules c JOIN capsule_heads h
      ON c.owner=h.owner AND c.object_id=h.object_id AND c.revision=h.revision
      WHERE c.owner=? AND c.object_id=?`).get(subject(owner),digest.parse(objectId).toLowerCase());
    return row?CapsuleFileSchema.parse(JSON.parse(String(row.file_json))):undefined;
  }
  put(owner:string,input:unknown,expectedRevision:string):CapsuleFile {
    subject(owner);uint.parse(expectedRevision);
    const file=CapsuleFileSchema.parse(input),id=file.capsule.objectId.toLowerCase(),rev=file.capsule.revision,json=JSON.stringify(file);
    if(BigInt(rev)!==BigInt(expectedRevision)+1n)throw new CapsuleConflict();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing=this.db.prepare('SELECT file_json FROM capsules WHERE owner=? AND object_id=? AND revision=?').get(owner,id,rev);
      if(existing){if(String(existing.file_json)!==json)throw new CapsuleConflict();this.db.exec('COMMIT');return file;}
      const current=this.get(owner,id);
      if((current?.capsule.revision??'0')!==expectedRevision)throw new CapsuleConflict();
      if(current&&(current.capsule.namespace[2]==='authorization'||JSON.stringify(current.capsule.namespace)!==JSON.stringify(file.capsule.namespace)||JSON.stringify(current.keyReference)!==JSON.stringify(file.keyReference)))throw new CapsuleConflict();
      const reused=this.db.prepare('SELECT 1 FROM capsules WHERE owner=? AND namespace=? AND iv=?').get(owner,JSON.stringify(file.capsule.namespace),file.capsule.iv);
      if(reused)throw new CapsuleConflict();
      this.db.prepare('INSERT INTO capsules VALUES (?,?,?,?,?,?)').run(owner,id,rev,JSON.stringify(file.capsule.namespace),file.capsule.iv,json);
      this.db.prepare('INSERT INTO capsule_heads VALUES (?,?,?) ON CONFLICT(owner,object_id) DO UPDATE SET revision=excluded.revision').run(owner,id,rev);
      this.db.exec('COMMIT');return file;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  close(){this.db.close();}
}
