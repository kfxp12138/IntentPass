import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {LocalSdkReadResultSchema,LocalSdkSessionInputSchema,LocalSdkWorkflowSessionSchema,LocalSdkWorkflowResultSchema} from '../../../packages/protocol/src/local-sdk-read.js';
import {LocalSdkProcurementSessionSchema,LocalSdkProcurementReceiptSchema} from '../../../packages/protocol/src/local-sdk-procurement.js';
export async function runLocalSdkProcurement(input:{request:unknown;token:string;expectedSubject:string;port:number}){
  const payload=LocalSdkProcurementSessionSchema.parse({...input.request as object,token:input.token,expectedSubject:input.expectedSubject});
  const result=LocalSdkProcurementReceiptSchema.parse(await runChild(payload,input.port,'procure'));
  if(result.taskId.toLowerCase()!==payload.memory.policy.taskId.toLowerCase()||!result.walletAddresses.some(w=>w.toLowerCase()===payload.memory.taskInput.buyer.toLowerCase()))throw Error('LOCAL_SDK_SUBMISSION_UNCONFIRMED');return result;
}
export async function runLocalSdkRead(input:{orderId:string;token:string;expectedSubject:string;port:number}){
  const payload=LocalSdkSessionInputSchema.parse({orderId:input.orderId,token:input.token,expectedSubject:input.expectedSubject});
  const result=LocalSdkReadResultSchema.parse(await runChild(payload,input.port,'check-order'));
  if(result.order.orderId.toLowerCase()!==payload.orderId.toLowerCase())throw Error('LOCAL_SDK_READ_UNAVAILABLE');return result;
}
export async function runLocalSdkWorkflow(input:{jobId:string;orderId:string;token:string;expectedSubject:string;port:number}){
  const {port,...raw}=input,payload=LocalSdkWorkflowSessionSchema.parse(raw),result=LocalSdkWorkflowResultSchema.parse(await runChild(payload,port,'check-workflow'));
  if(result.jobId!==payload.jobId||result.order.orderId.toLowerCase()!==payload.orderId.toLowerCase())throw Error('LOCAL_SDK_READ_UNAVAILABLE');return result;
}
async function runChild(payload:unknown,port:number,mode:'check-order'|'check-workflow'|'procure'):Promise<unknown>{
  if(!Number.isSafeInteger(port)||port<1||port>65535)throw Error('LOCAL_SDK_ORIGIN_INVALID');
  const root=fileURLToPath(new URL('../../../',import.meta.url)),entry=fileURLToPath(new URL('../../../examples/client/index.ts',import.meta.url));
  // Token stays in stdin/RAM. No env file, inherited server secrets, shell, or caller-selected command/URL.
  const child=spawn(process.execPath,['--import','tsx',entry,mode,...(mode==='procure'?['--local-procurement-input','--confirm']:['--local-session-input'])],{cwd:root,env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,INTENTPASS_URL:`http://127.0.0.1:${port}`},stdio:['pipe','pipe','pipe']});
  const chunks:Buffer[]=[];let count=0,failed=false;
  return new Promise<unknown>((resolve,reject)=>{
    let force:ReturnType<typeof setTimeout>|undefined;
    const stop=()=>{if(failed)return;failed=true;child.kill('SIGTERM');force=setTimeout(()=>child.kill('SIGKILL'),1000);};
    const timer=setTimeout(stop,45000);
    child.stdout.on('data',chunk=>{const bytes=Buffer.from(chunk);count+=bytes.length;if(count>65536){bytes.fill(0);stop();}else chunks.push(bytes);});
    child.stderr.on('data',chunk=>{count+=Buffer.byteLength(chunk);if(count>65536)stop();});
    child.stdin.on('error',stop);child.once('error',()=>{failed=true;});
    child.once('close',code=>{
      clearTimeout(timer);if(force)clearTimeout(force);try{
        if(failed||code!==0)throw Error();
        const bytes=Buffer.concat(chunks);let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}finally{bytes.fill(0);}
        resolve(value);
      }catch{reject(Error('LOCAL_SDK_READ_UNAVAILABLE'));}finally{chunks.forEach(c=>c.fill(0));}
    });
    child.stdin.end(JSON.stringify(payload));
  });
}
