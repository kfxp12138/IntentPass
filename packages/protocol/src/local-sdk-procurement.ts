import {z} from 'zod';
import {MemoryPayloadSchema,TaskInputSchema} from '../../capsule/src/format.js';
import {CatalogResponseSchema} from './purchase-api.js';
import {WorkflowIdSchema,WorkflowStatusSchema,WorkflowSubmissionSchema} from './workflow-api.js';
import {address,digest} from './schemas.js';
export const LocalSdkProcurementRequestSchema=z.object({memory:MemoryPayloadSchema.extend({taskInput:TaskInputSchema}),catalogue:CatalogResponseSchema.optional(),confirm:z.literal(true)}).strict();
export const LocalSdkProcurementSessionSchema=LocalSdkProcurementRequestSchema.extend({token:z.string().min(1).max(16384).regex(/^\S+$/),expectedSubject:z.string().min(1).max(512)}).strict();
export const LocalSdkProcurementReceiptSchema=z.object({status:z.literal('WORKFLOW_SUBMISSION_RECORDED'),jobId:WorkflowIdSchema,jobStatus:WorkflowStatusSchema,taskId:digest,walletAddresses:z.array(address).min(1).max(128),sessionVerifiedBeforeAfter:z.literal(true),paymentVerified:z.literal(false)}).strict();
export function sdkProcurementSubmission(input:unknown){
  const r=LocalSdkProcurementRequestSchema.parse(input);
  return WorkflowSubmissionSchema.parse({idempotencyKey:`sdk-procurement:${r.memory.policy.taskId.toLowerCase()}:${r.memory.policy.version}`,workflow:{name:'SDK 自动采购与结算',version:'1',steps:[{id:'procurement',handler:'intentpass.procurement',effect:'WRITE',retryDelayMs:15000}]},input:r.catalogue?{memory:r.memory,catalogue:r.catalogue}:r.memory,runAt:0});
}
