import {IntentCapsuleSchema} from '../../protocol/src/schemas.js';
import {createReport} from '../../protocol/src/report.js';
import {CapsuleFileSchema,CapsulePayloadSchema,NamespaceSchema,KeyReferenceSchema,capsuleAAD,decodeBase64,encodeBase64,type CapsuleFile} from './format.js';
export interface PrfSource {evaluate(salt:Uint8Array<ArrayBuffer>):Promise<Uint8Array<ArrayBuffer>>;}
export class CapsuleError extends Error {constructor(code:string){super(code);}}
export async function namespaceSalt(namespace:unknown):Promise<Uint8Array<ArrayBuffer>> {
  const n=NamespaceSchema.parse(namespace);return new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(['IntentPass.PRFSalt',1,n]))));
}
async function withKey<T>(source:PrfSource,namespace:unknown,run:(key:CryptoKey)=>Promise<T>):Promise<T> {
  const raw=await source.evaluate(await namespaceSalt(namespace));
  try{if(raw.length!==32)throw new CapsuleError('PRF_UNSUPPORTED');const key=await crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['encrypt','decrypt']);return await run(key);}finally{raw.fill(0);}
}
type CapsuleMetadata=Pick<CapsuleFile['capsule'],'namespace'|'objectId'|'revision'>;
async function encryptUsing(payload:unknown,metadata:CapsuleMetadata,keyReference:CapsuleFile['keyReference'],encrypt:(iv:Uint8Array<ArrayBuffer>,aad:Uint8Array<ArrayBuffer>,clear:Uint8Array<ArrayBuffer>)=>Promise<ArrayBuffer>):Promise<CapsuleFile> {
  const p=CapsulePayloadSchema.parse(payload),n=NamespaceSchema.parse(metadata.namespace),ref=KeyReferenceSchema.parse(keyReference);
  if(p.kind==='memory'&&p.taskInput&&createReport(p.taskInput.dataset).datasetHash.toLowerCase()!==p.policy.datasetHash.toLowerCase())throw new CapsuleError('CAPSULE_CONTEXT_MISMATCH');
  if(p.kind!==n[2]||p.kind==='authorization'&&p.intent.orderId.toLowerCase()!==metadata.objectId.toLowerCase())throw new CapsuleError('CAPSULE_CONTEXT_MISMATCH');
  const iv=crypto.getRandomValues(new Uint8Array(12));
  // Temporary valid ciphertext placeholder solely to validate/header-encode before encryption.
  const shell=CapsuleFileSchema.parse({format:'IntentPass.Capsule.v1',keyReference:ref,capsule:IntentCapsuleSchema.parse({schemaVersion:1,...metadata,objectId:metadata.objectId.toLowerCase(),namespace:n,iv:encodeBase64(iv),ciphertext:encodeBase64(new Uint8Array(18))})});
  const clear=new TextEncoder().encode(JSON.stringify(p));
  try {
    const encrypted=await encrypt(iv,capsuleAAD(shell),clear);
    return CapsuleFileSchema.parse({...shell,capsule:{...shell.capsule,ciphertext:encodeBase64(new Uint8Array(encrypted))}});
  }finally{clear.fill(0);}
}
export async function encryptCapsule(payload:unknown,metadata:CapsuleMetadata,keyReference:CapsuleFile['keyReference'],source:PrfSource):Promise<CapsuleFile> {
  return encryptUsing(payload,metadata,keyReference,(iv,aad,clear)=>withKey(source,metadata.namespace,key=>crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad,tagLength:128},key,clear)));
}
/** A single encryption key prepared before short-lived financial permission.
 * PRF bytes are wiped immediately; the non-extractable CryptoKey stays in this
 * private RAM slot only, for one namespace/reference and at most five minutes. */
export class PreparedCapsuleKey {
  #key:CryptoKey|undefined;
  #expires:number;
  #timer:ReturnType<typeof setTimeout>;
  #namespace:string;
  #reference:string;
  private constructor(key:CryptoKey,namespace:ReturnType<typeof NamespaceSchema.parse>,reference:CapsuleFile['keyReference'],ttl:number){
    this.#namespace=JSON.stringify(namespace);this.#reference=JSON.stringify(reference);
    this.#key=key;this.#expires=performance.now()+ttl;this.#timer=setTimeout(()=>this.dispose(),ttl);
    if(typeof this.#timer==='object'&&'unref' in this.#timer)this.#timer.unref();
  }
  static async prepare(namespace:unknown,reference:CapsuleFile['keyReference'],source:PrfSource,active:()=>void=()=>{},ttl=300000){
    if(!Number.isSafeInteger(ttl)||ttl<1||ttl>300000)throw new CapsuleError('PREPARED_KEY_TTL_INVALID');
    const n=NamespaceSchema.parse(namespace),ref=KeyReferenceSchema.parse(reference);active();
    return withKey(source,n,async key=>{active();return new PreparedCapsuleKey(key,n,ref,ttl);});
  }
  get ready(){if(performance.now()>=this.#expires)this.dispose();return this.#key!==undefined;}
  get remainingMs(){return this.ready?Math.max(0,this.#expires-performance.now()):0;}
  dispose(){this.#key=undefined;clearTimeout(this.#timer);}
  async encrypt(payload:unknown,metadata:CapsuleMetadata,reference:CapsuleFile['keyReference']){
    if(!this.ready)throw new CapsuleError('PREPARED_KEY_EXPIRED');
    if(JSON.stringify(NamespaceSchema.parse(metadata.namespace))!==this.#namespace||JSON.stringify(KeyReferenceSchema.parse(reference))!==this.#reference)throw new CapsuleError('PREPARED_KEY_CONTEXT_MISMATCH');
    const key=this.#key!;this.dispose();
    return encryptUsing(payload,metadata,reference,(iv,aad,clear)=>crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad,tagLength:128},key,clear));
  }
}
export async function decryptCapsule(input:unknown,source:PrfSource) {
  const f=CapsuleFileSchema.parse(input);let clear:Uint8Array<ArrayBuffer>|undefined;
  try {
    clear=new Uint8Array(await withKey(source,f.capsule.namespace,key=>crypto.subtle.decrypt({name:'AES-GCM',iv:decodeBase64(f.capsule.iv),additionalData:capsuleAAD(f),tagLength:128},key,decodeBase64(f.capsule.ciphertext))));
    const p=CapsulePayloadSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(clear)));
    if(p.kind==='memory'&&p.taskInput&&createReport(p.taskInput.dataset).datasetHash.toLowerCase()!==p.policy.datasetHash.toLowerCase())throw new Error();
    if(p.kind!==f.capsule.namespace[2]||p.kind==='authorization'&&p.intent.orderId.toLowerCase()!==f.capsule.objectId.toLowerCase())throw new Error();return p;
  }catch(error){if(error instanceof CapsuleError)throw error;throw new CapsuleError('CAPSULE_AUTH_FAILED');}finally{clear?.fill(0);}
}
export function exportCapsule(input:unknown):string {return JSON.stringify(CapsuleFileSchema.parse(input));}
export function importCapsule(text:string):CapsuleFile {if(text.length>1500000)throw new CapsuleError('CAPSULE_TOO_LARGE');return CapsuleFileSchema.parse(JSON.parse(text));}
