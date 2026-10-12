import {z} from 'zod';
import {uint} from './schemas.js';
import {ReviewRequestSchema,ReviewResultSchema} from './purchase-api.js';
import {AuthorizationPayloadSchema} from '../../capsule/src/format.js';
export const OrderPrepareRequestSchema=z.object({request:ReviewRequestSchema,review:ReviewResultSchema,nonce:uint,deadline:uint}).strict();
export const OrderPreparedSchema=z.object({payload:AuthorizationPayloadSchema.omit({ownerSignature:true}),chainStatusChecked:z.literal(false),canSubmitPayment:z.literal(false)}).strict();
export const OrderPrepareResponseSchema=z.union([OrderPreparedSchema,z.object({status:z.literal('REJECT'),code:z.enum(['INPUT_INVALID','OWNER_MISMATCH','PREPARATION_BLOCKED'])}).strict()]);
