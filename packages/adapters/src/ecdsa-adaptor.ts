import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {z} from 'zod';
import type {Hex} from 'viem';
import {AdaptorPointSchema,PreSignatureSchema} from '../../protocol/src/adaptor-review.js';
import {digest} from '../../protocol/src/schemas.js';
import {verifiedAdaptorBinary} from '../../../scripts/adaptor-runtime.js';

/** Local experimental bridge. Keys travel only over stdin, never shell/argv/env.
 * The helper implements no cryptography; it calls pinned libsecp256k1-zkp.
 */
export class NativeEcdsaAdaptor {
  private readonly binary=verifiedAdaptorBinary();
  private run(operation:string,values:string[],bytes?:number){
    const input=Buffer.from([operation,...values.map(x=>x.slice(2))].join(' ')+'\n');
    try{
      const output=execFileSync(this.binary,[],{input,encoding:'utf8',timeout:5000,maxBuffer:2048,stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH??'/usr/bin:/bin'}}).trim();
      if(bytes===undefined){if(output!=='0'&&output!=='1')throw Error();return output;}
      if(!new RegExp(`^[0-9a-f]{${bytes*2}}$`).test(output))throw Error();return `0x${output}`;
    }catch{throw Error('ADAPTOR_OPERATION_INVALID');}finally{input.fill(0);}
  }
  publicKey(secret:unknown){return this.run('pub',[digest.parse(secret)],33) as Hex;}
  preSign(secret:unknown,hash:unknown,point:unknown){return this.run('presign',[digest.parse(secret),digest.parse(hash),AdaptorPointSchema.parse(point),'0x'+randomBytes(32).toString('hex')],162) as Hex;}
  verify(publicKey:unknown,hash:unknown,point:unknown,pre:unknown){
    try{return this.run('verify',[AdaptorPointSchema.parse(publicKey),digest.parse(hash),AdaptorPointSchema.parse(point),PreSignatureSchema.parse(pre)])==='1';}catch{return false;}
  }
  complete(publicKey:unknown,hash:unknown,point:unknown,pre:unknown,witness:unknown){return this.run('complete',[AdaptorPointSchema.parse(publicKey),digest.parse(hash),AdaptorPointSchema.parse(point),PreSignatureSchema.parse(pre),digest.parse(witness)],65) as Hex;}
  /** Extraction alone is not signature verification. Verify the entire transcript too. */
  extract(point:unknown,pre:unknown,signature:unknown){const sig=z.string().regex(/^0x[a-fA-F0-9]{128}([a-fA-F0-9]{2})?$/).parse(signature);return this.run('extract',[AdaptorPointSchema.parse(point),PreSignatureSchema.parse(pre),sig.slice(0,130)],32) as Hex;}
}
