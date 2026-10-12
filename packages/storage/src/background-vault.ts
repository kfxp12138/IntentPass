import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {z} from 'zod';
import {privateServiceDirectory,readPrivateServiceJson,writePrivateServiceJsonOnce} from '../../../scripts/create-privy-service-wallets.js';

const hash=z.string().regex(/^[a-f0-9]{64}$/),kind=z.enum(['memory','authorization','checkpoint']);
const envelope=z.object({format:z.literal('IntentPass.BackgroundBackup.v1'),kind,objectId:hash,scopeHash:hash,iv:z.string().regex(/^[a-f0-9]{24}$/),tag:z.string().regex(/^[a-f0-9]{32}$/),ciphertext:z.string().max(3000000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)}).strict();
export type BackgroundBackupReceipt={format:'IntentPass.BackgroundBackup.v1';kind:z.infer<typeof kind>;objectId:string;scopeHash:string;fileHash:string;};
/** Separate backend trust model. Never uses, exports or claims Mera PRF material.
 * Private immutable files and authenticated metadata permit unattended restarts.
 */
export class BackgroundVault {
  readonly #key:Buffer;
  private closed=false;
  constructor(private directory:string){
    directory=resolve(directory);this.directory=directory;privateServiceDirectory(directory);
    const path=resolve(directory,'key.json');
    if(!existsSync(path)){const bytes=randomBytes(32);try{writePrivateServiceJsonOnce(path,{version:1,key:bytes.toString('hex')});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}finally{bytes.fill(0);}}
    const record=z.object({version:z.literal(1),key:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(readPrivateServiceJson(path));this.#key=Buffer.from(record.key,'hex');
  }
  private path(type:z.infer<typeof kind>,id:string){return resolve(this.directory,`${kind.parse(type)}-${hash.parse(id)}.json`);}
  private aad(type:string,id:string,scope:string){return Buffer.from(JSON.stringify(['IntentPass.BackgroundBackup',1,type,id,scope]));}
  reserve(scopeHash:string){
    if(this.closed)throw Error('BACKGROUND_VAULT_CLOSED');hash.parse(scopeHash);
    try{writePrivateServiceJsonOnce(resolve(this.directory,'single-job.json'),{scopeHash});}catch{throw Error('BACKGROUND_ORIGINAL_JOB_RECONCILIATION_REQUIRED');}
  }
  save(type:z.infer<typeof kind>,objectId:string,scopeHash:string,input:unknown):BackgroundBackupReceipt{
    if(this.closed)throw Error('BACKGROUND_VAULT_CLOSED');kind.parse(type);hash.parse(objectId);hash.parse(scopeHash);
    const bytes=Buffer.from(JSON.stringify(input));if(bytes.length<1||bytes.length>500000)throw Error('BACKGROUND_BACKUP_SIZE_INVALID');
    try{
      const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.#key,iv);cipher.setAAD(this.aad(type,objectId,scopeHash));
      const ciphertext=Buffer.concat([cipher.update(bytes),cipher.final()]);
      const file=envelope.parse({format:'IntentPass.BackgroundBackup.v1',kind:type,objectId,scopeHash,iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),ciphertext:ciphertext.toString('base64')});
      const path=this.path(type,objectId);
      if(existsSync(path))throw Error('BACKGROUND_ORIGINAL_BACKUP_LOCKED');
      writePrivateServiceJsonOnce(path,file);
      // A successful write alone is insufficient: read and decrypt the same file.
      const restored=this.open(type,objectId,scopeHash);
      if(JSON.stringify(restored)!==bytes.toString('utf8'))throw Error('BACKGROUND_BACKUP_READBACK_FAILED');
      return {format:file.format,kind:type,objectId,scopeHash,fileHash:createHash('sha256').update(JSON.stringify(file)).digest('hex')};
    }finally{bytes.fill(0);}
  }
  open(type:z.infer<typeof kind>,objectId:string,scopeHash:string):unknown{
    if(this.closed)throw Error('BACKGROUND_VAULT_CLOSED');hash.parse(scopeHash);
    try{
      const file=envelope.parse(readPrivateServiceJson(this.path(type,objectId)));
      if(file.kind!==type||file.objectId!==objectId||file.scopeHash!==scopeHash)throw Error();
      const decipher=createDecipheriv('aes-256-gcm',this.#key,Buffer.from(file.iv,'hex'));decipher.setAAD(this.aad(type,objectId,scopeHash));decipher.setAuthTag(Buffer.from(file.tag,'hex'));
      const bytes=Buffer.concat([decipher.update(Buffer.from(file.ciphertext,'base64')),decipher.final()]);
      try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}finally{bytes.fill(0);}
    }catch{throw Error('BACKGROUND_BACKUP_UNAVAILABLE');}
  }
  dispose(){this.closed=true;this.#key.fill(0);}
}
