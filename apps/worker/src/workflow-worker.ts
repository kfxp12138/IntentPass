import {randomUUID} from 'node:crypto';
import {WorkflowSubmissionSchema,JsonValueSchema,workflowDigest,type JsonValue} from '../../../packages/automation/src/workflow.js';
import {WorkflowStore,type WorkflowJob} from '../../../packages/storage/src/workflow-store.js';
export interface WorkflowVault {save(id:string,value:JsonValue):Promise<void>;open(id:string):Promise<JsonValue>;}
export interface WorkflowContext {jobId:string;stepId:string;idempotencyKey:string;input:JsonValue;outputs:Readonly<Record<string,JsonValue>>;dispatch<T extends JsonValue>(send:(idempotencyKey:string)=>Promise<T>):Promise<T>;assertActive():void;}
export type WorkflowResult={status:'COMPLETE';output:JsonValue}|{status:'WAITING';nextAt:number}|{status:'UNKNOWN';nextAt:number}|{status:'FAILED'};
export interface WorkflowHandler {effect:'READ'|'WRITE';version?:string;execute(context:WorkflowContext):Promise<WorkflowResult>;reconcile?(context:WorkflowContext,originalDispatch:JsonValue|null):Promise<WorkflowResult>;}
export class WorkflowRegistry {
  private readonly handlers=new Map<string,WorkflowHandler>();
  register(name:string,handler:WorkflowHandler){if(!/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(name)||this.handlers.has(name))throw Error('WORKFLOW_HANDLER_CONFLICT');this.handlers.set(name,Object.freeze({...handler}));}
  get(name:string){const h=this.handlers.get(name);if(!h)throw Error('WORKFLOW_HANDLER_UNAVAILABLE');return h;}
}
/** General durable orchestration. Handlers describe their own task semantics;
 * no fixed dataset, catalogue, price, job count or activation lifetime. */
export class WorkflowWorker {
  constructor(private store:WorkflowStore,private vault:WorkflowVault,private registry:WorkflowRegistry,private clock=Date.now,private leaseMs=30000){}
  async submit(input:unknown,owner='local'){const s=WorkflowSubmissionSchema.parse(input);for(const step of s.workflow.steps){const h=this.registry.get(step.handler);if(h.effect!==step.effect||(h.version??'1')!==step.handlerVersion)throw Error('WORKFLOW_HANDLER_EFFECT_OR_VERSION_MISMATCH');}const binding=workflowDigest({owner,workflow:s.workflow,input:s.input,runAt:s.runAt}),ref=workflowDigest({kind:'input',binding}),id=randomUUID();await this.vault.save(ref,s.input);return this.store.enqueue(s,ref,id,binding,owner);}
  async tick(){const job=this.store.claim(this.clock(),this.leaseMs);if(!job)return null;await this.execute(job);return this.store.get(job.id)!;}
  private async execute(job:WorkflowJob){
    let heartbeat:ReturnType<typeof setInterval>|undefined;const active=()=>{this.store.assertLease(job,this.clock());};
    try{
      const definition=job.workflow.steps[job.cursor],handler=this.registry.get(definition.handler);if(handler.effect!==definition.effect||(handler.version??'1')!==definition.handlerVersion)throw Error('WORKFLOW_HANDLER_EFFECT_OR_VERSION_MISMATCH');
      const input=await this.vault.open(job.inputRef),outputs:Record<string,JsonValue>=Object.create(null);active();
      for(let i=0;i<job.cursor;i++){const step=this.store.step(job.id,i);if(!step.resultRef)throw Error('WORKFLOW_OUTPUT_MISSING');outputs[job.workflow.steps[i].id]=await this.vault.open(step.resultRef);active();}
      heartbeat=setInterval(()=>{try{this.store.heartbeat(job,this.clock(),this.leaseMs);}catch{/* Active guards fence late results and dispatches. */}},Math.max(250,Math.floor(this.leaseMs/3)));heartbeat.unref();
      const context:WorkflowContext={jobId:job.id,stepId:definition.id,idempotencyKey:this.store.step(job.id,job.cursor).idempotencyKey,input,outputs:Object.freeze(outputs),assertActive:active,dispatch:async send=>{active();this.store.markDispatch(job,this.clock());const result=JsonValueSchema.parse(await send(context.idempotencyKey));const ref=workflowDigest({kind:'dispatch',jobId:job.id,index:job.cursor,result});await this.vault.save(ref,result);this.store.saveDispatch(job,ref,this.clock());active();return result as Awaited<ReturnType<typeof send>>;}};
      const step=this.store.step(job.id,job.cursor);let result:WorkflowResult;
      if(step.dispatched){if(!handler.reconcile){this.store.suspend(job,'ATTENTION',this.clock(),this.clock());return;}result=await handler.reconcile(context,step.dispatchRef?await this.vault.open(step.dispatchRef):null);}
      else result=await handler.execute(context);active();
      if(result.status==='COMPLETE'){const output=JsonValueSchema.parse(result.output),ref=workflowDigest({kind:'output',jobId:job.id,index:job.cursor,output});await this.vault.save(ref,output);active();this.store.complete(job,ref,this.clock());}
      else if(result.status==='FAILED')this.store.suspend(job,'FAILED',this.clock(),this.clock());
      else {if(!Number.isSafeInteger(result.nextAt)||result.nextAt<=this.clock())throw Error('WORKFLOW_NEXT_TIME_INVALID');this.store.suspend(job,result.status==='UNKNOWN'?'RECONCILING':'WAITING',this.clock(),result.nextAt);}
    }catch{
      try{const step=this.store.step(job.id,job.cursor),definition=job.workflow.steps[job.cursor];this.store.suspend(job,step.dispatched?(this.registry.get(definition.handler).reconcile?'RECONCILING':'ATTENTION'):step.attempts>=definition.maxAttempts?'FAILED':'WAITING',this.clock(),this.clock()+definition.retryDelayMs);}catch{/* A lost lease or cancellation cannot resurrect a job. */}
    }finally{if(heartbeat)clearInterval(heartbeat);}
  }
}
