import {z} from 'zod';
import {CapsuleFileSchema} from './format.js';
import {digest,uint} from '../../protocol/src/schemas.js';
export class CapsuleClient {
  private base:URL;
  constructor(baseUrl:string,private token:()=>Promise<string>,private transport:typeof fetch=fetch) {
    this.base=new URL(baseUrl);
    if(this.base.username||this.base.password||this.base.search||this.base.hash
      ||(this.base.protocol!=='https:'&&!(this.base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(this.base.hostname))))throw new Error('CAPSULE_ENDPOINT_INVALID');
  }
  private async request(id:string,upload?:unknown) {
    const token=await this.token();if(!token||token.length>16384)throw new Error('AUTHENTICATION_REQUIRED');
    const response=await this.transport.call(globalThis,new URL(`/api/capsules/${digest.parse(id)}`,this.base),{
      method:upload===undefined?'GET':'PUT',headers:{Authorization:`Bearer ${token}`,...(upload===undefined?{}:{'Content-Type':'application/json'})},
      ...(upload===undefined?{}:{body:JSON.stringify(upload)}),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error(`CAPSULE_HTTP_${response.status}`);
    // Server response is untrusted; cap decoded bytes before JSON/schema parsing.
    const reader=response.body?.getReader();if(!reader)throw new Error('CAPSULE_RESPONSE_INVALID');
    let size=0;const chunks:Uint8Array[]=[];
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1500000){await reader.cancel();throw new Error('CAPSULE_RESPONSE_TOO_LARGE');}chunks.push(value);}}finally{reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const result=z.object({file:CapsuleFileSchema}).strict().parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
    if(result.file.capsule.objectId.toLowerCase()!==id.toLowerCase())throw new Error('CAPSULE_RESPONSE_MISMATCH');return result.file;
  }
  get(id:string){return this.request(id);}
  async put(input:unknown,expectedRevision:string){
    const file=CapsuleFileSchema.parse(input);uint.parse(expectedRevision);
    const saved=await this.request(file.capsule.objectId,{file,expectedRevision});
    if(JSON.stringify(saved)!==JSON.stringify(file))throw new Error('CAPSULE_RESPONSE_MISMATCH');return saved;
  }
}
