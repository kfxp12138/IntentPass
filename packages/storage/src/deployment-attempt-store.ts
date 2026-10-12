import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {constants,openSync,closeSync,lstatSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {z} from 'zod';

const hash=z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(value=>value.toLowerCase());
const commit=z.string().regex(/^[0-9a-fA-F]{40}$/).transform(value=>value.toLowerCase());
const address=z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(value=>!/^0x0{40}$/.test(value)).transform(value=>value.toLowerCase());
const quantityPattern=/^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const isQuantity=(value:string)=>value.length<=66&&quantityPattern.test(value);
const quantity=z.string().max(66).regex(quantityPattern).refine(value=>isQuantity(value)&&BigInt(value)<2n**256n);
const positiveQuantity=quantity.refine(value=>isQuantity(value)&&BigInt(value)>0n);
const metadataShape={planId:hash,sourceCommit:commit,chainId:z.literal('10143'),deployer:address,initCodeHash:hash,nonce:quantity,gas:positiveQuantity,maxFeePerGas:positiveQuantity,maxPriorityFeePerGas:quantity};
export const DeploymentAttemptInputSchema=z.object(metadataShape).strict().refine(value=>isQuantity(value.maxPriorityFeePerGas)&&isQuantity(value.maxFeePerGas)&&BigInt(value.maxPriorityFeePerGas)<=BigInt(value.maxFeePerGas));
export type DeploymentAttemptInput=z.infer<typeof DeploymentAttemptInputSchema>;
export const DeploymentAttemptRecordSchema=z.object({...metadataShape,attemptId:z.uuid().transform(value=>value.toLowerCase()),status:z.enum(['RESERVED','SUBMITTED','CONFIRMED','REVERTED']),transactionHash:hash.nullable(),contractAddress:address.nullable(),createdAt:z.iso.datetime(),updatedAt:z.iso.datetime()}).strict().superRefine((record,context)=>{
  if(!isQuantity(record.maxPriorityFeePerGas)||!isQuantity(record.maxFeePerGas)||BigInt(record.maxPriorityFeePerGas)>BigInt(record.maxFeePerGas)||Date.parse(record.updatedAt)<Date.parse(record.createdAt)
    ||record.status==='RESERVED'&&(record.transactionHash!==null||record.contractAddress!==null)
    ||record.status==='SUBMITTED'&&(record.transactionHash===null||record.contractAddress!==null)
    ||record.status==='CONFIRMED'&&(record.transactionHash===null||record.contractAddress===null)
    ||record.status==='REVERTED'&&(record.transactionHash===null||record.contractAddress!==null))context.addIssue({code:'custom',message:'DEPLOYMENT_RECORD_INVALID'});
});
export type DeploymentAttemptRecord=z.infer<typeof DeploymentAttemptRecordSchema>;

function parse<T>(schema:z.ZodType<T>,value:unknown):T {try{const parsed=schema.safeParse(value);if(parsed.success)return parsed.data;}catch{}throw new Error('DEPLOYMENT_METADATA_INVALID');}
function privateFile(path:string){
  const file=lstatSync(path);if(!file.isFile()||file.isSymbolicLink()||(file.mode&0o777)!==0o600||typeof process.getuid==='function'&&file.uid!==process.getuid())throw new Error('DEPLOYMENT_ATTEMPT_CONFIGURATION_INVALID');
}
function optionalPrivateFile(path:string){try{privateFile(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
function clock(previous?:string){return new Date(Math.max(Date.now(),previous?Date.parse(previous):0)).toISOString();}

/** A durable local journal, not proof of a wallet call or chain receipt.
 * RESERVED without a hash includes unknown sends and never expires or releases a nonce.
 */
export class DeploymentAttemptStore {
  private readonly db:DatabaseSync;
  private closed=false;
  constructor(path:string){
    if(typeof path!=='string'||!isAbsolute(path)||!path.endsWith('.db'))throw new Error('DEPLOYMENT_ATTEMPT_CONFIGURATION_INVALID');
    try{
      try{const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);closeSync(fd);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
      privateFile(path);for(const suffix of ['-wal','-shm'])optionalPrivateFile(path+suffix);
    }catch{throw new Error('DEPLOYMENT_ATTEMPT_CONFIGURATION_INVALID');}
    let db:DatabaseSync|undefined;
    try{
      db=new DatabaseSync(path);
      db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS deployment_attempts(
          plan_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE,
          chain_id TEXT NOT NULL, deployer TEXT NOT NULL, nonce TEXT NOT NULL,
          record_json TEXT NOT NULL, UNIQUE(chain_id,deployer,nonce)
        ) STRICT;`);
      privateFile(path);for(const suffix of ['-wal','-shm'])optionalPrivateFile(path+suffix);
      this.db=db;
    }catch{db?.close();throw new Error('DEPLOYMENT_ATTEMPT_CONFIGURATION_INVALID');}
  }
  get(planId:string):DeploymentAttemptRecord|null {
    const id=parse(hash,planId);if(this.closed)throw new Error('DEPLOYMENT_JOURNAL_CLOSED');
    const row=this.db.prepare('SELECT attempt_id,chain_id,deployer,nonce,record_json FROM deployment_attempts WHERE plan_id=?').get(id);if(!row)return null;
    try{
      if(typeof row.record_json!=='string'||row.record_json.length>8192)throw new Error();
      const record=DeploymentAttemptRecordSchema.parse(JSON.parse(row.record_json));
      if(record.planId!==id||record.attemptId!==row.attempt_id||record.chainId!==row.chain_id||record.deployer!==row.deployer||record.nonce!==row.nonce)throw new Error();return record;
    }catch{throw new Error('DEPLOYMENT_RECORD_INVALID');}
  }
  reserve(input:DeploymentAttemptInput):DeploymentAttemptRecord {
    if(input===null||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input))||Reflect.ownKeys(input).some(key=>typeof key!=='string'||!Object.hasOwn(metadataShape,key)))throw new Error('DEPLOYMENT_METADATA_INVALID');
    const metadata=parse(DeploymentAttemptInputSchema,input);
    return this.transaction(()=>{
      if(this.get(metadata.planId))throw new Error('DEPLOYMENT_ATTEMPT_EXISTS');
      if(this.db.prepare('SELECT 1 FROM deployment_attempts WHERE chain_id=? AND deployer=? AND nonce=?').get(metadata.chainId,metadata.deployer,metadata.nonce))throw new Error('DEPLOYMENT_NONCE_ALREADY_RESERVED');
      const at=clock(),record=DeploymentAttemptRecordSchema.parse({...metadata,attemptId:randomUUID(),status:'RESERVED',transactionHash:null,contractAddress:null,createdAt:at,updatedAt:at});
      this.db.prepare('INSERT INTO deployment_attempts VALUES(?,?,?,?,?,?)').run(record.planId,record.attemptId,record.chainId,record.deployer,record.nonce,JSON.stringify(record));return record;
    });
  }
  recordHash(planId:string,attemptId:string,transactionHash:string):DeploymentAttemptRecord {
    const boundHash=parse(hash,transactionHash);
    return this.update(planId,attemptId,old=>{
      if(old.transactionHash!==null){if(old.transactionHash!==boundHash)throw new Error('DEPLOYMENT_RECORD_CONFLICT');return old;}
      if(old.status!=='RESERVED')throw new Error('DEPLOYMENT_RECORD_CONFLICT');return {...old,status:'SUBMITTED',transactionHash:boundHash,updatedAt:clock(old.updatedAt)};
    });
  }
  markConfirmed(planId:string,attemptId:string,transactionHash:string,contractAddress:string):DeploymentAttemptRecord {
    const boundHash=parse(hash,transactionHash),boundAddress=parse(address,contractAddress);
    return this.update(planId,attemptId,old=>{
      if(old.transactionHash!==boundHash)throw new Error('DEPLOYMENT_RECORD_CONFLICT');
      if(old.status==='CONFIRMED'){if(old.contractAddress!==boundAddress)throw new Error('DEPLOYMENT_RECORD_CONFLICT');return old;}
      if(old.status!=='SUBMITTED')throw new Error('DEPLOYMENT_RECORD_CONFLICT');return {...old,status:'CONFIRMED',contractAddress:boundAddress,updatedAt:clock(old.updatedAt)};
    });
  }
  markReverted(planId:string,attemptId:string,transactionHash:string):DeploymentAttemptRecord {
    const boundHash=parse(hash,transactionHash);
    return this.update(planId,attemptId,old=>{
      if(old.transactionHash!==boundHash)throw new Error('DEPLOYMENT_RECORD_CONFLICT');
      if(old.status==='REVERTED')return old;
      if(old.status!=='SUBMITTED')throw new Error('DEPLOYMENT_RECORD_CONFLICT');return {...old,status:'REVERTED',updatedAt:clock(old.updatedAt)};
    });
  }
  private transaction<T>(action:()=>T):T {
    if(this.closed)throw new Error('DEPLOYMENT_JOURNAL_CLOSED');this.db.exec('BEGIN IMMEDIATE');
    try{const result=action();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  private update(planId:string,attemptId:string,change:(old:DeploymentAttemptRecord)=>DeploymentAttemptRecord):DeploymentAttemptRecord {
    const id=parse(hash,planId),attempt=parse(z.uuid().transform(value=>value.toLowerCase()),attemptId);
    return this.transaction(()=>{
      const old=this.get(id);if(!old)throw new Error('DEPLOYMENT_ATTEMPT_REQUIRED');if(old.attemptId!==attempt)throw new Error('DEPLOYMENT_RECORD_CONFLICT');
      const next=DeploymentAttemptRecordSchema.parse(change(old));this.db.prepare('UPDATE deployment_attempts SET record_json=? WHERE plan_id=? AND attempt_id=?').run(JSON.stringify(next),id,attempt);return next;
    });
  }
  close(){if(!this.closed){this.db.close();this.closed=true;}}
}
