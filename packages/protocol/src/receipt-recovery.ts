import {z} from 'zod';
import {ReviewRequestSchema,ReviewResultSchema} from './purchase-api.js';
import {DecisionReceiptSchema,digest,IntentEnvelopeSchema,uint} from './schemas.js';
export const ReceiptRecoveryRequestSchema=z.object({request:ReviewRequestSchema,confirmation:z.boolean(),previousReceiptHash:digest.optional(),reschedule:z.boolean().optional()}).strict().refine(v=>(!v.confirmation||!!v.previousReceiptHash)&&(!v.reschedule||v.confirmation),'confirmation and previous receipt required');
export const RecordedPassSchema=ReviewResultSchema.options[2].extend({decision:z.literal('PASS'),code:z.never().optional()});
export const ReceiptRecoveryResponseSchema=z.union([
  z.object({status:z.literal('SIGNED'),evaluation:RecordedPassSchema,originalReceipt:DecisionReceiptSchema,reviewStartedAt:uint,reviewFinishedAt:uint,receipt:DecisionReceiptSchema,receiptHash:digest,canReschedule:z.literal(true).optional()}).strict(),
  z.object({status:z.enum(['BLOCKED','PENDING','UNKNOWN']),code:z.string().regex(/^[A-Z0-9_]{1,80}$/)}).strict(),
]);
/** Public committed header only; never contains data, evidence salt or credentials. */
export const OriginalCandidateSchema=z.object({format:z.literal('IntentPass.OriginalCandidate.v1'),intent:IntentEnvelopeSchema,quoteId:digest}).strict();
