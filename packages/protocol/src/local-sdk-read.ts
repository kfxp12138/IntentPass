import {z} from 'zod';
import {address,digest} from './schemas.js';
import {OrderSnapshotSchema} from './escrow-read.js';
import {WorkflowIdSchema} from './workflow-api.js';
export const LocalSdkReadRequestSchema=z.object({orderId:digest}).strict();
/** Only the local parent sends this through stdin; never a public response. */
export const LocalSdkSessionInputSchema=z.object({orderId:digest,token:z.string().min(1).max(16384).regex(/^\S+$/),expectedSubject:z.string().min(1).max(512)}).strict();
export const LocalSdkWorkflowRequestSchema=z.object({jobId:WorkflowIdSchema,orderId:digest}).strict();
export const LocalSdkWorkflowSessionSchema=LocalSdkSessionInputSchema.extend({jobId:WorkflowIdSchema}).strict();
export const LocalSdkReadResultSchema=z.object({schemaVersion:z.literal(1),status:z.literal('AUTHENTICATED_ORDER_READ'),scope:z.literal('INDEPENDENT_NODE_SDK_SESSION_AND_ORDER_READ_NOT_FULL_PURCHASE_ACCEPTANCE'),
  walletAddresses:z.array(address).min(1).max(128),order:OrderSnapshotSchema,sessionVerifiedBeforeAfter:z.literal(true),canExecute:z.literal(false),signaturesRequested:z.literal(0),transactionsSent:z.literal(0)}).strict().superRefine((r,c)=>{
    if(!r.walletAddresses.some(w=>[r.order.buyer,r.order.seller,r.order.payee].some(a=>a.toLowerCase()===w.toLowerCase())))c.addIssue({code:'custom',message:'SDK_ORDER_ACCESS_MISMATCH'});
  });
export const LocalTaskContextSchema=z.object({status:z.literal('CONFIGURED_CONTEXT'),chainId:z.literal('10143'),buyer:address,seller:address,asset:address,arbiter:address,configurationOnly:z.literal(true)}).strict();
export const LocalSdkWorkflowResultSchema=z.object({schemaVersion:z.literal(1),status:z.literal('AUTHENTICATED_WORKFLOW_ORDER_READ'),scope:z.literal('INDEPENDENT_NODE_SDK_COMPLETED_WORKFLOW_AND_CHAIN_READ_NOT_NEW_PURCHASE_ACCEPTANCE'),jobId:WorkflowIdSchema,workflowStatus:z.literal('SUCCEEDED'),recordedPayoutHash:digest,walletAddresses:z.array(address).min(1).max(128),order:OrderSnapshotSchema,sessionVerifiedBeforeAfter:z.literal(true),canExecute:z.literal(false),signaturesRequested:z.literal(0),transactionsSent:z.literal(0)}).strict().superRefine((r,c)=>{
  if(r.order.state!=='ALLOCATED_PAID'||r.order.credits.payee!=='0'||r.order.withdrawn.payee!==r.order.price||!r.walletAddresses.some(w=>w.toLowerCase()===r.order.buyer.toLowerCase()))c.addIssue({code:'custom',message:'SDK_WORKFLOW_PAYMENT_MISMATCH'});
});
