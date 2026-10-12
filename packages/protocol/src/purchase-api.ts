import {z} from 'zod';
import {TaskPolicySchema,SignedQuoteSchema,DecisionReceiptSchema,address,digest} from './schemas.js';
import {EvidenceDocumentsSchema,EvidenceSaltSchema} from './review-evidence.js';
import {JevResponseSchema} from './jev-result.js';
import {DraftSchema} from './draft.js';
export {DraftSchema,ReviewRequestSchema} from './draft.js';
export type {Draft} from './draft.js';
export const ProposeRequestSchema=z.object({policy:TaskPolicySchema,taskText:z.string().min(1).max(16000),buyer:address,quoteRefs:z.array(digest).min(1).max(5),evidenceSalt:EvidenceSaltSchema.optional(),additionalEvidence:EvidenceDocumentsSchema.optional()}).strict().refine(r=>new Set(r.quoteRefs.map(x=>x.toLowerCase())).size===r.quoteRefs.length,'duplicate quote refs');
export const CatalogEntrySchema=z.object({quote:SignedQuoteSchema,documents:EvidenceDocumentsSchema}).strict();
export const CatalogResponseSchema=z.object({entries:z.array(CatalogEntrySchema).max(5)}).strict().refine(v=>new Set(v.entries.map(e=>e.quote.quoteId.toLowerCase())).size===v.entries.length,'duplicate quotes');
const code=z.string().regex(/^[A-Z0-9_]{1,80}$/);
export const ProposeResultSchema=z.discriminatedUnion('status',[DraftSchema,z.object({status:z.literal('REJECT'),code}).strict(),z.object({status:z.literal('ABSTAIN'),code}).strict()]);
const ReviewBaseSchema=z.object({decision:z.enum(['PASS','REJECT','ABSTAIN']),source:z.literal('JEV'),modelId:z.string().min(1).max(128),questionConfigHash:digest,answers:JevResponseSchema.shape.answers,usage:JevResponseSchema.shape.usage,executable:z.literal(false),code:code.optional()}).strict();
export const ReviewResultSchema=z.union([
  z.object({decision:z.literal('REJECT'),source:z.literal('HARD_RULE'),code}).strict(),
  z.object({decision:z.literal('ABSTAIN'),source:z.literal('DEPENDENCY'),code}).strict(),
  ReviewBaseSchema,
  ReviewBaseSchema.extend({decision:z.literal('PASS'),executable:z.literal(true),receipt:DecisionReceiptSchema}).strict(),
]);
