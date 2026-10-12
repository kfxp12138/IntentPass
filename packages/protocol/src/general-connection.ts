import {z} from 'zod';
import {address,positiveUint} from './schemas.js';
import {ProviderIdSchema} from './day4-origin-types.js';
const hash=z.string().regex(/^[a-f0-9]{64}$/);
export const GeneralConnectionRoleSchema=z.enum(['buyer','seller']);
export const GeneralConnectionPlanSchema=z.object({version:z.literal(1),planId:z.uuid(),profileHash:hash,mode:z.literal('general'),chainId:z.literal('10143'),asset:address,arbiter:address,
  amountLimit:positiveUint.nullable(),expiresAt:positiveUint.nullable(),
  roles:z.tuple([z.object({role:z.literal('buyer'),address,walletId:ProviderIdSchema,signerId:ProviderIdSchema,policyId:ProviderIdSchema}).strict(),z.object({role:z.literal('seller'),address,walletId:ProviderIdSchema,signerId:ProviderIdSchema,policyId:ProviderIdSchema}).strict()])}).strict();
export const GeneralConnectionRequestSchema=z.object({planId:z.uuid(),profileHash:hash,role:GeneralConnectionRoleSchema}).strict();
export const GeneralConnectionConsentSchema=GeneralConnectionRequestSchema.extend({confirmGeneralAuthority:z.literal(true),localPlaintextProcessingApproved:z.literal(true)}).strict();
export type GeneralConnectionPlan=z.infer<typeof GeneralConnectionPlanSchema>;
