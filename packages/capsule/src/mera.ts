import {getPasskeyPrfOutput,createPasskeyWithPrfOutput,isMeraError,type WebAuthnClient} from '@category-labs/mera';
import {KeyReferenceSchema,type CapsuleFile} from './format.js';
import {CapsuleError,namespaceSalt,type PrfSource} from './crypto.js';
import {requirePasskeyDomain} from './rp-domain.js';

function failure(error:unknown):never {
  if(isMeraError(error)) {
    if(error.code==='PRF_UNAVAILABLE')throw new CapsuleError('PRF_UNSUPPORTED');
    const cause=error.cause;
    if(cause instanceof Error&&['NotAllowedError','AbortError'].includes(cause.name))throw new CapsuleError('PASSKEY_CANCELLED');
    if(cause instanceof Error&&cause.name==='SecurityError')throw new CapsuleError('RPID_MISMATCH');
  }
  throw new CapsuleError('PASSKEY_UNAVAILABLE');
}
/** Default client is Mera's real browser WebAuthn client; injection is for platform tests. */
export class MeraPrfSource implements PrfSource {
  private ref:CapsuleFile['keyReference'];
  constructor(reference:CapsuleFile['keyReference'],private client?:WebAuthnClient){this.ref=KeyReferenceSchema.parse(reference);}
  async evaluate(salt:Uint8Array<ArrayBuffer>) {
    try {
      const result=await getPasskeyPrfOutput({rpId:this.ref.rpId,credential:{credentialId:this.ref.credentialId},prfSalt:salt,timeout:60000,webAuthnClient:this.client});
      if(result.credentialId!==this.ref.credentialId){result.prfOutput.fill(0);throw new CapsuleError('PASSKEY_MISMATCH');}
      return result.prfOutput;
    }catch(error){if(error instanceof CapsuleError)throw error;return failure(error);}
  }
}
export async function createCapsulePasskey(rpId:string,user:{name:string;displayName:string},namespace:unknown,client?:WebAuthnClient) {
  requirePasskeyDomain(rpId);
  // Validate RP before showing any ceremony; ID placeholder is public and only for validation.
  KeyReferenceSchema.parse({rpId,credentialId:'AQ'});
  try {
    const result=await createPasskeyWithPrfOutput({rp:{id:rpId,name:'IntentPass'},user,prfSalt:await namespaceSalt(namespace),timeout:60000,webAuthnClient:client});
    try{return KeyReferenceSchema.parse({rpId,credentialId:result.credentialId});}finally{result.prfOutput.fill(0);}
  }catch(error){return failure(error);}
}
