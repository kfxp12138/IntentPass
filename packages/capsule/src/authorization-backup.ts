import {AuthorizationPayloadSchema,CapsuleFileSchema,KeyReferenceSchema,authorizationNamespace,type CapsuleFile} from './format.js';
import {verifyOriginalAuthorization,type RecoveryDeployment} from './recovery.js';
import {VerifiedSessionSchema,type VerifiedSession} from './session-schema.js';
import {encryptCapsule,PreparedCapsuleKey,type PrfSource} from './crypto.js';
export interface BackupStorePort {put(file:unknown,expectedRevision:string):Promise<CapsuleFile>;get(objectId:string):Promise<CapsuleFile>;}
export type BackupStatus='NOT_SAVED'|'SAVING'|'SAVED'|'UNKNOWN';
const equalFile=(a:unknown,b:unknown)=>JSON.stringify(CapsuleFileSchema.parse(a))===JSON.stringify(CapsuleFileSchema.parse(b));
/** Ciphertext-only storage coordinator. Immutable original order, revision and key.
 * No signer, model, allowance or payment interface.
 */
export class AuthorizationBackup {
  private encrypted:CapsuleFile|undefined;
  private busy=false;
  private saved:BackupStatus='NOT_SAVED';
  private constructor(private payload:ReturnType<typeof AuthorizationPayloadSchema.parse>,private principal:VerifiedSession,private current:()=>Promise<VerifiedSession>,private store:BackupStorePort){}
  static async create(input:unknown,principal:VerifiedSession,deployment:RecoveryDeployment,current:()=>Promise<VerifiedSession>,store:BackupStorePort) {
    const owner=VerifiedSessionSchema.parse(principal);
    const payload=await verifyOriginalAuthorization(input,owner.wallets,deployment);
    return new AuthorizationBackup(payload,owner,current,store);
  }
  get orderId(){return this.payload.intent.orderId;}
  get status(){return this.saved;}
  get file(){return this.encrypted?CapsuleFileSchema.parse(this.encrypted):undefined;}
  private async guard(active:()=>void){
    active();const owner=VerifiedSessionSchema.parse(await this.current());active();
    if(owner.subject!==this.principal.subject||!owner.wallets.some(w=>w.toLowerCase()===this.payload.intent.buyer.toLowerCase()))throw new Error('BACKUP_SESSION_CHANGED');
  }
  private async exclusive<T>(work:()=>Promise<T>){if(this.busy)throw new Error('BACKUP_OPERATION_PENDING');this.busy=true;try{return await work();}finally{this.busy=false;}}
  seal(reference:CapsuleFile['keyReference'],source:PrfSource|PreparedCapsuleKey,active:()=>void=()=>{}) {
    return this.exclusive(async()=>{
      const ref=KeyReferenceSchema.parse(reference);await this.guard(active);
      if(this.encrypted){if(JSON.stringify(ref)!==JSON.stringify(this.encrypted.keyReference))throw new Error('ORIGINAL_BACKUP_KEY_LOCKED');return this.file!;}
      const metadata={namespace:authorizationNamespace(this.orderId),objectId:this.orderId,revision:'1'};
      const file=source instanceof PreparedCapsuleKey?await source.encrypt(this.payload,metadata,ref):await encryptCapsule(this.payload,metadata,ref,source);
      await this.guard(active);this.encrypted=CapsuleFileSchema.parse(file);return this.file!;
    });
  }
  upload(active:()=>void=()=>{}) {
    return this.exclusive(async()=>{
      if(!this.encrypted)throw new Error('ENCRYPTED_BACKUP_REQUIRED');
      await this.guard(active);if(this.saved==='SAVED')return this.file!;
      if(this.saved==='UNKNOWN')throw new Error('BACKUP_RECONCILIATION_REQUIRED');
      this.saved='SAVING';
      try{
        const result=await this.store.put(this.file!,'0');
        if(!equalFile(result,this.encrypted))throw new Error('BACKUP_CONTENT_MISMATCH');
        await this.guard(active);this.saved='SAVED';return this.file!;
      }catch{this.saved='UNKNOWN';throw new Error('BACKUP_UPLOAD_OUTCOME_UNKNOWN');}
    });
  }
  reconcile(active:()=>void=()=>{}) {
    return this.exclusive(async()=>{
      if(!this.encrypted)throw new Error('ENCRYPTED_BACKUP_REQUIRED');await this.guard(active);
      const result=await this.store.get(this.orderId);await this.guard(active);
      if(!equalFile(result,this.encrypted))throw new Error('BACKUP_CONTENT_MISMATCH');
      this.saved='SAVED';return this.file!;
    });
  }
}
