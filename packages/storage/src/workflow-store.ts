import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {WorkflowSubmissionSchema,WorkflowSchema,workflowDigest,type Workflow} from '../../automation/src/workflow.js';
export type JobStatus='QUEUED'|'RUNNING'|'WAITING'|'RECONCILING'|'SUCCEEDED'|'FAILED'|'ATTENTION'|'CANCELLED';
export interface WorkflowJob {id:string;workflow:Workflow;inputRef:string;status:JobStatus;cursor:number;runAt:number;lease:string|null;leaseUntil:number|null;cancelRequested:boolean;ownerHash:string;}
export interface WorkflowStep {jobId:string;index:number;status:'READY'|'RUNNING'|'WAITING'|'UNKNOWN'|'COMPLETE'|'FAILED';attempts:number;dispatched:boolean;resultRef:string|null;dispatchRef:string|null;idempotencyKey:string;}
/** Metadata-only queue. Input, dispatch results and step outputs are encrypted in
 * a separate vault before their immutable references enter this database. */
export class WorkflowStore {
  private readonly db:DatabaseSync;
  constructor(path:string){this.db=new DatabaseSync(path);this.db.exec(`PRAGMA busy_timeout=5000;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS workflow_jobs(id TEXT PRIMARY KEY,dedupe TEXT NOT NULL UNIQUE,binding TEXT NOT NULL,workflow_json TEXT NOT NULL,input_ref TEXT NOT NULL,status TEXT NOT NULL,cursor INTEGER NOT NULL,run_at INTEGER NOT NULL,lease TEXT,lease_until INTEGER,cancel_requested INTEGER NOT NULL DEFAULT 0,owner_hash TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS workflow_steps(job_id TEXT NOT NULL,idx INTEGER NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL,dispatched INTEGER NOT NULL,result_ref TEXT,dispatch_ref TEXT,idem TEXT NOT NULL UNIQUE,dispatch_token TEXT,PRIMARY KEY(job_id,idx)) STRICT;
    CREATE TABLE IF NOT EXISTS workflow_events(job_id TEXT NOT NULL,event TEXT NOT NULL,at INTEGER NOT NULL) STRICT;`);}
  private transaction<T>(f:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const result=f();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  enqueue(input:unknown,inputRef:string,id:string,binding:string,owner='local'){
    const s=WorkflowSubmissionSchema.parse(input);if(workflowDigest({owner,workflow:s.workflow,input:s.input,runAt:s.runAt})!==binding||!/^[-a-zA-Z0-9_.]{1,128}$/.test(id)||!/^[-a-zA-Z0-9_.]{1,128}$/.test(inputRef))throw Error('WORKFLOW_BINDING_INVALID');
    return this.transaction(()=>{const old=this.db.prepare('SELECT id,binding FROM workflow_jobs WHERE dedupe=?').get(workflowDigest({owner,key:s.idempotencyKey}));if(old){if(old.binding!==binding)throw Error('WORKFLOW_IDEMPOTENCY_CONFLICT');return this.get(String(old.id))!;}
      this.db.prepare("INSERT INTO workflow_jobs VALUES(?,?,?,?,?,'QUEUED',0,?,NULL,NULL,0,?)").run(id,workflowDigest({owner,key:s.idempotencyKey}),binding,JSON.stringify(s.workflow),inputRef,s.runAt,workflowDigest(owner));
      s.workflow.steps.forEach((_step,i)=>this.db.prepare("INSERT INTO workflow_steps VALUES(?,?,'READY',0,0,NULL,NULL,?,NULL)").run(id,i,`${id}:${i}`));return this.get(id)!;});
  }
  get(id:string):WorkflowJob|undefined{const r=this.db.prepare('SELECT * FROM workflow_jobs WHERE id=?').get(id);return r?{id:String(r.id),workflow:WorkflowSchema.parse(JSON.parse(String(r.workflow_json))),inputRef:String(r.input_ref),status:r.status as JobStatus,cursor:Number(r.cursor),runAt:Number(r.run_at),lease:r.lease===null?null:String(r.lease),leaseUntil:r.lease_until===null?null:Number(r.lease_until),cancelRequested:r.cancel_requested===1,ownerHash:String(r.owner_hash)}:undefined;}
  list(limit=50){if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw Error('WORKFLOW_LIMIT_INVALID');return this.db.prepare('SELECT id FROM workflow_jobs ORDER BY rowid DESC LIMIT ?').all(limit).map(r=>this.get(String(r.id))!);}
  owned(owner:string,id:string){const job=this.get(id);if(!job||job.ownerHash!==workflowDigest(owner))throw Error('WORKFLOW_JOB_NOT_FOUND');return job;}
  listOwned(owner:string,limit=50){return this.db.prepare('SELECT id FROM workflow_jobs WHERE owner_hash=? ORDER BY rowid DESC LIMIT ?').all(workflowDigest(owner),limit).map(r=>this.get(String(r.id))!);}
  step(id:string,index:number):WorkflowStep{const r=this.db.prepare('SELECT * FROM workflow_steps WHERE job_id=? AND idx=?').get(id,index);if(!r)throw Error('WORKFLOW_STEP_MISSING');return {jobId:id,index,status:r.status as WorkflowStep['status'],attempts:Number(r.attempts),dispatched:r.dispatched===1,resultRef:r.result_ref===null?null:String(r.result_ref),dispatchRef:r.dispatch_ref===null?null:String(r.dispatch_ref),idempotencyKey:String(r.idem)};}
  claim(now:number,leaseMs:number):WorkflowJob|undefined{
    if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(leaseMs)||leaseMs<1000||leaseMs>3600000)throw Error('WORKFLOW_LEASE_INVALID');
    return this.transaction(()=>{
      for(const r of this.db.prepare("SELECT id,cursor FROM workflow_jobs WHERE status IN ('RUNNING','RECONCILING') AND lease_until<=?").all(now)){
        const s=this.step(String(r.id),Number(r.cursor)),state=s.dispatched?'UNKNOWN':'READY';
        this.db.prepare('UPDATE workflow_steps SET status=? WHERE job_id=? AND idx=?').run(state,r.id,r.cursor);
        this.db.prepare('UPDATE workflow_jobs SET status=?,lease=NULL,lease_until=NULL WHERE id=?').run(s.dispatched?'RECONCILING':'QUEUED',r.id);
      }
      const r=this.db.prepare("SELECT id FROM workflow_jobs WHERE status IN ('QUEUED','WAITING','RECONCILING') AND run_at<=? AND lease IS NULL ORDER BY run_at,rowid LIMIT 1").get(now);if(!r)return undefined;
      const job=this.get(String(r.id))!,step=this.step(job.id,job.cursor),token=randomUUID();
      this.db.prepare('UPDATE workflow_jobs SET status=?,lease=?,lease_until=? WHERE id=?').run(step.dispatched?'RECONCILING':'RUNNING',token,now+leaseMs,job.id);
      this.db.prepare("UPDATE workflow_steps SET status='RUNNING',attempts=attempts+? WHERE job_id=? AND idx=?").run(step.dispatched?0:1,job.id,job.cursor);return this.get(job.id)!;
    });
  }
  assertLease(job:WorkflowJob,now:number){const r=this.get(job.id);if(!r||r.lease!==job.lease||r.leaseUntil===null||r.leaseUntil<=now||!['RUNNING','RECONCILING'].includes(r.status))throw Error('WORKFLOW_LEASE_LOST');return r;}
  heartbeat(job:WorkflowJob,now:number,leaseMs:number){this.assertLease(job,now);this.db.prepare('UPDATE workflow_jobs SET lease_until=? WHERE id=? AND lease=?').run(now+leaseMs,job.id,job.lease);}
  markDispatch(job:WorkflowJob,now:number){this.transaction(()=>{const current=this.assertLease(job,now);if(current.cancelRequested)throw Error('WORKFLOW_CANCEL_REQUESTED');const s=this.step(job.id,job.cursor);if(s.dispatched)throw Error('WORKFLOW_ORIGINAL_DISPATCH_LOCKED');if(job.workflow.steps[job.cursor].effect!=='WRITE')throw Error('WORKFLOW_READ_STEP_CANNOT_DISPATCH');this.db.prepare('UPDATE workflow_steps SET dispatched=1,dispatch_token=? WHERE job_id=? AND idx=?').run(job.lease,job.id,job.cursor);});}
  saveDispatch(job:WorkflowJob,reference:string,_now:number){this.transaction(()=>{const r=this.db.prepare('SELECT dispatch_token,dispatch_ref,dispatched FROM workflow_steps WHERE job_id=? AND idx=?').get(job.id,job.cursor);if(!r||r.dispatched!==1||r.dispatch_token!==job.lease||r.dispatch_ref!==null&&r.dispatch_ref!==reference)throw Error('WORKFLOW_DISPATCH_RECORD_LOCKED');this.db.prepare('UPDATE workflow_steps SET dispatch_ref=? WHERE job_id=? AND idx=?').run(reference,job.id,job.cursor);});}
  complete(job:WorkflowJob,outputRef:string,now:number){this.transaction(()=>{const current=this.assertLease(job,now);this.db.prepare("UPDATE workflow_steps SET status='COMPLETE',result_ref=? WHERE job_id=? AND idx=?").run(outputRef,job.id,job.cursor);const next=job.cursor+1;this.db.prepare('UPDATE workflow_jobs SET cursor=?,status=?,run_at=?,lease=NULL,lease_until=NULL WHERE id=?').run(next,current.cancelRequested?'CANCELLED':next===job.workflow.steps.length?'SUCCEEDED':'QUEUED',now,job.id);this.event(job.id,'STEP_COMPLETE',now);});}
  suspend(job:WorkflowJob,status:'WAITING'|'RECONCILING'|'FAILED'|'ATTENTION',now:number,nextAt:number){this.transaction(()=>{this.assertLease(job,now);const s=status==='RECONCILING'?'UNKNOWN':status==='FAILED'?'FAILED':'WAITING';this.db.prepare('UPDATE workflow_steps SET status=? WHERE job_id=? AND idx=?').run(s,job.id,job.cursor);this.db.prepare('UPDATE workflow_jobs SET status=?,run_at=?,lease=NULL,lease_until=NULL WHERE id=?').run(status,nextAt,job.id);this.event(job.id,status,now);});}
  cancel(id:string,now:number){this.transaction(()=>{const job=this.get(id);if(!job||['SUCCEEDED','FAILED','CANCELLED'].includes(job.status))throw Error('WORKFLOW_CANNOT_CANCEL');const step=this.step(id,job.cursor);this.db.prepare('UPDATE workflow_jobs SET cancel_requested=1,status=?,lease=NULL,lease_until=NULL WHERE id=?').run(step.dispatched?'RECONCILING':'CANCELLED',id);this.event(id,step.dispatched?'CANCEL_PENDING_RECONCILIATION':'CANCELLED',now);});}
  private event(id:string,event:string,now:number){this.db.prepare('INSERT INTO workflow_events VALUES(?,?,?)').run(id,event,now);}
  close(){this.db.close();}
}
