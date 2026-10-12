import {KeyReferenceSchema,CapsuleFileSchema,memoryNamespace,type CapsuleFile} from '../../../packages/capsule/src/format.js';
import {requirePasskeyDomain} from '../../../packages/capsule/src/rp-domain.js';
/** Read only the public locator of the selected original task capsule. This is not decryption proof. */
export function taskPasskeyReference(input:unknown,taskId:string,rpId:string,existing?:CapsuleFile['keyReference']){
  requirePasskeyDomain(rpId);const file=CapsuleFileSchema.parse(input);
  if(file.keyReference.rpId!==rpId||file.capsule.objectId!==taskId||JSON.stringify(file.capsule.namespace)!==JSON.stringify(memoryNamespace(taskId)))throw Error('ORIGINAL_TASK_PASSKEY_REFERENCE_MISMATCH');
  if(existing&&JSON.stringify(KeyReferenceSchema.parse(existing))!==JSON.stringify(file.keyReference))throw Error('PASSKEY_MISMATCH');
  return KeyReferenceSchema.parse(file.keyReference);
}
export interface PasskeyReferencePort {get():CapsuleFile['keyReference']|undefined;set(reference:CapsuleFile['keyReference']):void;clear():void;}
/** Public locator only. Never stores PRF output, encryption key or wallet material. */
export function createPasskeyReference():PasskeyReferencePort {
  let reference:CapsuleFile['keyReference']|undefined;
  return {get:()=>reference?KeyReferenceSchema.parse(reference):undefined,set:value=>{reference=KeyReferenceSchema.parse(value);},clear:()=>{reference=undefined;}};
}
