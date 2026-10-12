import {z} from 'zod';
import {TaskPolicySchema,SignedQuoteSchema,IntentEnvelopeSchema} from './schemas.js';
import {EvidenceBundleSchema} from './review-evidence.js';
// Pure protocol schemas; do not import a provider adapter into the public index.
export const ReviewRequestSchema=z.object({policy:TaskPolicySchema,intent:IntentEnvelopeSchema,quote:SignedQuoteSchema,evidence:EvidenceBundleSchema}).strict();
export const DraftSchema=ReviewRequestSchema.extend({status:z.literal('DRAFT'),modelId:z.string().min(1).max(128),citations:z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).max(12)}).strict();
export type Draft=z.infer<typeof DraftSchema>;
