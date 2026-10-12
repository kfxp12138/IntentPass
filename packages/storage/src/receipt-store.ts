import {DatabaseSync} from 'node:sqlite';
import {UnsignedReceiptSchema,receiptHash} from '../../protocol/src/typed-data.js';
import {digest,address,positiveUint,DecisionReceiptSchema} from '../../protocol/src/schemas.js';
import {keccak256,type Hex} from 'viem';
import {isDeepStrictEqual} from 'node:util';
export class ReceiptStore {
  private db:DatabaseSync;
  constructor(path:string){this.db=new DatabaseSync(path);this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS receipt_attempts(chain_id TEXT NOT NULL,arbiter TEXT NOT NULL,context_hash TEXT NOT NULL,receipt_hash TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('RESERVED','SIGNED','UNKNOWN')),signature_hash TEXT,PRIMARY KEY(chain_id,arbiter,context_hash)) STRICT;
    CREATE TABLE IF NOT EXISTS receipt_renewals(chain_id TEXT NOT NULL,arbiter TEXT NOT NULL,context_hash TEXT NOT NULL,parent_hash TEXT NOT NULL,receipt_hash TEXT NOT NULL,receipt_json TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('RESERVED','SIGNED','UNKNOWN')),signature TEXT,PRIMARY KEY(chain_id,arbiter,context_hash,parent_hash),UNIQUE(chain_id,arbiter,receipt_hash)) STRICT;`);}
  get(domain:{chainId:string;arbiter:string},context:string){const key=[positiveUint.parse(domain.chainId),address.parse(domain.arbiter).toLowerCase(),digest.parse(context).toLowerCase()];const row=this.db.prepare('SELECT receipt_hash,status,signature_hash FROM receipt_attempts WHERE chain_id=? AND arbiter=? AND context_hash=?').get(...key);if(!row)return undefined;
    const receiptHash=digest.parse(row.receipt_hash),status=String(row.status),signatureHash=row.signature_hash===null?null:digest.parse(row.signature_hash);if(!['RESERVED','SIGNED','UNKNOWN'].includes(status)||(status==='SIGNED')!==(signatureHash!==null))throw new Error('RECEIPT_RECORD_INVALID');return {receiptHash,status,signatureHash};}
  reserve(input:unknown,domain:{chainId:string;arbiter:string}){const r=UnsignedReceiptSchema.parse(input),hash=receiptHash(r,domain),key=[positiveUint.parse(domain.chainId),address.parse(domain.arbiter).toLowerCase(),r.contextHash.toLowerCase()];this.db.exec('BEGIN IMMEDIATE');try{const old=this.get(domain,r.contextHash);if(old){if(old.receiptHash.toLowerCase()!==hash.toLowerCase())throw new Error('RECEIPT_RECORD_CONFLICT');this.db.exec('COMMIT');return false;}this.db.prepare('INSERT INTO receipt_attempts VALUES(?,?,?,?,?,NULL)').run(...key,hash,'RESERVED');this.db.exec('COMMIT');return true;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  finish(input:unknown,domain:{chainId:string;arbiter:string},signatureHash:string|null){const r=UnsignedReceiptSchema.parse(input),old=this.get(domain,r.contextHash),hash=receiptHash(r,domain);if(!old||old.status!=='RESERVED'||old.receiptHash.toLowerCase()!==hash.toLowerCase())throw new Error('RECEIPT_RECORD_CONFLICT');const signature=signatureHash===null?null:digest.parse(signatureHash);const result=this.db.prepare("UPDATE receipt_attempts SET status=?,signature_hash=? WHERE chain_id=? AND arbiter=? AND context_hash=? AND receipt_hash=? AND status='RESERVED'").run(signature?'SIGNED':'UNKNOWN',signature,domain.chainId,domain.arbiter.toLowerCase(),r.contextHash.toLowerCase(),hash);if(result.changes!==1)throw new Error('RECEIPT_RECORD_CONFLICT');}
  /** Separate append-only successors. The original global slot is never updated. */
  latestRenewal(domain:{chainId:string;arbiter:string},root:ReturnType<typeof DecisionReceiptSchema.parse>){
    const {signature,...unsigned}=DecisionReceiptSchema.parse(root),rootHash=receiptHash(unsigned,domain),original=this.get(domain,root.contextHash);
    if(!original||original.status!=='SIGNED'||original.receiptHash!==rootHash||original.signatureHash!==keccak256(signature as Hex))throw Error('RECEIPT_ORIGINAL_NOT_SIGNED');
    let previous=root,parent=rootHash;
    const rows=this.db.prepare('SELECT * FROM receipt_renewals WHERE chain_id=? AND arbiter=? AND context_hash=? ORDER BY rowid').all(domain.chainId,domain.arbiter.toLowerCase(),root.contextHash.toLowerCase());
    for(const row of rows){
      const next=UnsignedReceiptSchema.parse(JSON.parse(String(row.receipt_json))),{expiresAt:_oldExpiry,signature:_oldSignature,...oldFields}=previous,{expiresAt:_newExpiry,...newFields}=next;
      if(row.parent_hash!==parent||!isDeepStrictEqual(oldFields,newFields)||BigInt(next.expiresAt)<=BigInt(previous.expiresAt)||receiptHash(next,domain)!==row.receipt_hash)throw Error('RECEIPT_RENEWAL_RECORD_INVALID');
      const status=String(row.status);if(!['RESERVED','SIGNED','UNKNOWN'].includes(status)||(status==='SIGNED')!==(row.signature!==null))throw Error('RECEIPT_RENEWAL_RECORD_INVALID');
      if(status!=='SIGNED'){if(row!==rows[rows.length-1])throw Error('RECEIPT_RENEWAL_RECORD_INVALID');return {status:status as 'RESERVED'|'UNKNOWN',receipt:next,receiptHash:String(row.receipt_hash)};}
      previous=DecisionReceiptSchema.parse({...next,signature:row.signature});parent=digest.parse(row.receipt_hash) as Hex;
    }
    return {status:'SIGNED' as const,receipt:previous,receiptHash:parent};
  }
  reserveRenewal(root:ReturnType<typeof DecisionReceiptSchema.parse>,previous:ReturnType<typeof DecisionReceiptSchema.parse>,input:unknown,domain:{chainId:string;arbiter:string}){
    const next=UnsignedReceiptSchema.parse(input),{signature:_signature,...parentReceipt}=previous,parent=receiptHash(parentReceipt,domain);
    const {expiresAt:_oldExpiry,...oldFields}=parentReceipt,{expiresAt:_newExpiry,...newFields}=next;
    if(!isDeepStrictEqual(oldFields,newFields)||BigInt(next.expiresAt)<=BigInt(previous.expiresAt))throw Error('RECEIPT_RENEWAL_SCOPE_REJECTED');
    this.db.exec('BEGIN IMMEDIATE');try{
      const latest=this.latestRenewal(domain,root);if(latest.status!=='SIGNED'||latest.receiptHash!==parent){this.db.exec('COMMIT');return false;}
      this.db.prepare('INSERT INTO receipt_renewals VALUES(?,?,?,?,?,?,?,NULL)').run(domain.chainId,domain.arbiter.toLowerCase(),next.contextHash.toLowerCase(),parent,receiptHash(next,domain),JSON.stringify(next),'RESERVED');
      this.db.exec('COMMIT');return true;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  finishRenewal(input:unknown,domain:{chainId:string;arbiter:string},signature:string|null){
    const next=UnsignedReceiptSchema.parse(input);if(signature!==null)DecisionReceiptSchema.parse({...next,signature});
    const result=this.db.prepare("UPDATE receipt_renewals SET status=?,signature=? WHERE chain_id=? AND arbiter=? AND context_hash=? AND receipt_hash=? AND status='RESERVED'").run(signature?'SIGNED':'UNKNOWN',signature,domain.chainId,domain.arbiter.toLowerCase(),next.contextHash.toLowerCase(),receiptHash(next,domain));
    if(result.changes!==1)throw Error('RECEIPT_RENEWAL_RECORD_CONFLICT');
  }
  close(){this.db.close();}
}
