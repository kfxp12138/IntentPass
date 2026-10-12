import {z} from 'zod';

// Public wire format; usable by an independent client without DOM or Node APIs.
export const JsonValueSchema=z.json();
const name=z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/);
export const WorkflowSchema=z.object({name:z.string().min(1).max(128),version:z.string().min(1).max(128),steps:z.array(z.object({id:name,handler:name,handlerVersion:z.string().min(1).max(128).default('1'),effect:z.enum(['READ','WRITE']),maxAttempts:z.number().int().min(1).max(100).default(3),retryDelayMs:z.number().int().min(0).max(86400000).default(1000)}).strict()).min(1).max(1000)}).strict().superRefine((w,c)=>{if(new Set(w.steps.map(s=>s.id)).size!==w.steps.length)c.addIssue({code:'custom',message:'WORKFLOW_STEP_ID_DUPLICATE'});});
export type Workflow=z.infer<typeof WorkflowSchema>;
export type JsonValue=z.infer<typeof JsonValueSchema>;
export const WorkflowSubmissionSchema=z.object({idempotencyKey:z.string().min(1).max(256),workflow:WorkflowSchema,input:JsonValueSchema,runAt:z.number().int().nonnegative().default(0)}).strict();
export const WorkflowStatusSchema=z.enum(['QUEUED','RUNNING','WAITING','RECONCILING','SUCCEEDED','FAILED','ATTENTION','CANCELLED']);
export const WorkflowIdSchema=z.string().regex(/^[-a-zA-Z0-9_.]{1,128}$/);
export const WorkflowStateSchema=z.object({id:WorkflowIdSchema,status:WorkflowStatusSchema}).strict();
export const WorkflowOutputSchema=WorkflowStateSchema.extend({outputs:z.record(z.string().min(1).max(128),JsonValueSchema)}).strict();
const job=WorkflowStateSchema.extend({workflow:z.string().min(1).max(128),step:z.number().int().nonnegative(),stepCount:z.number().int().positive().max(1000),cancelRequested:z.boolean()}).strict().refine(j=>j.step<=j.stepCount&&(!(j.status==='SUCCEEDED')||j.step===j.stepCount));
export const WorkflowListSchema=z.object({mode:z.literal('general'),workerRunning:z.boolean(),limits:z.object({jobCount:z.null(),amountPerOrder:z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),expiresAt:z.string().regex(/^(0|[1-9][0-9]*)$/).nullable()}).strict(),financialConfigurationPresent:z.boolean(),jobs:z.array(job).max(1000)}).strict().refine(v=>new Set(v.jobs.map(j=>j.id)).size===v.jobs.length);
export const WorkflowSubmitRequestSchema=z.object({submission:WorkflowSubmissionSchema,confirm:z.boolean().optional()}).strict().superRefine((r,c)=>{
  if(r.submission.workflow.steps.some(s=>s.effect==='WRITE')&&r.confirm!==true)c.addIssue({code:'custom',message:'WORKFLOW_CONFIRMATION_REQUIRED'});
});
